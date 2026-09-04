import Foundation

// Bridges raw microphone/render callbacks into the shared live AEC session and packet output.

final class DualModeCapture {
    private let debugArtifactsDirectory: String?
    private let traceWriter: CaptureTraceWriter?
    private let writer: PacketWriter
    private let aecRenderHoldbackMs: Int
    private let aecRenderWaitTimeoutMs: Int
    private let processingQueue = DispatchQueue(label: "ai.prismical.audio-capture.dual.timed-session")
    private let microphoneTracker: SourceSamplePositionTracker
    private let systemTracker: SourceSamplePositionTracker
    private let microphoneTimelineMapper = CollapsedSourceTimelineMapper(minimumGapToPreserve: 1)
    private let systemTimelineMapper = CollapsedSourceTimelineMapper(minimumGapToPreserve: 1)
    private let timedSession: NativeTimedDualAecSession
    private let initialMicrophoneBinding: InitialMicrophoneBinding
    private var microphoneBindingController: MicBindingController?
    private var systemAudioCapture: SystemAudioCapture?
    private var microphoneIsLive = false
    private var microphoneSilenceEndSampleIndex: Int64 = 0

    init(
        writer: PacketWriter,
        debugArtifactsDirectory: String?,
        aecRenderHoldbackMs: Int = NativeTimedDualAecSession.defaultMicrophoneHoldbackMs,
        aecRenderWaitTimeoutMs: Int? = nil,
        traceWriter: CaptureTraceWriter? = nil,
        initialMicrophoneBinding: InitialMicrophoneBinding = .followDefault,
        anchorHostTime: UInt64 = mach_absolute_time()
    ) {
        self.traceWriter = traceWriter
        self.writer = writer
        self.debugArtifactsDirectory = debugArtifactsDirectory
        self.aecRenderHoldbackMs = max(0, aecRenderHoldbackMs)
        self.aecRenderWaitTimeoutMs = max(0, aecRenderWaitTimeoutMs ?? aecRenderHoldbackMs)
        self.initialMicrophoneBinding = initialMicrophoneBinding
        let sharedClock = SharedAudioSampleClock(anchorHostTime: anchorHostTime)
        self.microphoneTracker = SourceSamplePositionTracker(clock: sharedClock)
        self.systemTracker = SourceSamplePositionTracker(clock: sharedClock)
        self.timedSession = NativeTimedDualAecSession(
            microphoneHoldbackMs: self.aecRenderHoldbackMs,
            renderWaitTimeoutMs: self.aecRenderWaitTimeoutMs,
            traceWriter: traceWriter
        )
    }

    func start() async throws {
        let microphoneBindingController = MicBindingController(
            initialBinding: initialMicrophoneBinding,
            traceWriter: traceWriter,
            onRealAudioStopped: { [weak self] in
                self?.processingQueue.sync {
                    self?.microphoneIsLive = false
                }
            }
        ) { [weak self] samples, hostTime in
            self?.handleMicrophoneSamples(samples, hostTime: hostTime) ?? 0
        }
        microphoneBindingController.start()
        self.microphoneBindingController = microphoneBindingController

        let systemAudioCapture = SystemAudioCapture(
            debugArtifactsDirectory: debugArtifactsDirectory,
            traceWriter: traceWriter
        ) { [weak self] samples, hostTime in
            self?.handleSystemSamples(samples, hostTime: hostTime)
        }
        do {
            try await systemAudioCapture.start()
        } catch {
            microphoneBindingController.stop()
            self.microphoneBindingController = nil
            throw error
        }
        self.systemAudioCapture = systemAudioCapture

        Logger.info(
            "Dual mode capture started: aec=\(timedSession.aecModeDescription) frameSize=\(FixedFrameAecProcessor.frameSize) renderHoldback=\(timedSession.microphoneHoldbackDescription) renderWaitTimeout=\(timedSession.renderWaitTimeoutDescription)"
        )
    }

    func stop() async {
        microphoneBindingController?.stop()
        await systemAudioCapture?.stop()
        processingQueue.sync {
            emitOutputs(timedSession.finish())
            timedSession.reset()
        }
        microphoneTimelineMapper.reset()
        systemTimelineMapper.reset()
        Logger.info("Dual mode capture stopped")
    }

    func setMicrophone(uid: String, revision: Int) {
        microphoneBindingController?.setMicrophone(uid: uid, revision: revision)
    }

    func followDefault(revision: Int) {
        microphoneBindingController?.followDefault(revision: revision)
    }

    private func handleMicrophoneSamples(_ samples: [Float], hostTime: UInt64?) -> Int {
        let rawStartSampleIndex = microphoneTracker.resolveStartSampleIndex(
            hostTime: hostTime,
            sampleCount: samples.count
        )
        return processingQueue.sync {
            microphoneIsLive = true
            let trimmedSamples = min(
                samples.count,
                max(0, Int(microphoneSilenceEndSampleIndex - rawStartSampleIndex))
            )
            guard trimmedSamples < samples.count else { return trimmedSamples }

            let liveSamples = trimmedSamples == 0
                ? samples
                : Array(samples.dropFirst(trimmedSamples))
            let liveStartSampleIndex = rawStartSampleIndex + Int64(trimmedSamples)
            let timelineRegistration = microphoneTimelineMapper.registerChunk(
                rawStartSampleIndex: liveStartSampleIndex,
                sampleCount: liveSamples.count
            )
            let sessionStartSampleIndex = timelineRegistration.sessionStartSampleIndex
            traceWriter?.record(
                event: "microphone_tracker_resolve",
                metadata: nonNilTraceFields([
                    ("hostTime", hostTime.map(Int64.init)),
                    ("startSampleIndex", liveStartSampleIndex),
                    ("sessionStartSampleIndex", sessionStartSampleIndex),
                    ("sampleCount", liveSamples.count),
                    ("trimmedSampleCount", trimmedSamples)
                ])
            )
            traceWriter?.record(
                event: "microphone_session_timeline_map",
                metadata: [
                    "rawStartSampleIndex": liveStartSampleIndex,
                    "sessionStartSampleIndex": sessionStartSampleIndex,
                    "sampleCount": liveSamples.count,
                    "rawGapSampleCount": timelineRegistration.rawGapSampleCount,
                    "preservedGapSampleCount": timelineRegistration.preservedGapSampleCount
                ]
            )
            let chunk = TimedAudioChunk(
                startSampleIndex: sessionStartSampleIndex,
                rawStartSampleIndex: liveStartSampleIndex,
                samples: liveSamples
            )
            emitOutputs(timedSession.ingestMicrophone(chunk))
            return trimmedSamples
        }
    }

    private func handleSystemSamples(_ samples: [Float], hostTime: UInt64?) {
        let rawStartSampleIndex = systemTracker.resolveStartSampleIndex(
            hostTime: hostTime,
            sampleCount: samples.count
        )
        let timelineRegistration = systemTimelineMapper.registerChunk(
            rawStartSampleIndex: rawStartSampleIndex,
            sampleCount: samples.count
        )
        let sessionStartSampleIndex = timelineRegistration.sessionStartSampleIndex
        traceWriter?.record(
            event: "system_tracker_resolve",
            metadata: nonNilTraceFields([
                ("hostTime", hostTime.map(Int64.init)),
                ("startSampleIndex", rawStartSampleIndex),
                ("sessionStartSampleIndex", sessionStartSampleIndex),
                ("sampleCount", samples.count)
            ])
        )
        traceWriter?.record(
            event: "system_session_timeline_map",
            metadata: [
                "rawStartSampleIndex": rawStartSampleIndex,
                "sessionStartSampleIndex": sessionStartSampleIndex,
                "sampleCount": samples.count,
                "rawGapSampleCount": timelineRegistration.rawGapSampleCount,
                "preservedGapSampleCount": timelineRegistration.preservedGapSampleCount
            ]
        )
        let chunk = TimedAudioChunk(
            startSampleIndex: sessionStartSampleIndex,
            rawStartSampleIndex: rawStartSampleIndex,
            samples: samples
        )
        processingQueue.async { [weak self] in
            guard let self else { return }
            if !self.microphoneIsLive {
                self.microphoneSilenceEndSampleIndex = max(
                    self.microphoneSilenceEndSampleIndex,
                    rawStartSampleIndex + Int64(samples.count)
                )
                let silenceChunk = TimedAudioChunk(
                    startSampleIndex: sessionStartSampleIndex,
                    rawStartSampleIndex: rawStartSampleIndex,
                    samples: Array(repeating: .zero, count: samples.count)
                )
                self.emitOutputs(self.timedSession.ingestMicrophone(silenceChunk))
            }
            self.emitOutputs(self.timedSession.ingestSystem(chunk))
        }
    }

    private func emitOutputs(_ outputs: [NativeTimedSessionOutputChunk]) {
        guard !outputs.isEmpty else { return }

        for output in outputs {
            let presentationStartSampleIndex = presentationStartSampleIndex(for: output)
            traceWriter?.record(
                event: "timed_session_output_map",
                metadata: [
                    "source": captureSourceName(output.source),
                    "sessionStartSampleIndex": output.startSampleIndex,
                    "presentationStartSampleIndex": presentationStartSampleIndex,
                    "sampleCount": output.samples.count
                ]
            )
            writer.write(
                source: output.source,
                samples: output.samples,
                timestampMs: timestampMs(forSampleIndex: presentationStartSampleIndex),
                sampleStartIndex: presentationStartSampleIndex
            )
        }
    }

    private func presentationStartSampleIndex(for output: NativeTimedSessionOutputChunk) -> Int64 {
        switch output.source {
        case .micRaw, .micProcessed:
            return microphoneTimelineMapper.rawStartSampleIndex(
                forSessionStartSampleIndex: output.startSampleIndex
            )
        case .system:
            return systemTimelineMapper.rawStartSampleIndex(
                forSessionStartSampleIndex: output.startSampleIndex
            )
        }
    }
}
