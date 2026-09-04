import Foundation

// Keeps mic-only output on the session clock and fills device gaps before packets reach stdout.
final class MicOnlyTimelineWriter {
    private static let maximumSilenceDebtSamples = Int64(FixedFrameAecProcessor.sampleRate * 20)
    private static let maximumSilencePacketSamples = FixedFrameAecProcessor.sampleRate

    private let clock: SharedAudioSampleClock
    private let writer: PacketWriter
    private let traceWriter: CaptureTraceWriter?
    private let onTimelineJump: (Int) -> Void
    private var cursor: Int64 = 0

    init(
        anchorHostTime: UInt64,
        writer: PacketWriter,
        traceWriter: CaptureTraceWriter?,
        onTimelineJump: @escaping (Int) -> Void
    ) {
        self.clock = SharedAudioSampleClock(anchorHostTime: anchorHostTime)
        self.writer = writer
        self.traceWriter = traceWriter
        self.onTimelineJump = onTimelineJump
    }

    func handleSilenceTick(hostTime: UInt64) {
        emitSilence(through: clock.sampleIndex(forHostTime: hostTime))
    }

    func handleSamples(_ samples: [Float], hostTime: UInt64?) -> Int {
        guard !samples.isEmpty else { return 0 }

        let rawStart = clock.sampleIndex(forHostTime: hostTime ?? mach_absolute_time())
        if rawStart > cursor {
            emitSilence(through: rawStart)
        }

        let overlap = max(0, Int(cursor - rawStart))
        guard overlap < samples.count else { return samples.count }
        let outputSamples = overlap == 0 ? samples : Array(samples.dropFirst(overlap))
        let startSampleIndex = rawStart + Int64(overlap)
        write(samples: outputSamples, startSampleIndex: startSampleIndex)
        cursor = startSampleIndex + Int64(outputSamples.count)
        return overlap
    }

    private func emitSilence(through targetSampleIndex: Int64) {
        let owed = targetSampleIndex - cursor
        guard owed >= Int64(FixedFrameAecProcessor.frameSize) else { return }

        if owed > Self.maximumSilenceDebtSamples {
            cursor = targetSampleIndex
            onTimelineJump(Int((owed * 1000) / Int64(FixedFrameAecProcessor.sampleRate)))
            return
        }

        while cursor < targetSampleIndex {
            let sampleCount = min(
                Self.maximumSilencePacketSamples,
                Int(targetSampleIndex - cursor)
            )
            write(
                samples: Array(repeating: .zero, count: sampleCount),
                startSampleIndex: cursor
            )
            cursor += Int64(sampleCount)
        }
    }

    private func write(samples: [Float], startSampleIndex: Int64) {
        traceWriter?.record(
            event: "microphone_timeline_write",
            metadata: [
                "startSampleIndex": startSampleIndex,
                "sampleCount": samples.count,
            ]
        )
        writer.write(
            source: .micRaw,
            samples: samples,
            timestampMs: timestampMs(forSampleIndex: startSampleIndex),
            sampleStartIndex: startSampleIndex
        )
    }
}
