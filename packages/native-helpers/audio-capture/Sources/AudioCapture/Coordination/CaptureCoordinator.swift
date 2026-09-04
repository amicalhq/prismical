import Foundation

// Top-level mode switch for mic-only, system-only, and dual-stream capture binaries.

final class CaptureCoordinator {
    private let traceWriter: CaptureTraceWriter?
    private let writer: PacketWriter
    private let mode: CaptureMode
    private let debugArtifactsDirectory: String?
    private let aecRenderHoldbackMs: Int
    private let aecRenderWaitTimeoutMs: Int
    private let initialMicrophoneBinding: InitialMicrophoneBinding
    private let commandLock = NSLock()
    private var pendingMicrophoneCommand: MicrophoneCommand?
    private var microphoneBindingController: MicBindingController?
    private var microphoneTimelineWriter: MicOnlyTimelineWriter?
    private var systemAudioCapture: SystemAudioCapture?
    private var dualModeCapture: DualModeCapture?

    private enum MicrophoneCommand {
        case set(uid: String, revision: Int)
        case followDefault(revision: Int)
    }

    init(
        mode: CaptureMode,
        debugArtifactsDirectory: String?,
        aecRenderHoldbackMs: Int = NativeTimedDualAecSession.defaultMicrophoneHoldbackMs,
        aecRenderWaitTimeoutMs: Int? = nil,
        microphoneDeviceUID: String? = nil
    ) {
        self.traceWriter =
            debugArtifactsDirectory.flatMap { CaptureTraceWriter(directoryPath: "\($0)/trace") }
        self.writer = PacketWriter(traceWriter: self.traceWriter)
        self.mode = mode
        self.debugArtifactsDirectory = debugArtifactsDirectory
        self.aecRenderHoldbackMs = max(0, aecRenderHoldbackMs)
        self.aecRenderWaitTimeoutMs = max(0, aecRenderWaitTimeoutMs ?? aecRenderHoldbackMs)
        self.initialMicrophoneBinding = microphoneDeviceUID.map(InitialMicrophoneBinding.fixed)
            ?? .followDefault
    }

    func start() async throws {
        let anchorHostTime = mach_absolute_time()
        if mode == .dual {
            let dualModeCapture = DualModeCapture(
                writer: writer,
                debugArtifactsDirectory: debugArtifactsDirectory,
                aecRenderHoldbackMs: aecRenderHoldbackMs,
                aecRenderWaitTimeoutMs: aecRenderWaitTimeoutMs,
                traceWriter: traceWriter,
                initialMicrophoneBinding: initialMicrophoneBinding,
                anchorHostTime: anchorHostTime
            )
            try await dualModeCapture.start()
            register(dualModeCapture: dualModeCapture)
            applyPendingMicrophoneCommand()
            return
        }

        if mode == .mic {
            let microphoneTimelineWriter = MicOnlyTimelineWriter(
                anchorHostTime: anchorHostTime,
                writer: writer,
                traceWriter: traceWriter
            ) { [weak self] gapMs in
                self?.microphoneBindingController?.reportTimelineJump(gapMs: gapMs)
            }
            let microphoneBindingController = MicBindingController(
                initialBinding: initialMicrophoneBinding,
                traceWriter: traceWriter,
                onSilenceTick: { [weak microphoneTimelineWriter] hostTime in
                    microphoneTimelineWriter?.handleSilenceTick(hostTime: hostTime)
                },
                onSamples: { [weak microphoneTimelineWriter] samples, hostTime in
                    microphoneTimelineWriter?.handleSamples(samples, hostTime: hostTime) ?? 0
                }
            )
            self.microphoneTimelineWriter = microphoneTimelineWriter
            microphoneBindingController.start()
            register(microphoneBindingController: microphoneBindingController)
            applyPendingMicrophoneCommand()
        }

        if mode == .system {
            let sampleClock = SharedAudioSampleClock(anchorHostTime: anchorHostTime)
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
        microphoneBindingController?.stop()
        await systemAudioCapture?.stop()
        try? traceWriter?.close()
    }

    func setMicrophone(uid: String, revision: Int) {
        sendMicrophoneCommand(.set(uid: uid, revision: revision))
    }

    func followDefaultMicrophone(revision: Int) {
        sendMicrophoneCommand(.followDefault(revision: revision))
    }

    private func sendMicrophoneCommand(_ command: MicrophoneCommand) {
        guard mode != .system else { return }

        commandLock.lock()
        if microphoneBindingController == nil, dualModeCapture == nil {
            pendingMicrophoneCommand = command
            commandLock.unlock()
            return
        }
        commandLock.unlock()
        applyMicrophoneCommand(command)
    }

    private func applyPendingMicrophoneCommand() {
        commandLock.lock()
        let command = pendingMicrophoneCommand
        pendingMicrophoneCommand = nil
        commandLock.unlock()
        if let command {
            applyMicrophoneCommand(command)
        }
    }

    private func register(dualModeCapture: DualModeCapture) {
        commandLock.lock()
        self.dualModeCapture = dualModeCapture
        commandLock.unlock()
    }

    private func register(microphoneBindingController: MicBindingController) {
        commandLock.lock()
        self.microphoneBindingController = microphoneBindingController
        commandLock.unlock()
    }

    private func applyMicrophoneCommand(_ command: MicrophoneCommand) {
        switch command {
        case .set(let uid, let revision):
            microphoneBindingController?.setMicrophone(uid: uid, revision: revision)
            dualModeCapture?.setMicrophone(uid: uid, revision: revision)
        case .followDefault(let revision):
            microphoneBindingController?.followDefault(revision: revision)
            dualModeCapture?.followDefault(revision: revision)
        }
    }
}
