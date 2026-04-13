import AVFoundation
import Foundation

// Normalizes the chosen callback buffer into mono 48 kHz samples and optional debug artifacts.

extension SystemAudioCapture {
    // Convert the chosen callback buffer into mono 48 kHz samples before handing it to the session layer.
    func process(
        _ copiedBufferList: CopiedAudioBufferList,
        format: AVAudioFormat,
        sourceSampleRate: Double,
        selectedSource: String,
        traceChannelBase: String,
        callbackSequence: UInt64,
        hostTime: UInt64?,
        onSamples: @escaping NormalizedSampleHandler,
        preResampleDebugWriter: DebugWavWriter? = nil,
        postResampleDebugWriter: DebugWavWriter? = nil
    ) {
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(copiedBufferList.pointer)
        guard let firstBuffer = sourceBuffers.first else { return }
        guard let baseCommonFormat = commonFormat(from: format.streamDescription.pointee) else {
            Logger.error(CaptureError.unsupportedSystemAudioBuffer.localizedDescription)
            return
        }

        let isInterleaved = format.isInterleaved
        let callbackChannelCount = AVAudioChannelCount(
            max(1, Int(isInterleaved ? firstBuffer.mNumberChannels : format.channelCount))
        )
        let monoSamples = extractMonoSamples(
            from: sourceBuffers,
            commonFormat: baseCommonFormat,
            channelCount: Int(callbackChannelCount),
            interleaved: isInterleaved
        )

        guard let monoSamples else {
            Logger.error(
                "System audio sample extraction failed: selected=\(selectedSource) sampleRate=\(Int(format.sampleRate)) channels=\(callbackChannelCount) interleaved=\(isInterleaved) commonFormat=\(commonFormatName(baseCommonFormat))"
            )
            return
        }

        let resampledSamples = resampleLinear(
            samples: monoSamples,
            from: sourceSampleRate,
            to: targetFormat.sampleRate
        )

        traceWriter?.recordSamples(
            event: "\(traceChannelBase)_pre_resample",
            channel: "\(traceChannelBase)-pre-resample",
            samples: monoSamples,
            metadata: nonNilTraceFields([
                ("callbackSequence", Int64(callbackSequence)),
                ("selectedSource", selectedSource),
                ("hostTime", hostTime.map(Int64.init)),
                ("sourceSampleRate", sourceSampleRate),
                ("formatSampleRate", format.sampleRate),
                ("formatChannelCount", Int(format.channelCount)),
                ("formatInterleaved", format.isInterleaved),
                ("callbackChannelCount", Int(callbackChannelCount)),
                ("commonFormat", commonFormatName(baseCommonFormat)),
                ("sampleCount", monoSamples.count)
            ])
        )
        traceWriter?.recordSamples(
            event: "\(traceChannelBase)_post_resample",
            channel: "\(traceChannelBase)-post-resample",
            samples: resampledSamples,
            metadata: nonNilTraceFields([
                ("callbackSequence", Int64(callbackSequence)),
                ("selectedSource", selectedSource),
                ("hostTime", hostTime.map(Int64.init)),
                ("sourceSampleRate", sourceSampleRate),
                ("outputSampleRate", targetFormat.sampleRate),
                ("sampleCount", resampledSamples.count)
            ])
        )

        do {
            try appendTimedDebugSamples(
                monoSamples,
                hostTime: hostTime,
                tracker: preResampleDebugTracker,
                writer: preResampleDebugWriter,
                endSampleIndex: &preResampleDebugEndSampleIndex
            )
            try appendTimedDebugSamples(
                resampledSamples,
                hostTime: hostTime,
                tracker: postResampleDebugTracker,
                writer: postResampleDebugWriter,
                endSampleIndex: &postResampleDebugEndSampleIndex
            )
        } catch {
            Logger.error("Failed to write debug audio files: \(error.localizedDescription)")
        }

        let resolvedHostTime = (hostTime ?? 0) > 0 ? hostTime : nil
        onSamples(resampledSamples, resolvedHostTime)
    }

    func appendTimedDebugSamples(
        _ samples: [Float],
        hostTime: UInt64?,
        tracker: SourceSamplePositionTracker?,
        writer: DebugWavWriter?,
        endSampleIndex: inout Int64
    ) throws {
        guard !samples.isEmpty else { return }
        guard let tracker, let writer else { return }

        let startSampleIndex = tracker.resolveStartSampleIndex(
            hostTime: hostTime,
            sampleCount: samples.count
        )
        let gapSamples = max(0, Int(startSampleIndex - endSampleIndex))
        if gapSamples > 0 {
            try writer.appendSilence(sampleCount: gapSamples)
        }
        try writer.append(samples: samples)
        endSampleIndex = startSampleIndex + Int64(samples.count)
    }

    func appendDebugSilenceUntilStop(hostTime: UInt64) throws {
        try appendTimedDebugStopSilence(
            hostTime: hostTime,
            tracker: preResampleDebugTracker,
            writer: preResampleDebugWriter,
            endSampleIndex: &preResampleDebugEndSampleIndex
        )
        try appendTimedDebugStopSilence(
            hostTime: hostTime,
            tracker: postResampleDebugTracker,
            writer: postResampleDebugWriter,
            endSampleIndex: &postResampleDebugEndSampleIndex
        )
    }

    func appendTimedDebugStopSilence(
        hostTime: UInt64,
        tracker: SourceSamplePositionTracker?,
        writer: DebugWavWriter?,
        endSampleIndex: inout Int64
    ) throws {
        guard let tracker, let writer else { return }
        let stopSampleIndex = tracker.resolveStartSampleIndex(hostTime: hostTime, sampleCount: 0)
        let trailingSilenceSamples = max(0, Int(stopSampleIndex - endSampleIndex))
        if trailingSilenceSamples > 0 {
            try writer.appendSilence(sampleCount: trailingSilenceSamples)
            endSampleIndex = stopSampleIndex
        }
    }
}
