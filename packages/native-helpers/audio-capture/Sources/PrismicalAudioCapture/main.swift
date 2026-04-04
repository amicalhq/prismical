import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

enum CaptureMode: String {
    case mic
    case system
    case dual
}

enum CaptureSource: UInt8 {
    case mic = 1
    case system = 2
}

enum PacketFormat: UInt8 {
    case float32LE = 1
}

enum CaptureError: Error, LocalizedError {
    case invalidArguments
    case missingDisplay
    case microphoneUnavailable
    case unsupportedSystemAudioBuffer

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Invalid arguments. Use --mode mic|system|dual."
        case .missingDisplay:
            return "No display available for ScreenCaptureKit audio capture."
        case .microphoneUnavailable:
            return "Microphone input is unavailable."
        case .unsupportedSystemAudioBuffer:
            return "Unsupported system audio buffer format."
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

final class PacketWriter {
    private let output = FileHandle.standardOutput
    private let lock = NSLock()
    private let startedAt = DispatchTime.now().uptimeNanoseconds
    private var sequences: [CaptureSource: UInt32] = [
        .mic: 0,
        .system: 0
    ]

    func write(source: CaptureSource, samples: [Float], sampleRate: UInt32 = 16_000, channels: UInt8 = 1) {
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

final class MicrophoneCapture {
    private let engine = AVAudioEngine()
    private let writer: PacketWriter
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?

    init(writer: PacketWriter) {
        self.writer = writer
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
        writer.write(source: .mic, samples: samples)
    }
}

final class SystemAudioCapture: NSObject, SCStreamOutput {
    private let writer: PacketWriter
    private let queue = DispatchQueue(label: "ai.prismical.audio-capture.system")
    private var stream: SCStream?

    init(writer: PacketWriter) {
        self.writer = writer
    }

    func start() async throws {
        let shareableContent = try await SCShareableContent.current
        guard let display = shareableContent.displays.first else {
            throw CaptureError.missingDisplay
        }

        let filter = SCContentFilter(
            display: display,
            excludingApplications: [],
            exceptingWindows: []
        )

        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 16_000
        configuration.channelCount = 1

        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        self.stream = stream

        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        Logger.info("System audio capture started")
    }

    func stop() async {
        do {
            try await stream?.stopCapture()
        } catch {
            Logger.error("System audio stop failed: \(error.localizedDescription)")
        }
        stream = nil
        Logger.info("System audio capture stopped")
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio else { return }
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var length = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &length,
            dataPointerOut: &dataPointer
        )

        guard status == kCMBlockBufferNoErr, let dataPointer else { return }
        guard length > 0, length % MemoryLayout<Float>.size == 0 else { return }

        let sampleCount = length / MemoryLayout<Float>.size
        let typedPointer = dataPointer.withMemoryRebound(to: Float.self, capacity: sampleCount) { $0 }
        let samples = Array(UnsafeBufferPointer(start: typedPointer, count: sampleCount))
        writer.write(source: .system, samples: samples)
    }
}

final class CaptureCoordinator {
    private let writer = PacketWriter()
    private let mode: CaptureMode
    private var microphoneCapture: MicrophoneCapture?
    private var systemAudioCapture: SystemAudioCapture?

    init(mode: CaptureMode) {
        self.mode = mode
    }

    func start() async throws {
        if mode == .mic || mode == .dual {
            let microphoneCapture = MicrophoneCapture(writer: writer)
            try microphoneCapture.start()
            self.microphoneCapture = microphoneCapture
        }

        if mode == .system || mode == .dual {
            let systemAudioCapture = SystemAudioCapture(writer: writer)
            try await systemAudioCapture.start()
            self.systemAudioCapture = systemAudioCapture
        }
    }

    func stop() async {
        microphoneCapture?.stop()
        await systemAudioCapture?.stop()
    }
}

func parseMode() throws -> CaptureMode {
    let arguments = CommandLine.arguments

    if let modeIndex = arguments.firstIndex(of: "--mode"), modeIndex + 1 < arguments.count {
        guard let mode = CaptureMode(rawValue: arguments[modeIndex + 1]) else {
            throw CaptureError.invalidArguments
        }
        return mode
    }

    guard arguments.count > 1, let mode = CaptureMode(rawValue: arguments[1]) else {
        throw CaptureError.invalidArguments
    }

    return mode
}

@main
struct PrismicalAudioCaptureApp {
    static func main() {
        let coordinator: CaptureCoordinator

        do {
            let mode = try parseMode()
            coordinator = CaptureCoordinator(mode: mode)
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
