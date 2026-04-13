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
    private var microphoneCapture: MicrophoneCapture?
    private var systemAudioCapture: SystemAudioCapture?

    init(
        writer: PacketWriter,
        debugArtifactsDirectory: String?,
        aecRenderHoldbackMs: Int = NativeTimedDualAecSession.defaultMicrophoneHoldbackMs,
        aecRenderWaitTimeoutMs: Int? = nil,
        traceWriter: CaptureTraceWriter? = nil
    ) {
        self.traceWriter = traceWriter
        self.writer = writer
        self.debugArtifactsDirectory = debugArtifactsDirectory
        self.aecRenderHoldbackMs = max(0, aecRenderHoldbackMs)
        self.aecRenderWaitTimeoutMs = max(0, aecRenderWaitTimeoutMs ?? aecRenderHoldbackMs)
        let sharedClock = SharedAudioSampleClock()
        self.microphoneTracker = SourceSamplePositionTracker(clock: sharedClock)
        self.systemTracker = SourceSamplePositionTracker(clock: sharedClock)
        self.timedSession = NativeTimedDualAecSession(
            microphoneHoldbackMs: self.aecRenderHoldbackMs,
            renderWaitTimeoutMs: self.aecRenderWaitTimeoutMs,
            traceWriter: traceWriter
        )
    }

    func start() async throws {
        let microphoneCapture = MicrophoneCapture(traceWriter: traceWriter) { [weak self] samples, hostTime in
            self?.handleMicrophoneSamples(samples, hostTime: hostTime)
        }
        try microphoneCapture.start()
        self.microphoneCapture = microphoneCapture

        let systemAudioCapture = SystemAudioCapture(
            debugArtifactsDirectory: debugArtifactsDirectory,
            traceWriter: traceWriter
        ) { [weak self] samples, hostTime in
            self?.handleSystemSamples(samples, hostTime: hostTime)
        }
        do {
            try await systemAudioCapture.start()
        } catch {
            microphoneCapture.stop()
            self.microphoneCapture = nil
            throw error
        }
        self.systemAudioCapture = systemAudioCapture

        Logger.info(
            "Dual mode capture started: aec=\(timedSession.aecModeDescription) frameSize=\(FixedFrameAecProcessor.frameSize) renderHoldback=\(timedSession.microphoneHoldbackDescription) renderWaitTimeout=\(timedSession.renderWaitTimeoutDescription)"
        )
    }

    func stop() async {
        microphoneCapture?.stop()
        await systemAudioCapture?.stop()
        processingQueue.sync {
            emitOutputs(timedSession.finish())
            timedSession.reset()
        }
        microphoneTimelineMapper.reset()
        systemTimelineMapper.reset()
        Logger.info("Dual mode capture stopped")
    }

    private func handleMicrophoneSamples(_ samples: [Float], hostTime: UInt64?) {
        let rawStartSampleIndex = microphoneTracker.resolveStartSampleIndex(
            hostTime: hostTime,
            sampleCount: samples.count
        )
        let timelineRegistration = microphoneTimelineMapper.registerChunk(
            rawStartSampleIndex: rawStartSampleIndex,
            sampleCount: samples.count
        )
        let sessionStartSampleIndex = timelineRegistration.sessionStartSampleIndex
        traceWriter?.record(
            event: "microphone_tracker_resolve",
            metadata: nonNilTraceFields([
                ("hostTime", hostTime.map(Int64.init)),
                ("startSampleIndex", rawStartSampleIndex),
                ("sessionStartSampleIndex", sessionStartSampleIndex),
                ("sampleCount", samples.count)
            ])
        )
        traceWriter?.record(
            event: "microphone_session_timeline_map",
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
            self.emitOutputs(self.timedSession.ingestMicrophone(chunk))
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
