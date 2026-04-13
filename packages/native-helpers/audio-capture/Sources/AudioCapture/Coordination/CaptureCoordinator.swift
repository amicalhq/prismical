import Foundation

// Top-level mode switch for mic-only, system-only, and dual-stream capture binaries.

final class CaptureCoordinator {
    private let traceWriter: CaptureTraceWriter?
    private let writer: PacketWriter
    private let mode: CaptureMode
    private let debugArtifactsDirectory: String?
    private let aecRenderHoldbackMs: Int
    private let aecRenderWaitTimeoutMs: Int
    private var microphoneCapture: MicrophoneCapture?
    private var systemAudioCapture: SystemAudioCapture?
    private var dualModeCapture: DualModeCapture?

    init(
        mode: CaptureMode,
        debugArtifactsDirectory: String?,
        aecRenderHoldbackMs: Int = NativeTimedDualAecSession.defaultMicrophoneHoldbackMs,
        aecRenderWaitTimeoutMs: Int? = nil
    ) {
        self.traceWriter =
            debugArtifactsDirectory.flatMap { CaptureTraceWriter(directoryPath: "\($0)/trace") }
        self.writer = PacketWriter(traceWriter: self.traceWriter)
        self.mode = mode
        self.debugArtifactsDirectory = debugArtifactsDirectory
        self.aecRenderHoldbackMs = max(0, aecRenderHoldbackMs)
        self.aecRenderWaitTimeoutMs = max(0, aecRenderWaitTimeoutMs ?? aecRenderHoldbackMs)
    }

    func start() async throws {
        if mode == .dual {
            let dualModeCapture = DualModeCapture(
                writer: writer,
                debugArtifactsDirectory: debugArtifactsDirectory,
                aecRenderHoldbackMs: aecRenderHoldbackMs,
                aecRenderWaitTimeoutMs: aecRenderWaitTimeoutMs,
                traceWriter: traceWriter
            )
            try await dualModeCapture.start()
            self.dualModeCapture = dualModeCapture
            return
        }

        if mode == .mic {
            let sampleClock = SharedAudioSampleClock()
            let tracker = SourceSamplePositionTracker(clock: sampleClock)
            let microphoneCapture = MicrophoneCapture(traceWriter: traceWriter) { [writer, traceWriter] samples, hostTime in
                let startSampleIndex = tracker.resolveStartSampleIndex(
                    hostTime: hostTime,
                    sampleCount: samples.count
                )
                traceWriter?.record(
                    event: "microphone_tracker_resolve",
                    metadata: nonNilTraceFields([
                        ("hostTime", hostTime.map(Int64.init)),
                        ("startSampleIndex", startSampleIndex),
                        ("sampleCount", samples.count)
                    ])
                )
                writer.write(
                    source: .micRaw,
                    samples: samples,
                    timestampMs: timestampMs(forSampleIndex: startSampleIndex),
                    sampleStartIndex: startSampleIndex
                )
            }
            try microphoneCapture.start()
            self.microphoneCapture = microphoneCapture
        }

        if mode == .system {
            let sampleClock = SharedAudioSampleClock()
            let tracker = SourceSamplePositionTracker(clock: sampleClock)
            let systemAudioCapture = SystemAudioCapture(
                debugArtifactsDirectory: debugArtifactsDirectory,
                traceWriter: traceWriter
            ) { [writer, traceWriter] samples, hostTime in
                let startSampleIndex = tracker.resolveStartSampleIndex(
                    hostTime: hostTime,
                    sampleCount: samples.count
                )
                traceWriter?.record(
                    event: "system_tracker_resolve",
                    metadata: nonNilTraceFields([
                        ("hostTime", hostTime.map(Int64.init)),
                        ("startSampleIndex", startSampleIndex),
                        ("sampleCount", samples.count)
                    ])
                )
                writer.write(
                    source: .system,
                    samples: samples,
                    timestampMs: timestampMs(forSampleIndex: startSampleIndex),
                    sampleStartIndex: startSampleIndex
                )
            }
            try await systemAudioCapture.start()
            self.systemAudioCapture = systemAudioCapture
        }
    }

    func stop() async {
        await dualModeCapture?.stop()
        microphoneCapture?.stop()
        await systemAudioCapture?.stop()
        try? traceWriter?.close()
    }
}
