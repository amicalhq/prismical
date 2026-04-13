import AudioToolbox
import Foundation

// Owns the HAL microphone AudioUnit lifecycle and forwards raw float samples upstream.

final class MicrophoneCapture {
    private let onSamples: NormalizedSampleHandler
    private let traceWriter: CaptureTraceWriter?
    private let processingQueue = DispatchQueue(label: "ai.prismical.audio-capture.microphone.processing")
    private var audioUnit: AudioUnit?
    private var renderErrorLogCount = 0
    private var callbackSequence: UInt64 = 0

    init(
        traceWriter: CaptureTraceWriter? = nil,
        onSamples: @escaping NormalizedSampleHandler
    ) {
        self.traceWriter = traceWriter
        self.onSamples = onSamples
    }

    func start() throws {
        let inputDeviceID = try getDefaultInputDeviceID()
        let inputDeviceUID = try? getDefaultInputDeviceUID()

        var description = AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0
        )

        guard let component = AudioComponentFindNext(nil, &description) else {
            throw CaptureError.microphoneUnavailable
        }

        var audioUnit: AudioUnit?
        try coreAudioCheck(
            AudioComponentInstanceNew(component, &audioUnit),
            operation: "AudioComponentInstanceNew(microphone)"
        )
        guard let audioUnit else {
            throw CaptureError.microphoneUnavailable
        }

        var enableInput: UInt32 = 1
        var disableOutput: UInt32 = 0
        try coreAudioCheck(
            AudioUnitSetProperty(
                audioUnit,
                kAudioOutputUnitProperty_EnableIO,
                kAudioUnitScope_Input,
                1,
                &enableInput,
                UInt32(MemoryLayout<UInt32>.size)
            ),
            operation: "AudioUnitSetProperty(EnableIO input)"
        )
        try coreAudioCheck(
            AudioUnitSetProperty(
                audioUnit,
                kAudioOutputUnitProperty_EnableIO,
                kAudioUnitScope_Output,
                0,
                &disableOutput,
                UInt32(MemoryLayout<UInt32>.size)
            ),
            operation: "AudioUnitSetProperty(EnableIO output)"
        )

        var mutableInputDeviceID = inputDeviceID
        try coreAudioCheck(
            AudioUnitSetProperty(
                audioUnit,
                kAudioOutputUnitProperty_CurrentDevice,
                kAudioUnitScope_Global,
                0,
                &mutableInputDeviceID,
                UInt32(MemoryLayout<AudioDeviceID>.size)
            ),
            operation: "AudioUnitSetProperty(CurrentDevice input)"
        )

        var callback = AURenderCallbackStruct(
            inputProc: microphoneInputCallback,
            inputProcRefCon: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        )
        try coreAudioCheck(
            AudioUnitSetProperty(
                audioUnit,
                kAudioOutputUnitProperty_SetInputCallback,
                kAudioUnitScope_Global,
                0,
                &callback,
                UInt32(MemoryLayout<AURenderCallbackStruct>.size)
            ),
            operation: "AudioUnitSetProperty(SetInputCallback)"
        )

        var clientFormat = AudioStreamBasicDescription(
            mSampleRate: 48_000,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0
        )
        try coreAudioCheck(
            AudioUnitSetProperty(
                audioUnit,
                kAudioUnitProperty_StreamFormat,
                kAudioUnitScope_Output,
                1,
                &clientFormat,
                UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
            ),
            operation: "AudioUnitSetProperty(StreamFormat microphone)"
        )

        try coreAudioCheck(AudioUnitInitialize(audioUnit), operation: "AudioUnitInitialize(microphone)")
        try coreAudioCheck(AudioOutputUnitStart(audioUnit), operation: "AudioOutputUnitStart(microphone)")
        self.audioUnit = audioUnit
        traceWriter?.record(
            event: "microphone_capture_started",
            metadata: nonNilTraceFields([
                ("inputDeviceID", Int(inputDeviceID)),
                ("inputDeviceUID", inputDeviceUID),
                ("sampleRate", 48_000),
                ("channels", 1),
                ("format", "float32")
            ])
        )
        Logger.info("Microphone capture started")
    }

    func stop() {
        guard let audioUnit else { return }

        let stopStatus = AudioOutputUnitStop(audioUnit)
        if stopStatus != noErr {
            Logger.error("AudioOutputUnitStop(microphone) failed: \(stopStatus)")
        }

        let uninitializeStatus = AudioUnitUninitialize(audioUnit)
        if uninitializeStatus != noErr {
            Logger.error("AudioUnitUninitialize(microphone) failed: \(uninitializeStatus)")
        }

        let disposeStatus = AudioComponentInstanceDispose(audioUnit)
        if disposeStatus != noErr {
            Logger.error("AudioComponentInstanceDispose(microphone) failed: \(disposeStatus)")
        }

        processingQueue.sync {}
        self.audioUnit = nil
        Logger.info("Microphone capture stopped")
    }

    fileprivate func handleInput(
        ioActionFlags: UnsafeMutablePointer<AudioUnitRenderActionFlags>,
        timeStamp: UnsafePointer<AudioTimeStamp>,
        busNumber _: UInt32,
        numberFrames: UInt32
    ) -> OSStatus {
        guard let audioUnit else { return noErr }

        let sampleCount = Int(numberFrames)
        guard sampleCount > 0 else { return noErr }

        let byteCount = sampleCount * MemoryLayout<Float>.size
        let rawData = UnsafeMutableRawPointer.allocate(
            byteCount: byteCount,
            alignment: MemoryLayout<Float>.alignment
        )
        defer { rawData.deallocate() }

        let audioBuffer = AudioBuffer(
            mNumberChannels: 1,
            mDataByteSize: UInt32(byteCount),
            mData: rawData
        )
        var bufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: audioBuffer
        )

        let status = withUnsafeMutablePointer(to: &bufferList) { bufferListPointer in
            AudioUnitRender(
                audioUnit,
                ioActionFlags,
                timeStamp,
                1,
                numberFrames,
                bufferListPointer
            )
        }

        guard status == noErr else {
            if renderErrorLogCount < 8 {
                renderErrorLogCount += 1
                Logger.error("AudioUnitRender(microphone) failed: \(status)")
            }
            return noErr
        }

        let samplesPointer = rawData.assumingMemoryBound(to: Float.self)
        let samples = Array(UnsafeBufferPointer(start: samplesPointer, count: sampleCount))
        let hostTime = timeStamp.pointee.mHostTime > 0 ? timeStamp.pointee.mHostTime : nil
        let callbackSequence = self.callbackSequence
        self.callbackSequence &+= 1
        traceWriter?.recordSamples(
            event: "mic_audio_unit_callback",
            channel: "mic-audio-unit-raw",
            samples: samples,
            metadata: nonNilTraceFields([
                ("callbackSequence", Int64(callbackSequence)),
                ("numberFrames", Int(numberFrames)),
                ("sampleCount", sampleCount),
                ("hostTime", hostTime.map(Int64.init)),
                ("sampleTime", timeStamp.pointee.mSampleTime),
                ("timeFlags", Int(timeStamp.pointee.mFlags.rawValue))
            ])
        )
        processingQueue.async { [onSamples] in
            onSamples(samples, hostTime)
        }
        return noErr
    }
}

private let microphoneInputCallback: AURenderCallback = { inRefCon, ioActionFlags, inTimeStamp, inBusNumber, inNumberFrames, _ in
    let capture = Unmanaged<MicrophoneCapture>.fromOpaque(inRefCon).takeUnretainedValue()
    return capture.handleInput(
        ioActionFlags: ioActionFlags,
        timeStamp: inTimeStamp,
        busNumber: inBusNumber,
        numberFrames: inNumberFrames
    )
}
