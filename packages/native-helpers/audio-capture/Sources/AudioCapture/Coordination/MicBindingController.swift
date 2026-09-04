import AudioToolbox
import CoreAudio
import Foundation

enum InitialMicrophoneBinding {
    case followDefault
    case fixed(String)
}

private enum MicrophoneBindingIntent {
    case followDefault
    case fixed(String)

    var eventMode: String {
        switch self {
        case .followDefault:
            return "follow-default"
        case .fixed:
            return "fixed"
        }
    }
}

// Serializes microphone device changes while the session timeline remains owned by the caller.
final class MicBindingController {
    private let queue = DispatchQueue(label: "ai.prismical.audio-capture.microphone.binding")
    private let deliveryLock = NSLock()
    private let traceWriter: CaptureTraceWriter?
    private let onSamples: (_ samples: [Float], _ hostTime: UInt64?) -> Int
    private let onRealAudioStopped: (() -> Void)?
    private let onSilenceTick: ((UInt64) -> Void)?

    private var intent: MicrophoneBindingIntent
    private var revision = 0
    private var generation: UInt64 = 0
    private var capture: MicrophoneCapture?
    private var defaultObservation: AudioObjectPropertyObservation?
    private var devicesObservation: AudioObjectPropertyObservation?
    private var aliveObservation: AudioObjectPropertyObservation?
    private var silenceTimer: DispatchSourceTimer?
    private var retryAttempt = 0
    private var currentDeviceID: AudioDeviceID?
    private var currentDeviceUID: String?
    private var lastCallbackUptimeNs: UInt64 = 0
    private var pendingTransientRenderStatus: OSStatus?
    private var bindStartedUptimeNs: UInt64 = 0
    private var pendingReason = "command"
    private var recoverOnActivation = false
    private var isUnbound = false
    private var unavailableEventActive = false
    private var stopped = false
    private var deliveringRealAudio = false

    init(
        initialBinding: InitialMicrophoneBinding,
        traceWriter: CaptureTraceWriter? = nil,
        onRealAudioStopped: (() -> Void)? = nil,
        onSilenceTick: ((UInt64) -> Void)? = nil,
        onSamples: @escaping (_ samples: [Float], _ hostTime: UInt64?) -> Int
    ) {
        switch initialBinding {
        case .followDefault:
            self.intent = .followDefault
        case .fixed(let uid):
            self.intent = .fixed(uid)
        }
        self.traceWriter = traceWriter
        self.onRealAudioStopped = onRealAudioStopped
        self.onSilenceTick = onSilenceTick
        self.onSamples = onSamples
    }

    func start() {
        queue.sync {
            guard !stopped else { return }
            installGlobalObservations()
            startSilenceTimer()

            switch intent {
            case .followDefault:
                bindDefault(reason: "command")
            case .fixed(let uid):
                if let deviceID = try? getInputDeviceID(uid: uid) {
                    bind(deviceID: deviceID, intentAtBind: intent, reason: "command")
                } else {
                    intent = .followDefault
                    bindDefault(reason: "autonomous-fallback")
                }
            }
        }
    }

    func stop() {
        queue.sync {
            guard !stopped else { return }
            stopped = true
            generation &+= 1
            setDeliveringRealAudio(false)
            silenceTimer?.cancel()
            silenceTimer = nil
            aliveObservation?.cancel()
            aliveObservation = nil
            defaultObservation?.cancel()
            defaultObservation = nil
            devicesObservation?.cancel()
            devicesObservation = nil
            capture?.stop()
            capture = nil
            currentDeviceID = nil
            currentDeviceUID = nil
        }
    }

    func setMicrophone(uid: String, revision: Int) {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            guard revision >= self.revision else { return }
            self.revision = max(0, revision)
            self.intent = .fixed(uid)
            self.retryAttempt = 0

            if self.currentDeviceUID == uid {
                if self.isDeliveringRealAudio() {
                    self.emitBound(reason: "command", blackoutMs: 0)
                } else {
                    self.pendingReason = "command"
                }
                return
            }

            guard let deviceID = try? getInputDeviceID(uid: uid) else {
                self.emitBindFailed(
                    uid: uid,
                    status: kAudioHardwareBadDeviceError,
                    reason: "device-not-found"
                )
                self.intent = .followDefault
                self.bindDefault(reason: "autonomous-fallback")
                return
            }
            self.bind(deviceID: deviceID, intentAtBind: self.intent, reason: "command")
        }
    }

    func followDefault(revision: Int) {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            guard revision >= self.revision else { return }
            self.revision = max(0, revision)
            self.intent = .followDefault
            self.retryAttempt = 0

            if let defaultDeviceID = try? getDefaultInputDeviceID(),
               defaultDeviceID == self.currentDeviceID
            {
                if self.isDeliveringRealAudio() {
                    self.emitBound(reason: "command", blackoutMs: 0)
                } else {
                    self.pendingReason = "command"
                }
                return
            }
            self.bindDefault(reason: "command")
        }
    }

    func reportTimelineJump(gapMs: Int) {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            Logger.micEvent([
                "kind": "timeline-jump",
                "gap_ms": max(0, gapMs),
                "rev": self.revision,
            ])
        }
    }

    private func bindDefault(reason: String, excluding excludedDeviceID: AudioDeviceID? = nil) {
        guard !stopped else { return }
        guard let deviceID = try? getDefaultInputDeviceID(), deviceID != excludedDeviceID else {
            if capture != nil {
                disposeCurrentCapture()
            }
            enterUnbound()
            return
        }
        if deviceID == currentDeviceID, isDeliveringRealAudio() {
            emitBound(reason: reason, blackoutMs: 0, trimmedSamples: 0)
            return
        }
        bind(deviceID: deviceID, intentAtBind: .followDefault, reason: reason)
    }

    private func bind(
        deviceID: AudioDeviceID,
        intentAtBind: MicrophoneBindingIntent,
        reason: String
    ) {
        guard !stopped else { return }

        generation &+= 1
        let bindGeneration = generation
        let wasUnbound = isUnbound
        isUnbound = false
        recoverOnActivation = recoverOnActivation || wasUnbound
        setDeliveringRealAudio(false)
        bindStartedUptimeNs = DispatchTime.now().uptimeNanoseconds
        aliveObservation?.cancel()
        aliveObservation = nil
        capture?.stop()
        capture = nil
        currentDeviceID = nil
        currentDeviceUID = nil

        let details: (uid: String, name: String)
        do {
            details = try getInputDeviceDetails(deviceID: deviceID)
        } catch {
            handleBindFailure(
                uid: "unknown",
                deviceID: deviceID,
                intentAtBind: intentAtBind,
                error: error
            )
            return
        }

        lastCallbackUptimeNs = 0
        pendingTransientRenderStatus = nil
        pendingReason = reason

        let microphoneCapture = MicrophoneCapture(
            deviceID: deviceID,
            deviceUID: details.uid,
            deviceName: details.name,
            traceWriter: traceWriter,
            onRenderFailure: { [weak self] status in
                self?.queue.async {
                    guard let self, !self.stopped, bindGeneration == self.generation else { return }
                    if status == kAudioUnitErr_CannotDoInCurrentContext {
                        self.pendingTransientRenderStatus = status
                        return
                    }
                    self.handleRuntimeFailure(
                        generation: bindGeneration,
                        status: status,
                        reason: "core-audio",
                        operation: "AudioUnitRender(microphone)"
                    )
                }
            },
            onSamples: { [weak self] samples, hostTime in
                self?.queue.async {
                    self?.handleSamples(
                        samples,
                        hostTime: hostTime,
                        generation: bindGeneration
                    )
                }
            }
        )

        do {
            try microphoneCapture.start()
            capture = microphoneCapture
            currentDeviceID = deviceID
            currentDeviceUID = details.uid
            installAliveObservation(deviceID: deviceID, generation: bindGeneration)
            scheduleActivationWatchdog(generation: bindGeneration)
        } catch {
            microphoneCapture.stop()
            handleBindFailure(
                uid: details.uid,
                deviceID: deviceID,
                intentAtBind: intentAtBind,
                error: error
            )
        }
    }

    private func handleSamples(
        _ samples: [Float],
        hostTime: UInt64?,
        generation callbackGeneration: UInt64
    ) {
        guard !stopped, callbackGeneration == generation, !samples.isEmpty else { return }

        let now = DispatchTime.now().uptimeNanoseconds
        lastCallbackUptimeNs = now
        pendingTransientRenderStatus = nil
        let firstBuffer = !isDeliveringRealAudio()
        if firstBuffer {
            setDeliveringRealAudio(true)
            retryAttempt = 0
        }

        let trimmedSamples = onSamples(samples, hostTime)

        if firstBuffer {
            let blackoutMs = Int((now - bindStartedUptimeNs) / 1_000_000)
            if recoverOnActivation, let currentDeviceUID {
                Logger.micEvent([
                    "kind": "recovered",
                    "uid": currentDeviceUID,
                    "rev": revision,
                ])
                recoverOnActivation = false
            }
            unavailableEventActive = false
            emitBound(
                reason: pendingReason,
                blackoutMs: blackoutMs,
                trimmedSamples: trimmedSamples
            )
            scheduleStreamingWatchdog(generation: callbackGeneration)
        }
    }

    private func handleRuntimeFailure(
        generation failedGeneration: UInt64,
        status: OSStatus?,
        reason: String,
        operation: String? = nil
    ) {
        guard !stopped, failedGeneration == generation, let uid = currentDeviceUID else { return }
        let failedDeviceID = currentDeviceID
        let failedIntent = intent
        emitBindFailed(uid: uid, status: status, reason: reason, operation: operation)
        disposeCurrentCapture()
        fallbackAfterFailure(failedDeviceID: failedDeviceID, failedIntent: failedIntent)
    }

    private func handleBindFailure(
        uid: String,
        deviceID: AudioDeviceID,
        intentAtBind: MicrophoneBindingIntent,
        error: Error
    ) {
        if case CaptureError.coreAudioOperationFailed(let operation, let status) = error {
            emitBindFailed(
                uid: uid,
                status: status,
                reason: "core-audio",
                operation: operation
            )
        } else {
            emitBindFailed(uid: uid, status: nil, reason: "microphone-unavailable")
        }
        disposeCurrentCapture()
        fallbackAfterFailure(failedDeviceID: deviceID, failedIntent: intentAtBind)
    }

    private func fallbackAfterFailure(
        failedDeviceID: AudioDeviceID?,
        failedIntent: MicrophoneBindingIntent
    ) {
        switch failedIntent {
        case .fixed:
            intent = .followDefault
            bindDefault(reason: "autonomous-fallback", excluding: failedDeviceID)
        case .followDefault:
            intent = .followDefault
            enterUnbound()
        }
    }

    private func handleDeviceLoss(generation observedGeneration: UInt64) {
        guard !stopped, observedGeneration == generation else { return }
        let lostUID = currentDeviceUID
        let lostDeviceID = currentDeviceID
        if let lostUID {
            Logger.micEvent([
                "kind": "lost",
                "uid": lostUID,
                "rev": revision,
            ])
        }
        disposeCurrentCapture()
        intent = .followDefault
        bindDefault(reason: "autonomous-fallback", excluding: lostDeviceID)
    }

    private func disposeCurrentCapture() {
        generation &+= 1
        setDeliveringRealAudio(false)
        aliveObservation?.cancel()
        aliveObservation = nil
        capture?.stop()
        capture = nil
        currentDeviceID = nil
        currentDeviceUID = nil
        pendingTransientRenderStatus = nil
    }

    private func enterUnbound() {
        isUnbound = true
        setDeliveringRealAudio(false)
        if !unavailableEventActive {
            unavailableEventActive = true
            Logger.micEvent([
                "kind": "unavailable",
                "rev": revision,
            ])
        }

        if let deviceIDs = try? getInputDeviceIDs(), !deviceIDs.isEmpty {
            scheduleRetry()
        }
    }

    private func scheduleRetry() {
        let delays: [Double] = [1, 2, 5, 10]
        let delay = delays[min(retryAttempt, delays.count - 1)]
        retryAttempt += 1
        let retryGeneration = generation
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped, self.isUnbound,
                  retryGeneration == self.generation
            else { return }
            self.bindDefault(reason: "autonomous-fallback")
        }
    }

    private func installGlobalObservations() {
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        defaultObservation = try? AudioObjectPropertyObservation(
            objectID: systemObject,
            selector: kAudioHardwarePropertyDefaultInputDevice,
            queue: queue
        ) { [weak self] in
            self?.handleDefaultInputChange()
        }
        devicesObservation = try? AudioObjectPropertyObservation(
            objectID: systemObject,
            selector: kAudioHardwarePropertyDevices,
            queue: queue
        ) { [weak self] in
            self?.handleDeviceListChange()
        }
    }

    private func installAliveObservation(deviceID: AudioDeviceID, generation: UInt64) {
        aliveObservation = try? AudioObjectPropertyObservation(
            objectID: deviceID,
            selector: kAudioDevicePropertyDeviceIsAlive,
            queue: queue
        ) { [weak self] in
            guard let self else { return }
            let isAlive: UInt32? = try? getAudioObjectProperty(
                objectID: deviceID,
                selector: kAudioDevicePropertyDeviceIsAlive,
                type: UInt32.self
            )
            if isAlive == 0 {
                self.handleDeviceLoss(generation: generation)
            }
        }
    }

    private func handleDefaultInputChange() {
        guard !stopped else { return }
        guard case .followDefault = intent else { return }
        guard let defaultDeviceID = try? getDefaultInputDeviceID() else {
            disposeCurrentCapture()
            enterUnbound()
            return
        }
        guard defaultDeviceID != currentDeviceID else { return }
        bind(deviceID: defaultDeviceID, intentAtBind: .followDefault, reason: "default-change")
    }

    private func handleDeviceListChange() {
        guard !stopped else { return }
        let deviceIDs = (try? getInputDeviceIDs()) ?? []
        if let currentDeviceID, !deviceIDs.contains(currentDeviceID) {
            handleDeviceLoss(generation: generation)
            return
        }
        if isUnbound, !deviceIDs.isEmpty {
            retryAttempt = 0
            bindDefault(reason: "autonomous-fallback")
        }
    }

    private func scheduleActivationWatchdog(generation watchedGeneration: UInt64) {
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, !self.stopped, watchedGeneration == self.generation,
                  !self.isDeliveringRealAudio()
            else { return }
            if let status = self.pendingTransientRenderStatus {
                self.handleRuntimeFailure(
                    generation: watchedGeneration,
                    status: status,
                    reason: "core-audio",
                    operation: "AudioUnitRender(microphone)"
                )
                return
            }
            self.handleRuntimeFailure(
                generation: watchedGeneration,
                status: nil,
                reason: "callback-timeout"
            )
        }
    }

    private func scheduleStreamingWatchdog(generation watchedGeneration: UInt64) {
        queue.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, !self.stopped, watchedGeneration == self.generation,
                  self.isDeliveringRealAudio()
            else { return }

            let now = DispatchTime.now().uptimeNanoseconds
            if now - self.lastCallbackUptimeNs >= 1_000_000_000 {
                if let status = self.pendingTransientRenderStatus {
                    self.handleRuntimeFailure(
                        generation: watchedGeneration,
                        status: status,
                        reason: "core-audio",
                        operation: "AudioUnitRender(microphone)"
                    )
                    return
                }
                self.handleDeviceLoss(generation: watchedGeneration)
                return
            }
            self.scheduleStreamingWatchdog(generation: watchedGeneration)
        }
    }

    private func startSilenceTimer() {
        guard let onSilenceTick else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in
            guard let self, !self.stopped, !self.isDeliveringRealAudio() else { return }
            onSilenceTick(mach_absolute_time())
        }
        timer.resume()
        silenceTimer = timer
    }

    private func emitBound(reason: String, blackoutMs: Int, trimmedSamples: Int = 0) {
        guard let uid = currentDeviceUID, let name = capture?.deviceName else { return }
        Logger.micEvent([
            "kind": "bound",
            "uid": uid,
            "name": name,
            "mode": intent.eventMode,
            "rev": revision,
            "reason": reason,
            "blackout_ms": max(0, blackoutMs),
            "trimmed_ms": (max(0, trimmedSamples) * 1000) / FixedFrameAecProcessor.sampleRate,
        ])
    }

    private func emitBindFailed(
        uid: String,
        status: OSStatus?,
        reason: String,
        operation: String? = nil
    ) {
        var event: [String: Any] = [
            "kind": "bind-failed",
            "uid": uid,
            "rev": revision,
            "reason": reason,
        ]
        if let status {
            event["os_status"] = status
        }
        if let operation {
            event["operation"] = operation
        }
        Logger.micEvent(event)
    }

    private func setDeliveringRealAudio(_ value: Bool) {
        deliveryLock.lock()
        let didStopRealAudio = deliveringRealAudio && !value
        deliveringRealAudio = value
        deliveryLock.unlock()
        if didStopRealAudio {
            onRealAudioStopped?()
        }
    }

    private func isDeliveringRealAudio() -> Bool {
        deliveryLock.lock()
        defer { deliveryLock.unlock() }
        return deliveringRealAudio
    }

}
