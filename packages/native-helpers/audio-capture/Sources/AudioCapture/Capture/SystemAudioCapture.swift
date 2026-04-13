import AVFoundation
import CoreAudio
import AudioToolbox
import Foundation

// Owns the CoreAudio system/tap lifecycle and forwards normalized mono 48 kHz samples upstream.

final class SystemAudioCapture {
    let onSamples: NormalizedSampleHandler
    let onAggregateMicrophoneSamples: NormalizedSampleHandler?
    let traceWriter: CaptureTraceWriter?
    let captureAggregateInput: Bool
    let processingQueue = DispatchQueue(label: "ai.prismical.audio-capture.system.processing")
    let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    let debugArtifactsDirectory: String?
    var sourceFormat: AVAudioFormat?
    var sourceSampleRate: Double?
    var aggregateInputFormats: [AVAudioFormat] = []
    var aggregateOutputFormats: [AVAudioFormat] = []
    var aggregateDeviceSampleRate: Double?
    var tapID: AudioObjectID = kAudioObjectUnknown
    var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    var ioProcID: AudioDeviceIOProcID?
    var callbackLogCount = 0
    var selectedInputBufferLogCount = 0
    var preResampleDebugWriter: DebugWavWriter?
    var postResampleDebugWriter: DebugWavWriter?
    var debugCaptureStartHostTime: UInt64?
    var preResampleDebugTracker: SourceSamplePositionTracker?
    var postResampleDebugTracker: SourceSamplePositionTracker?
    var preResampleDebugEndSampleIndex: Int64 = 0
    var postResampleDebugEndSampleIndex: Int64 = 0
    var callbackSequence: UInt64 = 0

    init(
        debugArtifactsDirectory: String? = nil,
        traceWriter: CaptureTraceWriter? = nil,
        onSamples: @escaping NormalizedSampleHandler,
        onAggregateMicrophoneSamples: NormalizedSampleHandler? = nil
    ) {
        self.debugArtifactsDirectory = debugArtifactsDirectory
        self.traceWriter = traceWriter
        self.onSamples = onSamples
        self.onAggregateMicrophoneSamples = onAggregateMicrophoneSamples
        self.captureAggregateInput = onAggregateMicrophoneSamples != nil
    }

    func start() async throws {
        guard #available(macOS 14.2, *) else {
            throw CaptureError.unsupportedSystemAudioOSVersion
        }

        Logger.info("System audio capture setup: begin")
        let excludedProcesses = getCurrentProcessObjectID().map { [$0] } ?? []
        Logger.info("System audio capture setup: resolved excluded processes count=\(excludedProcesses.count)")
        let tapDescription = CATapDescription(monoGlobalTapButExcludeProcesses: excludedProcesses)
        tapDescription.name = "System Audio Capture"
        tapDescription.isPrivate = true
        let tapUUID = UUID()
        tapDescription.uuid = tapUUID

        var tapID: AudioObjectID = kAudioObjectUnknown
        try coreAudioCheck(
            AudioHardwareCreateProcessTap(tapDescription, &tapID),
            operation: "AudioHardwareCreateProcessTap"
        )
        self.tapID = tapID
        Logger.info("System audio capture setup: process tap created id=\(tapID)")

        let outputDeviceUID = try getDefaultOutputDeviceUID()
        Logger.info("System audio capture setup: default output device uid=\(outputDeviceUID)")
        var inputDeviceUID: String?
        if captureAggregateInput {
            do {
                let resolvedInputDeviceUID = try getDefaultInputDeviceUID()
                inputDeviceUID = resolvedInputDeviceUID
                Logger.info("System audio capture setup: default input device uid=\(resolvedInputDeviceUID)")
            } catch {
                Logger.error("Failed to resolve default input device uid: \(error.localizedDescription)")
            }
        }
        let aggregateDeviceDescription = makeAggregateDeviceDescription(
            outputDeviceUID: outputDeviceUID,
            inputDeviceUID: inputDeviceUID
        )

        var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
        try coreAudioCheck(
            AudioHardwareCreateAggregateDevice(aggregateDeviceDescription as CFDictionary, &aggregateDeviceID),
            operation: "AudioHardwareCreateAggregateDevice"
        )
        self.aggregateDeviceID = aggregateDeviceID
        Logger.info("System audio capture setup: aggregate device created id=\(aggregateDeviceID)")

        try attachTapToAggregateDevice(
            aggregateDeviceID: aggregateDeviceID,
            tapUID: tapUUID.uuidString
        )
        Logger.info("System audio capture setup: tap attached to aggregate device")

        let aggregateDeviceSampleRate: Float64 = try getAudioObjectProperty(
            objectID: aggregateDeviceID,
            selector: kAudioDevicePropertyNominalSampleRate,
            type: Float64.self
        )
        self.aggregateDeviceSampleRate = aggregateDeviceSampleRate
        Logger.info("System audio capture setup: aggregate sample rate=\(Int(aggregateDeviceSampleRate))")

        var tapFormatDescription: AudioStreamBasicDescription = try getAudioObjectProperty(
            objectID: tapID,
            selector: kAudioTapPropertyFormat,
            type: AudioStreamBasicDescription.self
        )
        Logger.info("System audio capture setup: tap format fetched")

        guard let sourceFormat = AVAudioFormat(streamDescription: &tapFormatDescription) else {
            throw CaptureError.unsupportedSystemAudioBuffer
        }

        guard commonFormat(from: tapFormatDescription) != nil else {
            throw CaptureError.unsupportedSystemAudioCapture
        }

        self.sourceFormat = sourceFormat
        self.sourceSampleRate = aggregateDeviceSampleRate
        self.aggregateInputFormats = (try? getDeviceStreamFormats(
            deviceID: aggregateDeviceID,
            scope: kAudioObjectPropertyScopeInput
        )) ?? []
        self.aggregateOutputFormats = (try? getDeviceStreamFormats(
            deviceID: aggregateDeviceID,
            scope: kAudioObjectPropertyScopeOutput
        )) ?? []
        callbackLogCount = 0
        callbackSequence = 0
        let captureStartHostTime = mach_absolute_time()
        debugCaptureStartHostTime = captureStartHostTime
        preResampleDebugTracker = nil
        postResampleDebugTracker = nil
        preResampleDebugEndSampleIndex = 0
        postResampleDebugEndSampleIndex = 0

        if let debugArtifactsDirectory {
            let debugDirectoryURL = URL(fileURLWithPath: debugArtifactsDirectory)
            preResampleDebugWriter = DebugWavWriter(
                filePath: debugDirectoryURL.appendingPathComponent("system-pre-resample.wav").path,
                sampleRate: UInt32(aggregateDeviceSampleRate.rounded())
            )
            postResampleDebugWriter = DebugWavWriter(
                filePath: debugDirectoryURL.appendingPathComponent("system-post-resample.wav").path,
                sampleRate: 48_000
            )
            preResampleDebugTracker = SourceSamplePositionTracker(
                clock: SharedAudioSampleClock(
                    sampleRate: aggregateDeviceSampleRate,
                    anchorHostTime: captureStartHostTime
                )
            )
            postResampleDebugTracker = SourceSamplePositionTracker(
                clock: SharedAudioSampleClock(
                    sampleRate: targetFormat.sampleRate,
                    anchorHostTime: captureStartHostTime
                )
            )
        }

        Logger.info(
            "System audio tap format ready: tapSampleRate=\(Int(sourceFormat.sampleRate)) aggregateSampleRate=\(Int(aggregateDeviceSampleRate)) channels=\(sourceFormat.channelCount) interleaved=\(sourceFormat.isInterleaved)"
        )
        for (index, aggregateInputFormat) in aggregateInputFormats.enumerated() {
            Logger.info(
                "System audio aggregate input format[\(index)]: sampleRate=\(Int(aggregateInputFormat.sampleRate)) channels=\(aggregateInputFormat.channelCount) interleaved=\(aggregateInputFormat.isInterleaved)"
            )
        }
        for (index, aggregateOutputFormat) in aggregateOutputFormats.enumerated() {
            Logger.info(
                "System audio aggregate output format[\(index)]: sampleRate=\(Int(aggregateOutputFormat.sampleRate)) channels=\(aggregateOutputFormat.channelCount) interleaved=\(aggregateOutputFormat.isInterleaved)"
            )
        }

        var startTraceMetadata: [String: Any] = [
            "tapID": Int(tapID),
            "aggregateDeviceID": Int(aggregateDeviceID),
            "outputDeviceUID": outputDeviceUID,
            "aggregateDeviceSampleRate": aggregateDeviceSampleRate
        ]
        if let inputDeviceUID {
            startTraceMetadata["inputDeviceUID"] = inputDeviceUID
        }
        startTraceMetadata.merge(avAudioFormatFields(sourceFormat, prefix: "tap")) { _, new in new }
        for (index, format) in aggregateInputFormats.enumerated() {
            startTraceMetadata.merge(
                avAudioFormatFields(format, prefix: "aggregateInput\(index)")
            ) { _, new in new }
        }
        for (index, format) in aggregateOutputFormats.enumerated() {
            startTraceMetadata.merge(
                avAudioFormatFields(format, prefix: "aggregateOutput\(index)")
            ) { _, new in new }
        }
        traceWriter?.record(
            event: "system_capture_started",
            metadata: startTraceMetadata
        )

        var ioProcID: AudioDeviceIOProcID?
        try coreAudioCheck(
            AudioDeviceCreateIOProcIDWithBlock(
                &ioProcID,
                aggregateDeviceID,
                nil
            ) { [weak self] now, inputData, inputTime, outputData, outputTime in
                self?.handle(
                    now: now,
                    inputData: inputData,
                    inputTime: inputTime,
                    outputData: outputData,
                    outputTime: outputTime
                )
            },
            operation: "AudioDeviceCreateIOProcIDWithBlock"
        )

        guard let ioProcID else {
            throw CaptureError.unsupportedSystemAudioCapture
        }

        self.ioProcID = ioProcID
        try coreAudioCheck(
            AudioDeviceStart(aggregateDeviceID, ioProcID),
            operation: "AudioDeviceStart"
        )
        Logger.info("System audio capture started")
    }

    func stop() async {
        if aggregateDeviceID != kAudioObjectUnknown, let ioProcID {
            let stopStatus = AudioDeviceStop(aggregateDeviceID, ioProcID)
            if stopStatus != noErr {
                Logger.error("AudioDeviceStop failed: \(stopStatus)")
            }
        }

        if aggregateDeviceID != kAudioObjectUnknown, let ioProcID {
            let destroyIOStatus = AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
            if destroyIOStatus != noErr {
                Logger.error("AudioDeviceDestroyIOProcID failed: \(destroyIOStatus)")
            }
        }

        if aggregateDeviceID != kAudioObjectUnknown {
            let destroyAggregateStatus = AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            if destroyAggregateStatus != noErr {
                Logger.error("AudioHardwareDestroyAggregateDevice failed: \(destroyAggregateStatus)")
            }
        }

        if tapID != kAudioObjectUnknown {
            if #available(macOS 14.2, *) {
                let destroyTapStatus = AudioHardwareDestroyProcessTap(tapID)
                if destroyTapStatus != noErr {
                    Logger.error("AudioHardwareDestroyProcessTap failed: \(destroyTapStatus)")
                }
            }
        }

        processingQueue.sync {}
        ioProcID = nil
        aggregateDeviceID = kAudioObjectUnknown
        tapID = kAudioObjectUnknown
        sourceFormat = nil
        sourceSampleRate = nil
        aggregateInputFormats = []
        aggregateOutputFormats = []
        aggregateDeviceSampleRate = nil

        do {
            let stopHostTime = mach_absolute_time()
            try appendDebugSilenceUntilStop(hostTime: stopHostTime)
            try preResampleDebugWriter?.finalize()
            try postResampleDebugWriter?.finalize()
        } catch {
            Logger.error("Failed to finalize debug audio files: \(error.localizedDescription)")
        }

        debugCaptureStartHostTime = nil
        preResampleDebugTracker = nil
        postResampleDebugTracker = nil
        preResampleDebugEndSampleIndex = 0
        postResampleDebugEndSampleIndex = 0

        Logger.info("System audio capture stopped")
    }

    @available(macOS 14.2, *)
    fileprivate func makeAggregateDeviceDescription(
        outputDeviceUID: String,
        inputDeviceUID: String? = nil
    ) -> [String: Any] {
        var subDevices: [[String: Any]] = [
            [kAudioSubDeviceUIDKey: outputDeviceUID]
        ]

        if let inputDeviceUID {
            subDevices.append([
                kAudioSubDeviceUIDKey: inputDeviceUID,
                kAudioSubDeviceDriftCompensationKey: 1,
                kAudioSubDeviceDriftCompensationQualityKey: kAudioAggregateDriftCompensationHighQuality
            ])
        }

        return [
            kAudioAggregateDeviceNameKey: "System Audio Capture",
            kAudioAggregateDeviceUIDKey: "ai.prismical.audio-capture.aggregate.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: 1,
            kAudioAggregateDeviceTapAutoStartKey: 1,
            kAudioAggregateDeviceSubDeviceListKey: subDevices,
            kAudioAggregateDeviceMainSubDeviceKey: outputDeviceUID
        ]
    }
}
