import Foundation

// Converts sparse tracked render/mic chunks into a shared 10 ms AEC processing timeline.

struct AudioSegment {
    let startSampleIndex: Int64
    var samples: [Float]

    var endSampleIndex: Int64 {
        startSampleIndex + Int64(samples.count)
    }
}

struct NativeTimedSessionOutputChunk {
    let source: CaptureSource
    let startSampleIndex: Int64
    let samples: [Float]
}

struct MicrophoneFrameWaitRun {
    let throughSampleIndexExclusive: Int64
    let deadlineNs: UInt64
}

final class NativeTimedDualAecSession {
    static let defaultMicrophoneHoldbackMs = 300
    static let defaultRenderWaitTimeoutMs = 300

    let frameSampleCount: Int
    let traceWriter: CaptureTraceWriter?
    let microphoneHoldbackMs: Int
    let microphoneHoldbackSamples: Int64
    let renderWaitTimeoutMs: Int
    let renderWaitTimeoutNs: UInt64
    let renderRetentionSamples = Int64(FixedFrameAecProcessor.sampleRate * 5)
    let aecProcessor = FixedFrameAecProcessor()
    var microphoneSegments: [AudioSegment] = []
    var renderSegments: [AudioSegment] = []
    var pendingSystemPacketSamples: [Float] = []
    var microphoneFrameWaitRuns: [MicrophoneFrameWaitRun] = []
    var timelineStartSampleIndex: Int64?
    var nextMicrophoneFrameStart: Int64?
    var nextSystemPacketFrameStart: Int64?
    var nextExpectedSystemPacketInputSampleIndex: Int64?
    var latestMicrophoneSampleIndex: Int64 = 0
    var latestRenderSampleIndex: Int64 = 0

    init(
        sampleRate: Int = FixedFrameAecProcessor.sampleRate,
        channels: Int = 1,
        microphoneHoldbackMs: Int = defaultMicrophoneHoldbackMs,
        renderWaitTimeoutMs: Int? = nil,
        traceWriter: CaptureTraceWriter? = nil
    ) {
        self.frameSampleCount = max(1, (sampleRate / 100) * channels)
        self.traceWriter = traceWriter
        self.microphoneHoldbackMs = max(0, microphoneHoldbackMs)
        self.microphoneHoldbackSamples =
            (Int64(sampleRate) * Int64(channels) * Int64(self.microphoneHoldbackMs)) / 1000
        self.renderWaitTimeoutMs = max(0, renderWaitTimeoutMs ?? microphoneHoldbackMs)
        self.renderWaitTimeoutNs = UInt64(self.renderWaitTimeoutMs) * 1_000_000
    }

    var aecModeDescription: String {
        aecProcessor.isReal ? "webrtc-aec3" : "pass-through-bridge"
    }

    var microphoneHoldbackDescription: String {
        "\(microphoneHoldbackMs)ms"
    }

    var renderWaitTimeoutDescription: String {
        "\(renderWaitTimeoutMs)ms"
    }

    // Buffer incoming microphone samples and drain any frames that are now safe to process.
    func ingestMicrophone(_ chunk: TimedAudioChunk) -> [NativeTimedSessionOutputChunk] {
        guard !chunk.samples.isEmpty else { return [] }

        traceWriter?.recordSamples(
            event: "timed_session_ingest_microphone",
            channel: "timed-session-mic-ingest",
            samples: chunk.samples,
            metadata: [
                "startSampleIndex": chunk.startSampleIndex,
                "rawStartSampleIndex": chunk.rawStartSampleIndex,
                "sampleCount": chunk.samples.count,
            ]
        )

        appendSegment(
            AudioSegment(startSampleIndex: chunk.startSampleIndex, samples: chunk.samples),
            to: &microphoneSegments
        )
        if timelineStartSampleIndex == nil {
            timelineStartSampleIndex = chunk.startSampleIndex
        }
        latestMicrophoneSampleIndex = max(
            latestMicrophoneSampleIndex,
            chunk.startSampleIndex + Int64(chunk.samples.count)
        )
        if nextMicrophoneFrameStart == nil {
            nextMicrophoneFrameStart = microphoneSegments.first?.startSampleIndex
        }
        let nowUptimeNs = DispatchTime.now().uptimeNanoseconds
        registerMicrophoneFrameWaitDeadlines(nowUptimeNs: nowUptimeNs)

        var outputs: [NativeTimedSessionOutputChunk] = []
        let drainBoundary = microphoneDrainBoundary(flushing: false, nowUptimeNs: nowUptimeNs)
        if drainBoundary > 0 {
            drainMicrophoneFrames(through: drainBoundary, flushing: false, outputs: &outputs)
        }
        return outputs
    }

    // Buffer incoming system/render samples, drain system packets, and process mic frames if holdback allows.
    func ingestSystem(_ chunk: TimedAudioChunk) -> [NativeTimedSessionOutputChunk] {
        guard !chunk.samples.isEmpty else { return [] }

        traceWriter?.recordSamples(
            event: "timed_session_ingest_render",
            channel: "timed-session-system-ingest",
            samples: chunk.samples,
            metadata: [
                "startSampleIndex": chunk.startSampleIndex,
                "rawStartSampleIndex": chunk.rawStartSampleIndex,
                "sampleCount": chunk.samples.count,
            ]
        )

        appendSegment(
            AudioSegment(startSampleIndex: chunk.startSampleIndex, samples: chunk.samples),
            to: &renderSegments
        )
        if let timelineStartSampleIndex {
            self.timelineStartSampleIndex = min(timelineStartSampleIndex, chunk.startSampleIndex)
        } else {
            timelineStartSampleIndex = chunk.startSampleIndex
        }
        appendSystemPacketSamples(from: chunk)
        latestRenderSampleIndex = max(
            latestRenderSampleIndex,
            chunk.startSampleIndex + Int64(chunk.samples.count)
        )

        var outputs: [NativeTimedSessionOutputChunk] = []
        drainSystemPackets(through: latestRenderSampleIndex, outputs: &outputs)
        let drainBoundary = microphoneDrainBoundary(
            flushing: false,
            nowUptimeNs: DispatchTime.now().uptimeNanoseconds
        )
        if drainBoundary > 0 {
            drainMicrophoneFrames(through: drainBoundary, flushing: false, outputs: &outputs)
        }
        pruneRenderSegments()
        return outputs
    }

    // Flush all remaining buffered mic and system frames at end-of-session.
    func finish() -> [NativeTimedSessionOutputChunk] {
        let finalSampleBoundary = max(latestMicrophoneSampleIndex, latestRenderSampleIndex)
        guard finalSampleBoundary > 0 else { return [] }

        let roundedBoundary =
            ((finalSampleBoundary + Int64(frameSampleCount) - 1) / Int64(frameSampleCount))
            * Int64(frameSampleCount)

        var outputs: [NativeTimedSessionOutputChunk] = []
        drainSystemPackets(through: roundedBoundary, outputs: &outputs)
        drainMicrophoneFrames(through: roundedBoundary, flushing: true, outputs: &outputs)
        return outputs
    }

    // Discard all buffered audio and reset the AEC3 adaptive filter to a clean state.
    func reset() {
        microphoneSegments.removeAll(keepingCapacity: false)
        renderSegments.removeAll(keepingCapacity: false)
        pendingSystemPacketSamples.removeAll(keepingCapacity: false)
        microphoneFrameWaitRuns.removeAll(keepingCapacity: false)
        timelineStartSampleIndex = nil
        nextMicrophoneFrameStart = nil
        nextSystemPacketFrameStart = nil
        nextExpectedSystemPacketInputSampleIndex = nil
        latestMicrophoneSampleIndex = 0
        latestRenderSampleIndex = 0
        aecProcessor.reset()
    }

    // Compute how far mic frames can safely advance — limited by render availability minus holdback.
    func microphoneDrainBoundary(flushing: Bool, nowUptimeNs: UInt64) -> Int64 {
        if flushing {
            return latestMicrophoneSampleIndex
        }

        let renderReadySampleIndex = latestRenderSampleIndex - microphoneHoldbackSamples
        let renderLimitedBoundary =
            renderReadySampleIndex > 0
            ? max(0, min(latestMicrophoneSampleIndex, renderReadySampleIndex))
            : 0

        return max(renderLimitedBoundary, timedOutMicrophoneDrainBoundary(nowUptimeNs: nowUptimeNs))
    }

    // Record one timeout run for any newly ready mic frames instead of tracking each frame individually.
    func registerMicrophoneFrameWaitDeadlines(nowUptimeNs: UInt64) {
        guard let nextMicrophoneFrameStart else { return }

        let frameStride = Int64(frameSampleCount)
        let queuedBoundary = max(
            nextMicrophoneFrameStart,
            microphoneFrameWaitRuns.last?.throughSampleIndexExclusive ?? nextMicrophoneFrameStart
        )

        var readyBoundary = nextMicrophoneFrameStart
        while readyBoundary + frameStride <= latestMicrophoneSampleIndex {
            readyBoundary += frameStride
        }

        guard readyBoundary > queuedBoundary else { return }
        microphoneFrameWaitRuns.append(
            MicrophoneFrameWaitRun(
                throughSampleIndexExclusive: readyBoundary,
                deadlineNs: nowUptimeNs + renderWaitTimeoutNs
            )
        )
    }

    // Drop timeout runs that are fully behind the drained mic cursor.
    func pruneMicrophoneFrameWaitRuns(before sampleIndex: Int64) {
        while let firstRun = microphoneFrameWaitRuns.first,
            firstRun.throughSampleIndexExclusive <= sampleIndex
        {
            microphoneFrameWaitRuns.removeFirst()
        }
    }

    // Allow overdue mic frames to drain even if render has not advanced far enough yet.
    func timedOutMicrophoneDrainBoundary(nowUptimeNs: UInt64) -> Int64 {
        guard nextMicrophoneFrameStart != nil else { return 0 }

        var timedOutBoundary: Int64 = 0

        for run in microphoneFrameWaitRuns {
            if run.deadlineNs > nowUptimeNs {
                break
            }

            timedOutBoundary = max(timedOutBoundary, run.throughSampleIndexExclusive)
        }

        return timedOutBoundary
    }
}
