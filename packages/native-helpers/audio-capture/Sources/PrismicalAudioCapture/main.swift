import AVFoundation
import CoreMedia
import CoreAudio
import Foundation
import PrismicalAec3Bridge

enum CaptureMode: String {
    case mic
    case system
    case dual
}

enum CaptureSource: UInt8 {
    case micRaw = 1
    case system = 2
    case micProcessed = 3
}

enum PacketFormat: UInt8 {
    case float32LE = 1
}

enum CaptureError: Error, LocalizedError {
    case invalidArguments
    case microphoneUnavailable
    case unsupportedSystemAudioCapture
    case unsupportedSystemAudioBuffer
    case unsupportedSystemAudioOSVersion
    case coreAudioOperationFailed(String, OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Invalid arguments. Use --mode mic|system|dual."
        case .microphoneUnavailable:
            return "Microphone input is unavailable."
        case .unsupportedSystemAudioCapture:
            return "System audio capture is unavailable with the current Core Audio tap configuration."
        case .unsupportedSystemAudioBuffer:
            return "Unsupported system audio buffer format."
        case .unsupportedSystemAudioOSVersion:
            return "System audio capture via Core Audio taps requires macOS 14.2 or newer."
        case .coreAudioOperationFailed(let operation, let status):
            let description = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "\(operation) failed: \(description)"
        }
    }
}

final class Logger {
    static func info(_ message: String) {
        write("[prismical-audio-capture] \(message)\n")
    }

    static func error(_ message: String) {
        write("[prismical-audio-capture] ERROR: \(message)\n")
    }

    private static func write(_ value: String) {
        guard let data = value.data(using: .utf8) else { return }
        FileHandle.standardError.write(data)
    }
}

func makePropertyAddress(
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: scope,
        mElement: element
    )
}

func coreAudioCheck(_ status: OSStatus, operation: String) throws {
    guard status == noErr else {
        throw CaptureError.coreAudioOperationFailed(operation, status)
    }
}

func getAudioObjectProperty<T>(
    objectID: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain,
    type: T.Type = T.self
) throws -> T {
    var address = makePropertyAddress(selector: selector, scope: scope, element: element)
    var dataSize = UInt32(MemoryLayout<T>.size)
    let rawPointer = UnsafeMutableRawPointer.allocate(
        byteCount: Int(dataSize),
        alignment: max(MemoryLayout<T>.alignment, 8)
    )
    defer { rawPointer.deallocate() }

    rawPointer.initializeMemory(as: UInt8.self, repeating: 0, count: Int(dataSize))

    try coreAudioCheck(
        AudioObjectGetPropertyData(
            objectID,
            &address,
            0,
            nil,
            &dataSize,
            rawPointer
        ),
        operation: "AudioObjectGetPropertyData(\(selector))"
    )

    guard Int(dataSize) == MemoryLayout<T>.size else {
        throw CaptureError.unsupportedSystemAudioCapture
    }

    return rawPointer.load(as: T.self)
}

func getAudioObjectArrayProperty<T>(
    objectID: AudioObjectID,
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain,
    type: T.Type = T.self
) throws -> [T] {
    var address = makePropertyAddress(selector: selector, scope: scope, element: element)
    var dataSize: UInt32 = 0

    try coreAudioCheck(
        AudioObjectGetPropertyDataSize(objectID, &address, 0, nil, &dataSize),
        operation: "AudioObjectGetPropertyDataSize(\(selector))"
    )

    let count = Int(dataSize) / MemoryLayout<T>.stride
    guard count > 0 else { return [] }

    let pointer = UnsafeMutablePointer<T>.allocate(capacity: count)
    defer { pointer.deallocate() }

    try coreAudioCheck(
        AudioObjectGetPropertyData(
            objectID,
            &address,
            0,
            nil,
            &dataSize,
            pointer
        ),
        operation: "AudioObjectGetPropertyData(\(selector))"
    )

    return Array(UnsafeBufferPointer(start: pointer, count: count))
}

func getAudioObjectStringProperty(
    objectID: AudioObjectID,
    selector: AudioObjectPropertySelector
) throws -> String {
    var rawValue: CFString = "" as CFString
    var address = makePropertyAddress(selector: selector)
    var dataSize = UInt32(MemoryLayout<CFString>.size)

    try withUnsafeMutablePointer(to: &rawValue) { pointer in
        try coreAudioCheck(
            AudioObjectGetPropertyData(
                objectID,
                &address,
                0,
                nil,
                &dataSize,
                pointer
            ),
            operation: "AudioObjectGetPropertyData(\(selector))"
        )
    }

    return rawValue as String
}

func getCurrentProcessObjectID() -> AudioObjectID? {
    let processID = Int32(getpid())
    guard let processObjects = try? getAudioObjectArrayProperty(
        objectID: AudioObjectID(kAudioObjectSystemObject),
        selector: kAudioHardwarePropertyProcessObjectList,
        type: AudioObjectID.self
    ) else {
        return nil
    }

    for processObjectID in processObjects {
        guard let activePID: pid_t = try? getAudioObjectProperty(
            objectID: processObjectID,
            selector: kAudioProcessPropertyPID,
            type: pid_t.self
        ) else {
            continue
        }

        if activePID == processID {
            return processObjectID
        }
    }

    return nil
}

func getDefaultOutputDeviceUID() throws -> String {
    let outputDeviceID: AudioObjectID = try getAudioObjectProperty(
        objectID: AudioObjectID(kAudioObjectSystemObject),
        selector: kAudioHardwarePropertyDefaultOutputDevice,
        type: AudioObjectID.self
    )

    guard outputDeviceID != kAudioObjectUnknown else {
        throw CaptureError.unsupportedSystemAudioCapture
    }

    return try getAudioObjectStringProperty(
        objectID: outputDeviceID,
        selector: kAudioDevicePropertyDeviceUID
    )
}

func getDefaultInputDeviceUID() throws -> String {
    let inputDeviceID: AudioObjectID = try getAudioObjectProperty(
        objectID: AudioObjectID(kAudioObjectSystemObject),
        selector: kAudioHardwarePropertyDefaultInputDevice,
        type: AudioObjectID.self
    )

    guard inputDeviceID != kAudioObjectUnknown else {
        throw CaptureError.microphoneUnavailable
    }

    return try getAudioObjectStringProperty(
        objectID: inputDeviceID,
        selector: kAudioDevicePropertyDeviceUID
    )
}

func getDeviceStreamFormats(
    deviceID: AudioObjectID,
    scope: AudioObjectPropertyScope
) throws -> [AVAudioFormat] {
    let streamIDs: [AudioObjectID] = try getAudioObjectArrayProperty(
        objectID: deviceID,
        selector: kAudioDevicePropertyStreams,
        scope: scope,
        type: AudioObjectID.self
    )

    guard !streamIDs.isEmpty else {
        throw CaptureError.unsupportedSystemAudioCapture
    }

    return try streamIDs.map { streamID in
        var streamFormatDescription: AudioStreamBasicDescription = try getAudioObjectProperty(
            objectID: streamID,
            selector: kAudioStreamPropertyVirtualFormat,
            type: AudioStreamBasicDescription.self
        )

        guard let streamFormat = AVAudioFormat(streamDescription: &streamFormatDescription) else {
            throw CaptureError.unsupportedSystemAudioBuffer
        }

        return streamFormat
    }
}

func attachTapToAggregateDevice(
    aggregateDeviceID: AudioObjectID,
    tapUID: String
) throws {
    var address = makePropertyAddress(selector: kAudioAggregateDevicePropertyTapList)
    var propertySize: UInt32 = 0
    let sizeStatus = AudioObjectGetPropertyDataSize(
        aggregateDeviceID,
        &address,
        0,
        nil,
        &propertySize
    )

    if sizeStatus != noErr && sizeStatus != kAudioHardwareUnknownPropertyError {
        throw CaptureError.coreAudioOperationFailed(
            "AudioObjectGetPropertyDataSize(\(kAudioAggregateDevicePropertyTapList))",
            sizeStatus
        )
    }

    var tapList: CFArray? = nil
    if propertySize > 0 {
        try withUnsafeMutablePointer(to: &tapList) { pointer in
            try coreAudioCheck(
                AudioObjectGetPropertyData(
                    aggregateDeviceID,
                    &address,
                    0,
                    nil,
                    &propertySize,
                    pointer
                ),
                operation: "AudioObjectGetPropertyData(\(kAudioAggregateDevicePropertyTapList))"
            )
        }
    }

    var tapUIDs = (tapList as? [CFString]) ?? []
    let targetUID = tapUID as CFString
    if !tapUIDs.contains(targetUID) {
        tapUIDs.append(targetUID)
    }

    var updatedTapList: CFArray = tapUIDs as CFArray
    propertySize = UInt32(MemoryLayout<CFString>.stride * tapUIDs.count)
    try withUnsafeMutablePointer(to: &updatedTapList) { pointer in
        try coreAudioCheck(
            AudioObjectSetPropertyData(
                aggregateDeviceID,
                &address,
                0,
                nil,
                propertySize,
                pointer
            ),
            operation: "AudioObjectSetPropertyData(\(kAudioAggregateDevicePropertyTapList))"
        )
    }
}

func totalAudioBufferListBytes(_ bufferList: UnsafePointer<AudioBufferList>?) -> Int {
    guard let bufferList else { return 0 }
    let buffers = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: bufferList)
    )
    return buffers.reduce(0) { total, buffer in
        total + Int(buffer.mDataByteSize)
    }
}

func audioBufferListCount(_ bufferList: UnsafePointer<AudioBufferList>?) -> Int {
    guard let bufferList else { return 0 }
    let buffers = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: bufferList)
    )
    return buffers.count
}

final class CopiedAudioBufferList {
    let pointer: UnsafeMutablePointer<AudioBufferList>

    init?(source: UnsafePointer<AudioBufferList>) {
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: source)
        )
        guard !sourceBuffers.isEmpty else { return nil }

        let rawSize =
            MemoryLayout<AudioBufferList>.size +
            max(0, sourceBuffers.count - 1) * MemoryLayout<AudioBuffer>.stride
        let rawPointer = UnsafeMutableRawPointer.allocate(
            byteCount: rawSize,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        rawPointer.initializeMemory(as: UInt8.self, repeating: 0, count: rawSize)

        let pointer = rawPointer.bindMemory(to: AudioBufferList.self, capacity: 1)
        pointer.pointee.mNumberBuffers = UInt32(sourceBuffers.count)
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(pointer)

        for (index, sourceBuffer) in sourceBuffers.enumerated() {
            let byteCount = Int(sourceBuffer.mDataByteSize)
            let destinationData = UnsafeMutableRawPointer.allocate(
                byteCount: max(byteCount, 1),
                alignment: 16
            )

            if let sourceData = sourceBuffer.mData, byteCount > 0 {
                destinationData.copyMemory(from: sourceData, byteCount: byteCount)
            } else if byteCount > 0 {
                destinationData.initializeMemory(as: UInt8.self, repeating: 0, count: byteCount)
            }

            destinationBuffers[index] = AudioBuffer(
                mNumberChannels: sourceBuffer.mNumberChannels,
                mDataByteSize: sourceBuffer.mDataByteSize,
                mData: destinationData
            )
        }

        self.pointer = pointer
    }

    init?(sourceBuffer: AudioBuffer) {
        let rawPointer = UnsafeMutableRawPointer.allocate(
            byteCount: MemoryLayout<AudioBufferList>.size,
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        rawPointer.initializeMemory(
            as: UInt8.self,
            repeating: 0,
            count: MemoryLayout<AudioBufferList>.size
        )

        let pointer = rawPointer.bindMemory(to: AudioBufferList.self, capacity: 1)
        pointer.pointee.mNumberBuffers = 1
        let destinationBuffers = UnsafeMutableAudioBufferListPointer(pointer)

        let byteCount = Int(sourceBuffer.mDataByteSize)
        let destinationData = UnsafeMutableRawPointer.allocate(
            byteCount: max(byteCount, 1),
            alignment: 16
        )

        if let sourceData = sourceBuffer.mData, byteCount > 0 {
            destinationData.copyMemory(from: sourceData, byteCount: byteCount)
        } else if byteCount > 0 {
            destinationData.initializeMemory(as: UInt8.self, repeating: 0, count: byteCount)
        }

        destinationBuffers[0] = AudioBuffer(
            mNumberChannels: sourceBuffer.mNumberChannels,
            mDataByteSize: sourceBuffer.mDataByteSize,
            mData: destinationData
        )

        self.pointer = pointer
    }

    deinit {
        let buffers = UnsafeMutableAudioBufferListPointer(pointer)
        for buffer in buffers where buffer.mData != nil {
            buffer.mData?.deallocate()
        }
        pointer.deallocate()
    }
}

func commonFormat(from streamDescription: AudioStreamBasicDescription) -> AVAudioCommonFormat? {
    guard streamDescription.mFormatID == kAudioFormatLinearPCM else {
        return nil
    }

    if streamDescription.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
        return streamDescription.mBitsPerChannel == 64 ? .pcmFormatFloat64 : .pcmFormatFloat32
    }

    switch streamDescription.mBitsPerChannel {
    case 16:
        return .pcmFormatInt16
    case 32:
        return .pcmFormatInt32
    default:
        return nil
    }
}

func commonFormatName(_ format: AVAudioCommonFormat) -> String {
    switch format {
    case .pcmFormatFloat32:
        return "float32"
    case .pcmFormatFloat64:
        return "float64"
    case .pcmFormatInt16:
        return "int16"
    case .pcmFormatInt32:
        return "int32"
    default:
        return "other"
    }
}

func normalizeInt16(_ value: Int16) -> Float {
    Float(value) / 32768.0
}

func normalizeInt32(_ value: Int32) -> Float {
    Float(value) / 2147483648.0
}

func extractMonoSamples(
    from bufferList: UnsafeMutableAudioBufferListPointer,
    commonFormat: AVAudioCommonFormat,
    channelCount: Int,
    interleaved: Bool
) -> [Float]? {
    guard channelCount > 0 else { return nil }
    guard let firstBuffer = bufferList.first else { return nil }

    let bytesPerSample: Int
    switch commonFormat {
    case .pcmFormatFloat32:
        bytesPerSample = MemoryLayout<Float>.size
    case .pcmFormatFloat64:
        bytesPerSample = MemoryLayout<Double>.size
    case .pcmFormatInt16:
        bytesPerSample = MemoryLayout<Int16>.size
    case .pcmFormatInt32:
        bytesPerSample = MemoryLayout<Int32>.size
    default:
        return nil
    }

    let frameCount: Int
    if interleaved {
        frameCount = Int(firstBuffer.mDataByteSize) / max(bytesPerSample * channelCount, 1)
    } else {
        frameCount = Int(firstBuffer.mDataByteSize) / bytesPerSample
    }

    guard frameCount > 0 else { return nil }
    var output = Array(repeating: Float.zero, count: frameCount)

    switch commonFormat {
    case .pcmFormatFloat32:
        if interleaved {
            guard let data = firstBuffer.mData?.assumingMemoryBound(to: Float.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                let baseIndex = frameIndex * channelCount
                output[frameIndex] = data[baseIndex]
            }
        } else {
            guard let data = bufferList[0].mData?.assumingMemoryBound(to: Float.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                output[frameIndex] = data[frameIndex]
            }
        }
    case .pcmFormatFloat64:
        if interleaved {
            guard let data = firstBuffer.mData?.assumingMemoryBound(to: Double.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                let baseIndex = frameIndex * channelCount
                output[frameIndex] = Float(data[baseIndex])
            }
        } else {
            guard let data = bufferList[0].mData?.assumingMemoryBound(to: Double.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                output[frameIndex] = Float(data[frameIndex])
            }
        }
    case .pcmFormatInt16:
        if interleaved {
            guard let data = firstBuffer.mData?.assumingMemoryBound(to: Int16.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                let baseIndex = frameIndex * channelCount
                output[frameIndex] = normalizeInt16(data[baseIndex])
            }
        } else {
            guard let data = bufferList[0].mData?.assumingMemoryBound(to: Int16.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                output[frameIndex] = normalizeInt16(data[frameIndex])
            }
        }
    case .pcmFormatInt32:
        if interleaved {
            guard let data = firstBuffer.mData?.assumingMemoryBound(to: Int32.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                let baseIndex = frameIndex * channelCount
                output[frameIndex] = normalizeInt32(data[baseIndex])
            }
        } else {
            guard let data = bufferList[0].mData?.assumingMemoryBound(to: Int32.self) else {
                return nil
            }
            for frameIndex in 0..<frameCount {
                output[frameIndex] = normalizeInt32(data[frameIndex])
            }
        }
    default:
        return nil
    }

    return output
}

func resampleLinear(
    samples: [Float],
    from inputSampleRate: Double,
    to outputSampleRate: Double
) -> [Float] {
    guard !samples.isEmpty else { return [] }
    guard inputSampleRate > 0, outputSampleRate > 0 else { return samples }
    if abs(inputSampleRate - outputSampleRate) < 0.5 {
        return samples
    }

    let outputCount = max(
        1,
        Int((Double(samples.count) * outputSampleRate / inputSampleRate).rounded(.toNearestOrAwayFromZero))
    )
    var output = Array(repeating: Float.zero, count: outputCount)
    let step = inputSampleRate / outputSampleRate

    for outputIndex in 0..<outputCount {
        let sourcePosition = Double(outputIndex) * step
        let lowerIndex = min(Int(sourcePosition), samples.count - 1)
        let upperIndex = min(lowerIndex + 1, samples.count - 1)
        let fraction = Float(sourcePosition - Double(lowerIndex))
        let lowerValue = samples[lowerIndex]
        let upperValue = samples[upperIndex]
        output[outputIndex] = lowerValue + (upperValue - lowerValue) * fraction
    }

    return output
}

final class PacketWriter {
    private let output = FileHandle.standardOutput
    private let lock = NSLock()
    private let startedAt = DispatchTime.now().uptimeNanoseconds
    private var sequences: [CaptureSource: UInt32] = [
        .micRaw: 0,
        .system: 0,
        .micProcessed: 0
    ]

    func write(source: CaptureSource, samples: [Float], sampleRate: UInt32 = 48_000, channels: UInt8 = 1) {
        guard !samples.isEmpty else { return }

        let timestampMs = UInt64((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
        let durationMs = UInt32((Double(samples.count) / Double(sampleRate)) * 1000.0)
        let sequenceNum = sequences[source, default: 0]
        sequences[source] = sequenceNum &+ 1

        let payload = samples.withUnsafeBufferPointer { buffer in
            Data(buffer: buffer)
        }

        var header = Data(count: 32)
        header[0] = 1
        header[1] = source.rawValue
        header[2] = PacketFormat.float32LE.rawValue
        header[3] = channels
        writeUInt32(&header, sampleRate, at: 4)
        writeUInt32(&header, sequenceNum, at: 8)
        writeUInt32(&header, durationMs, at: 12)
        writeUInt64(&header, timestampMs, at: 16)
        writeUInt32(&header, UInt32(payload.count), at: 24)
        writeUInt32(&header, 0, at: 28)

        lock.lock()
        defer { lock.unlock() }

        output.write(header)
        output.write(payload)
    }

    private func writeUInt32(_ data: inout Data, _ value: UInt32, at offset: Int) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { bytes in
            data.replaceSubrange(offset..<(offset + 4), with: bytes)
        }
    }

    private func writeUInt64(_ data: inout Data, _ value: UInt64, at offset: Int) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { bytes in
            data.replaceSubrange(offset..<(offset + 8), with: bytes)
        }
    }
}

typealias NormalizedSampleHandler = ([Float]) -> Void

final class Aec3Bridge {
    private let sampleRate: Int
    private let channels: Int
    private var handle: UnsafeMutableRawPointer?

    init(sampleRate: Int = 48_000, channels: Int = 1) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.handle = prismical_aec3_create(Int32(sampleRate), Int32(channels))
    }

    deinit {
        guard let handle else { return }
        prismical_aec3_destroy(handle)
    }

    var isReal: Bool {
        prismical_aec3_is_real() != 0
    }

    func analyzeRender(_ frame: [Float]) {
        guard let handle, !frame.isEmpty else { return }
        frame.withUnsafeBufferPointer { buffer in
            prismical_aec3_analyze_render(handle, buffer.baseAddress, Int32(buffer.count))
        }
    }

    func processCapture(_ frame: [Float]) -> [Float] {
        guard let handle, !frame.isEmpty else { return frame }

        var output = Array(repeating: Float.zero, count: frame.count)
        frame.withUnsafeBufferPointer { inputBuffer in
            output.withUnsafeMutableBufferPointer { outputBuffer in
                prismical_aec3_process_capture(
                    handle,
                    inputBuffer.baseAddress,
                    outputBuffer.baseAddress,
                    Int32(frame.count)
                )
            }
        }
        return output
    }

    func reset() {
        guard let handle else { return }
        prismical_aec3_reset(handle)
    }
}

final class FixedFrameAecProcessor {
    static let sampleRate = 48_000
    static let frameSize = 480

    private let bridge: Aec3Bridge
    private var renderRemainder: [Float] = []
    private var captureRemainder: [Float] = []

    init(bridge: Aec3Bridge = Aec3Bridge()) {
        self.bridge = bridge
    }

    var isReal: Bool {
        bridge.isReal
    }

    func ingestRender(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        renderRemainder.append(contentsOf: samples)

        while renderRemainder.count >= Self.frameSize {
            let frame = Array(renderRemainder.prefix(Self.frameSize))
            renderRemainder.removeFirst(Self.frameSize)
            bridge.analyzeRender(frame)
        }
    }

    func processCapture(_ samples: [Float]) -> [[Float]] {
        guard !samples.isEmpty else { return [] }

        captureRemainder.append(contentsOf: samples)
        var processedFrames: [[Float]] = []

        while captureRemainder.count >= Self.frameSize {
            let frame = Array(captureRemainder.prefix(Self.frameSize))
            captureRemainder.removeFirst(Self.frameSize)
            processedFrames.append(bridge.processCapture(frame))
        }

        return processedFrames
    }

    func flushCaptureRemainder() -> [Float]? {
        guard !captureRemainder.isEmpty else { return nil }

        let originalCount = captureRemainder.count
        let paddedCount = Self.frameSize - originalCount
        let paddedFrame = captureRemainder + Array(repeating: Float.zero, count: paddedCount)
        captureRemainder.removeAll(keepingCapacity: true)

        let processed = bridge.processCapture(paddedFrame)
        return Array(processed.prefix(originalCount))
    }

    func reset() {
        renderRemainder.removeAll(keepingCapacity: true)
        captureRemainder.removeAll(keepingCapacity: true)
        bridge.reset()
    }
}

final class DebugWavWriter {
    private let url: URL
    private let sampleRate: UInt32
    private let channels: UInt16
    private var handle: FileHandle?
    private var dataSize: UInt32 = 0
    private var isFinalized = false

    init?(filePath: String, sampleRate: UInt32, channels: UInt16 = 1) {
        self.url = URL(fileURLWithPath: filePath)
        self.sampleRate = sampleRate
        self.channels = channels

        let directoryURL = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true
            )

            FileManager.default.createFile(atPath: url.path, contents: nil)
            let handle = try FileHandle(forWritingTo: url)
            self.handle = handle
            try writeHeader()
            Logger.info("Debug audio file initialized: \(url.path)")
        } catch {
            Logger.error("Failed to initialize debug WAV writer at \(url.path): \(error.localizedDescription)")
            self.handle = nil
            return nil
        }
    }

    deinit {
        try? finalize()
    }

    func append(samples: [Float]) throws {
        guard !samples.isEmpty else { return }
        guard !isFinalized, let handle else { return }

        var pcmData = Data(capacity: samples.count * 2)
        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            let intValue = Int16((clamped * 32767.0).rounded(.towardZero))
            var littleEndian = intValue.littleEndian
            withUnsafeBytes(of: &littleEndian) { bytes in
                pcmData.append(contentsOf: bytes)
            }
        }

        try handle.write(contentsOf: pcmData)
        dataSize += UInt32(pcmData.count)
    }

    func finalize() throws {
        guard !isFinalized else { return }
        isFinalized = true
        guard let handle else { return }

        try handle.synchronize()
        try handle.seek(toOffset: 0)
        try writeHeader()
        try handle.close()
        self.handle = nil

        Logger.info(
            "Debug audio file finalized: path=\(url.path) dataSize=\(dataSize) duration=\(Double(dataSize) / Double(sampleRate * UInt32(channels) * 2))"
        )
    }

    private func writeHeader() throws {
        guard let handle else { return }

        var header = Data(count: 44)
        header.replaceSubrange(0..<4, with: Data("RIFF".utf8))
        writeUInt32(&header, dataSize + 36, at: 4)
        header.replaceSubrange(8..<12, with: Data("WAVE".utf8))
        header.replaceSubrange(12..<16, with: Data("fmt ".utf8))
        writeUInt32(&header, 16, at: 16)
        writeUInt16(&header, 1, at: 20)
        writeUInt16(&header, channels, at: 22)
        writeUInt32(&header, sampleRate, at: 24)
        writeUInt32(&header, sampleRate * UInt32(channels) * 2, at: 28)
        writeUInt16(&header, channels * 2, at: 32)
        writeUInt16(&header, 16, at: 34)
        header.replaceSubrange(36..<40, with: Data("data".utf8))
        writeUInt32(&header, dataSize, at: 40)

        try handle.write(contentsOf: header)
    }

    private func writeUInt16(_ data: inout Data, _ value: UInt16, at offset: Int) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { bytes in
            data.replaceSubrange(offset..<(offset + 2), with: bytes)
        }
    }

    private func writeUInt32(_ data: inout Data, _ value: UInt32, at offset: Int) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { bytes in
            data.replaceSubrange(offset..<(offset + 4), with: bytes)
        }
    }
}

final class MicrophoneCapture {
    private let engine = AVAudioEngine()
    private let onSamples: NormalizedSampleHandler
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?

    init(onSamples: @escaping NormalizedSampleHandler) {
        self.onSamples = onSamples
    }

    func start() throws {
        let inputNode = engine.inputNode
        let inputFormat = inputNode.inputFormat(forBus: 0)

        guard inputFormat.channelCount > 0 else {
            throw CaptureError.microphoneUnavailable
        }

        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw CaptureError.microphoneUnavailable
        }

        self.converter = converter

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.handle(buffer: buffer)
        }

        engine.prepare()
        try engine.start()
        Logger.info("Microphone capture started")
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        Logger.info("Microphone capture stopped")
    }

    private func handle(buffer: AVAudioPCMBuffer) {
        guard let converter else { return }

        let estimatedOutputFrames = max(
            AVAudioFrameCount(Double(buffer.frameLength) * (targetFormat.sampleRate / buffer.format.sampleRate)) + 128,
            512
        )

        guard let convertedBuffer = AVAudioPCMBuffer(
            pcmFormat: targetFormat,
            frameCapacity: estimatedOutputFrames
        ) else {
            return
        }

        var didProvideInput = false
        var conversionError: NSError?

        let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
            if didProvideInput {
                outStatus.pointee = .noDataNow
                return nil
            }

            didProvideInput = true
            outStatus.pointee = .haveData
            return buffer
        }

        let status = converter.convert(to: convertedBuffer, error: &conversionError, withInputFrom: inputBlock)
        if let conversionError {
            Logger.error("Microphone conversion failed: \(conversionError.localizedDescription)")
            return
        }

        guard status == .haveData || status == .inputRanDry else { return }
        guard let channelData = convertedBuffer.floatChannelData?[0] else { return }

        let frameLength = Int(convertedBuffer.frameLength)
        let samples = Array(UnsafeBufferPointer(start: channelData, count: frameLength))
        onSamples(samples)
    }
}

final class SystemAudioCapture {
    private let onSamples: NormalizedSampleHandler
    private let onMicrophoneSamples: NormalizedSampleHandler?
    private let captureAggregateInput: Bool
    private let processingQueue = DispatchQueue(label: "ai.prismical.audio-capture.system.processing")
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    private let debugArtifactsDirectory: String?
    private var sourceFormat: AVAudioFormat?
    private var sourceSampleRate: Double?
    private var aggregateInputFormats: [AVAudioFormat] = []
    private var aggregateOutputFormats: [AVAudioFormat] = []
    private var aggregateDeviceSampleRate: Double?
    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    private var ioProcID: AudioDeviceIOProcID?
    private var callbackLogCount = 0
    private var preResampleDebugWriter: DebugWavWriter?
    private var postResampleDebugWriter: DebugWavWriter?

    init(
        debugArtifactsDirectory: String? = nil,
        onSamples: @escaping NormalizedSampleHandler,
        onMicrophoneSamples: NormalizedSampleHandler? = nil
    ) {
        self.debugArtifactsDirectory = debugArtifactsDirectory
        self.onSamples = onSamples
        self.onMicrophoneSamples = onMicrophoneSamples
        self.captureAggregateInput = onMicrophoneSamples != nil
    }

    func start() async throws {
        guard #available(macOS 14.2, *) else {
            throw CaptureError.unsupportedSystemAudioOSVersion
        }

        Logger.info("System audio capture setup: begin")
        let excludedProcesses = getCurrentProcessObjectID().map { [$0] } ?? []
        Logger.info("System audio capture setup: resolved excluded processes count=\(excludedProcesses.count)")
        let tapDescription = CATapDescription(monoGlobalTapButExcludeProcesses: excludedProcesses)
        tapDescription.name = "Prismical System Audio Capture"
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

        var ioProcID: AudioDeviceIOProcID?
        try coreAudioCheck(
            AudioDeviceCreateIOProcIDWithBlock(
                &ioProcID,
                aggregateDeviceID,
                nil
            ) { [weak self] _, inputData, _, outputData, _ in
                self?.handle(inputData: inputData, outputData: outputData)
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

        ioProcID = nil
        aggregateDeviceID = kAudioObjectUnknown
        tapID = kAudioObjectUnknown
        sourceFormat = nil
        sourceSampleRate = nil
        aggregateInputFormats = []
        aggregateOutputFormats = []
        aggregateDeviceSampleRate = nil

        do {
            try preResampleDebugWriter?.finalize()
            try postResampleDebugWriter?.finalize()
        } catch {
            Logger.error("Failed to finalize debug audio files: \(error.localizedDescription)")
        }

        Logger.info("System audio capture stopped")
    }

    @available(macOS 14.2, *)
    private func makeAggregateDeviceDescription(
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
            kAudioAggregateDeviceNameKey: "Prismical System Audio Capture",
            kAudioAggregateDeviceUIDKey: "ai.prismical.audio-capture.aggregate.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: 1,
            kAudioAggregateDeviceTapAutoStartKey: 1,
            kAudioAggregateDeviceSubDeviceListKey: subDevices,
            kAudioAggregateDeviceMainSubDeviceKey: outputDeviceUID
        ]
    }

    private func handle(
        inputData: UnsafePointer<AudioBufferList>?,
        outputData: UnsafeMutablePointer<AudioBufferList>?
    ) {
        let inputBytes = totalAudioBufferListBytes(inputData)
        let inputBufferCount = audioBufferListCount(inputData)
        let outputBytes = totalAudioBufferListBytes(
            outputData.map { UnsafePointer<AudioBufferList>($0) }
        )
        let outputBufferCount = audioBufferListCount(
            outputData.map { UnsafePointer<AudioBufferList>($0) }
        )

        let selectedBufferList: UnsafePointer<AudioBufferList>? =
            inputBytes > 0
            ? inputData
            : outputData.map { UnsafePointer<AudioBufferList>($0) }
        let selectedSource =
            inputBytes > 0 ? "input" : (outputBytes > 0 ? "output" : "none")

        if callbackLogCount < 4 {
            callbackLogCount += 1
            Logger.info(
                "System audio callback: inputBytes=\(inputBytes) inputBuffers=\(inputBufferCount) outputBytes=\(outputBytes) outputBuffers=\(outputBufferCount) selected=\(selectedSource)"
            )
        }

        if captureAggregateInput,
           !aggregateInputFormats.isEmpty
        {
            let aggregateSampleRate =
                aggregateDeviceSampleRate ??
                aggregateInputFormats.first?.sampleRate ??
                aggregateOutputFormats.first?.sampleRate ??
                targetFormat.sampleRate

            if let onMicrophoneSamples,
               inputBytes > 0,
               let inputData
            {
                let inputBuffers = UnsafeMutableAudioBufferListPointer(
                    UnsafeMutablePointer(mutating: inputData)
                )

                if inputBuffers.count > 1,
                   let systemCandidateBuffer = inputBuffers.dropFirst().first,
                   let copiedSystemBufferList = CopiedAudioBufferList(sourceBuffer: systemCandidateBuffer)
                {
                    let systemFormat =
                        aggregateInputFormats.count > 1
                        ? aggregateInputFormats[1]
                        : (aggregateInputFormats.first ?? targetFormat)
                    processingQueue.async { [weak self] in
                        self?.process(
                            copiedSystemBufferList,
                            format: systemFormat,
                            sourceSampleRate: aggregateSampleRate,
                            selectedSource: "aggregate-input[1]-system",
                            onSamples: self?.onSamples ?? { _ in },
                            preResampleDebugWriter: self?.preResampleDebugWriter,
                            postResampleDebugWriter: self?.postResampleDebugWriter
                        )
                    }
                }

                if let microphoneBuffer = inputBuffers.first,
                   let copiedMicrophoneBufferList = CopiedAudioBufferList(sourceBuffer: microphoneBuffer)
                {
                    let microphoneFormat = aggregateInputFormats.first ?? targetFormat
                    processingQueue.async { [weak self] in
                        self?.process(
                            copiedMicrophoneBufferList,
                            format: microphoneFormat,
                            sourceSampleRate: aggregateSampleRate,
                            selectedSource: "aggregate-input[0]-mic",
                            onSamples: onMicrophoneSamples
                        )
                    }
                }

                if inputBuffers.count > 1 {
                    return
                }
            }

            if outputBytes > 0,
               let copiedOutputBufferList = outputData
                .map({ UnsafePointer<AudioBufferList>($0) })
                .flatMap(CopiedAudioBufferList.init(source:))
            {
                let aggregateOutputFormat = aggregateOutputFormats.first ?? targetFormat
                processingQueue.async { [weak self] in
                    self?.process(
                        copiedOutputBufferList,
                        format: aggregateOutputFormat,
                        sourceSampleRate: aggregateSampleRate,
                        selectedSource: "aggregate-output-fallback",
                        onSamples: self?.onSamples ?? { _ in },
                        preResampleDebugWriter: self?.preResampleDebugWriter,
                        postResampleDebugWriter: self?.postResampleDebugWriter
                    )
                }
            }

            return
        }

        guard
            let selectedBufferList,
            let copiedBufferList = CopiedAudioBufferList(source: selectedBufferList)
        else {
            return
        }

        processingQueue.async { [weak self] in
            guard let self, let sourceFormat = self.sourceFormat else { return }
            self.process(
                copiedBufferList,
                format: sourceFormat,
                sourceSampleRate: self.sourceSampleRate ?? sourceFormat.sampleRate,
                selectedSource: selectedSource,
                onSamples: self.onSamples,
                preResampleDebugWriter: self.preResampleDebugWriter,
                postResampleDebugWriter: self.postResampleDebugWriter
            )
        }
    }

    private func process(
        _ copiedBufferList: CopiedAudioBufferList,
        format: AVAudioFormat,
        sourceSampleRate: Double,
        selectedSource: String,
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

        let isInterleaved = sourceBuffers.count == 1
        let callbackChannelCount = AVAudioChannelCount(
            max(1, Int(isInterleaved ? firstBuffer.mNumberChannels : UInt32(sourceBuffers.count)))
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

        do {
            try preResampleDebugWriter?.append(samples: monoSamples)
            try postResampleDebugWriter?.append(samples: resampledSamples)
        } catch {
            Logger.error("Failed to write debug audio files: \(error.localizedDescription)")
        }

        onSamples(resampledSamples)
    }
}

final class DualModeCapture {
    private let writer: PacketWriter
    private let debugArtifactsDirectory: String?
    private let processingQueue = DispatchQueue(label: "ai.prismical.audio-capture.dual.processing")
    private let aecProcessor = FixedFrameAecProcessor()
    private var systemAudioCapture: SystemAudioCapture?
    private var hasAggregateMicrophoneSamples = false

    init(writer: PacketWriter, debugArtifactsDirectory: String?) {
        self.writer = writer
        self.debugArtifactsDirectory = debugArtifactsDirectory
    }

    func start() async throws {
        let systemAudioCapture = SystemAudioCapture(
            debugArtifactsDirectory: debugArtifactsDirectory
        ) { [weak self] samples in
            self?.handleSystemSamples(samples)
        } onMicrophoneSamples: { [weak self] samples in
            self?.handleAggregateMicrophoneSamples(samples)
        }
        try await systemAudioCapture.start()
        self.systemAudioCapture = systemAudioCapture

        Logger.info(
            "Dual mode capture started: aec=\(aecProcessor.isReal ? "webrtc-aec3" : "pass-through-bridge") frameSize=\(FixedFrameAecProcessor.frameSize)"
        )
    }

    func stop() async {
        processingQueue.sync {
            if let remainder = aecProcessor.flushCaptureRemainder(), !remainder.isEmpty {
                writer.write(source: .micProcessed, samples: remainder)
            }
            aecProcessor.reset()
        }

        await systemAudioCapture?.stop()
        if hasAggregateMicrophoneSamples {
            Logger.info("Dual mode capture stopped with aggregate microphone active")
        } else {
            Logger.info("Dual mode capture stopped without aggregate microphone samples")
        }
        Logger.info("Dual mode capture stopped")
    }

    private func handleAggregateMicrophoneSamples(_ samples: [Float]) {
        processingQueue.async { [weak self, writer] in
            guard let self else { return }

            if !self.hasAggregateMicrophoneSamples {
                self.hasAggregateMicrophoneSamples = true
                Logger.info("Dual mode aggregate microphone capture became active")
            }

            writer.write(source: .micRaw, samples: samples)
            let processedFrames = self.aecProcessor.processCapture(samples)
            for processedFrame in processedFrames where !processedFrame.isEmpty {
                writer.write(source: .micProcessed, samples: processedFrame)
            }
        }
    }

    private func handleSystemSamples(_ samples: [Float]) {
        processingQueue.async { [weak self, writer] in
            self?.aecProcessor.ingestRender(samples)
            writer.write(source: .system, samples: samples)
        }
    }
}

final class CaptureCoordinator {
    private let writer = PacketWriter()
    private let mode: CaptureMode
    private let debugArtifactsDirectory: String?
    private var microphoneCapture: MicrophoneCapture?
    private var systemAudioCapture: SystemAudioCapture?
    private var dualModeCapture: DualModeCapture?

    init(mode: CaptureMode, debugArtifactsDirectory: String?) {
        self.mode = mode
        self.debugArtifactsDirectory = debugArtifactsDirectory
    }

    func start() async throws {
        if mode == .dual {
            let dualModeCapture = DualModeCapture(
                writer: writer,
                debugArtifactsDirectory: debugArtifactsDirectory
            )
            try await dualModeCapture.start()
            self.dualModeCapture = dualModeCapture
            return
        }

        if mode == .mic {
            let microphoneCapture = MicrophoneCapture { [writer] samples in
                writer.write(source: .micRaw, samples: samples)
            }
            try microphoneCapture.start()
            self.microphoneCapture = microphoneCapture
        }

        if mode == .system {
            let systemAudioCapture = SystemAudioCapture(
                debugArtifactsDirectory: debugArtifactsDirectory
            ) { [writer] samples in
                writer.write(source: .system, samples: samples)
            }
            try await systemAudioCapture.start()
            self.systemAudioCapture = systemAudioCapture
        }
    }

    func stop() async {
        await dualModeCapture?.stop()
        microphoneCapture?.stop()
        await systemAudioCapture?.stop()
    }
}

struct ParsedArguments {
    let mode: CaptureMode
    let debugArtifactsDirectory: String?
    let checkSystemAudioPermission: Bool
}

func parseArguments() throws -> ParsedArguments {
    let arguments = CommandLine.arguments
    var mode: CaptureMode?
    var debugArtifactsDirectory: String?
    let checkSystemAudioPermission = arguments.contains("--check-system-audio-permission")

    if let modeIndex = arguments.firstIndex(of: "--mode"), modeIndex + 1 < arguments.count {
        guard let parsedMode = CaptureMode(rawValue: arguments[modeIndex + 1]) else {
            throw CaptureError.invalidArguments
        }
        mode = parsedMode
    } else if arguments.count > 1, let parsedMode = CaptureMode(rawValue: arguments[1]) {
        mode = parsedMode
    }

    if let debugIndex = arguments.firstIndex(of: "--debug-artifacts-dir"),
       debugIndex + 1 < arguments.count
    {
        debugArtifactsDirectory = arguments[debugIndex + 1]
    }

    guard let mode else {
        throw CaptureError.invalidArguments
    }

    return ParsedArguments(
        mode: mode,
        debugArtifactsDirectory: debugArtifactsDirectory,
        checkSystemAudioPermission: checkSystemAudioPermission
    )
}

@main
struct PrismicalAudioCaptureApp {
    static func main() {
        let coordinator: CaptureCoordinator
        let checkSystemAudioPermission: Bool

        do {
            let parsedArguments = try parseArguments()
            coordinator = CaptureCoordinator(
                mode: parsedArguments.mode,
                debugArtifactsDirectory: parsedArguments.debugArtifactsDirectory
            )
            checkSystemAudioPermission = parsedArguments.checkSystemAudioPermission
        } catch {
            Logger.error(error.localizedDescription)
            exit(1)
        }

        signal(SIGPIPE, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)

        let signalQueue = DispatchQueue(label: "ai.prismical.audio-capture.signals")
        let terminationSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
        let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)

        func installSignalHandler(_ source: DispatchSourceSignal) {
            source.setEventHandler {
                Task { @MainActor in
                    await coordinator.stop()
                    exit(0)
                }
            }
            source.resume()
        }

        installSignalHandler(terminationSource)
        installSignalHandler(interruptSource)

        Task { @MainActor in
            do {
                try await coordinator.start()
                if checkSystemAudioPermission {
                    await coordinator.stop()
                    exit(0)
                }
                Logger.info("Capture binary ready")
            } catch {
                Logger.error(error.localizedDescription)
                await coordinator.stop()
                exit(1)
            }
        }

        dispatchMain()
    }
}
