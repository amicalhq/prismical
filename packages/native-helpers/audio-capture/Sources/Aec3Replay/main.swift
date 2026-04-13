import Foundation
import Aec3Bridge

private let sampleRate = 48_000
private let frameSize = 480

struct WavFile {
    let path: String
    let sampleRate: Int
    let channels: Int
    let bitDepth: Int
    let samples: [Float]
}

enum ReplayError: Error, CustomStringConvertible {
    case usage(String)
    case invalidWav(String)
    case bridgeUnavailable

    var description: String {
        switch self {
        case .usage(let message):
            return message
        case .invalidWav(let message):
            return message
        case .bridgeUnavailable:
            return "Failed to initialize Prismical AEC3 bridge"
        }
    }
}

func main() throws {
    let arguments = try parseArguments()
    let render = try readWavFile(at: arguments.renderPath)
    let capture = try readWavFile(at: arguments.capturePath)

    guard render.sampleRate == sampleRate, capture.sampleRate == sampleRate else {
        throw ReplayError.invalidWav("Expected 48000 Hz mono WAVs")
    }
    guard render.channels == 1, capture.channels == 1 else {
        throw ReplayError.invalidWav("Expected mono WAVs")
    }

    let processor = try AecReplayProcessor(streamDelayMs: arguments.streamDelayMs)
    let processed = processor.process(renderSamples: render.samples, captureSamples: capture.samples)
    try writeWavFile(
        to: arguments.outputPath,
        samples: processed,
        sampleRate: sampleRate
    )

    let payload: [String: Any] = [
        "renderPath": render.path,
        "capturePath": capture.path,
        "outputPath": arguments.outputPath,
        "sampleRate": sampleRate,
        "frameSize": frameSize,
        "streamDelayMs": arguments.streamDelayMs as Any,
        "bridgeIsReal": processor.isReal,
        "renderSamples": render.samples.count,
        "captureSamples": capture.samples.count,
        "outputSamples": processed.count,
    ]

    let json = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

struct Arguments {
    let renderPath: String
    let capturePath: String
    let outputPath: String
    let streamDelayMs: Int?
}

func parseArguments() throws -> Arguments {
    let args = Array(CommandLine.arguments.dropFirst())
    var renderPath: String?
    var capturePath: String?
    var outputPath: String?
    var streamDelayMs: Int?

    var index = 0
    while index < args.count {
        let token = args[index]
        guard index + 1 < args.count else {
            throw ReplayError.usage("Missing value for \(token)")
        }

        switch token {
        case "--render":
            renderPath = args[index + 1]
        case "--capture":
            capturePath = args[index + 1]
        case "--output":
            outputPath = args[index + 1]
        case "--stream-delay-ms":
            guard let value = Int(args[index + 1]) else {
                throw ReplayError.usage("Invalid integer for --stream-delay-ms")
            }
            streamDelayMs = value
        default:
            throw ReplayError.usage("Unknown argument: \(token)")
        }

        index += 2
    }

    guard let renderPath, let capturePath, let outputPath else {
        throw ReplayError.usage(
            "Usage: swift run Aec3Replay --render <system.wav> --capture <mic.wav> --output <offline.wav>"
        )
    }

    return Arguments(
        renderPath: renderPath,
        capturePath: capturePath,
        outputPath: outputPath,
        streamDelayMs: streamDelayMs
    )
}

func readWavFile(at path: String) throws -> WavFile {
    let url = URL(fileURLWithPath: path)
    let data = try Data(contentsOf: url)
    guard data.count >= 44 else {
        throw ReplayError.invalidWav("WAV too small: \(path)")
    }
    guard String(data: data[0..<4], encoding: .ascii) == "RIFF",
          String(data: data[8..<12], encoding: .ascii) == "WAVE" else {
        throw ReplayError.invalidWav("Invalid WAV header: \(path)")
    }

    var audioFormat: Int?
    var channels: Int?
    var sampleRateValue: Int?
    var bitDepth: Int?
    var dataOffset: Int?
    var dataSize: Int?

    var offset = 12
    while offset + 8 <= data.count {
        let chunkID = String(data: data[offset..<(offset + 4)], encoding: .ascii) ?? ""
        let chunkSize = Int(readUInt32LE(data, at: offset + 4))
        let chunkDataOffset = offset + 8
        let paddedChunkSize = chunkSize + (chunkSize % 2)

        guard chunkDataOffset + chunkSize <= data.count else { break }

        if chunkID == "fmt " {
            guard chunkSize >= 16 else {
                throw ReplayError.invalidWav("Invalid fmt chunk: \(path)")
            }
            audioFormat = Int(readUInt16LE(data, at: chunkDataOffset))
            channels = Int(readUInt16LE(data, at: chunkDataOffset + 2))
            sampleRateValue = Int(readUInt32LE(data, at: chunkDataOffset + 4))
            bitDepth = Int(readUInt16LE(data, at: chunkDataOffset + 14))
        } else if chunkID == "data" {
            dataOffset = chunkDataOffset
            dataSize = chunkSize
            break
        }

        offset = chunkDataOffset + paddedChunkSize
    }

    guard let audioFormat, let channels, let sampleRateValue, let bitDepth,
          let dataOffset, let dataSize else {
        throw ReplayError.invalidWav("Unable to locate fmt/data chunks: \(path)")
    }

    let bytesPerSample = max(1, (bitDepth / 8) * channels)
    let sampleCount = min(
        max(0, data.count - dataOffset) / bytesPerSample,
        dataSize / bytesPerSample
    )

    var samples: [Float] = []
    samples.reserveCapacity(sampleCount)

    if audioFormat == 1 && bitDepth == 16 {
        for index in 0..<sampleCount {
            let value = readInt16LE(data, at: dataOffset + (index * 2))
            samples.append(Float(value) / 32768.0)
        }
    } else if audioFormat == 3 && bitDepth == 32 {
        for index in 0..<sampleCount {
            let bits = readUInt32LE(data, at: dataOffset + (index * 4))
            samples.append(Float(bitPattern: bits))
        }
    } else {
        throw ReplayError.invalidWav(
            "Unsupported WAV format for \(path): format=\(audioFormat) bitDepth=\(bitDepth)"
        )
    }

    return WavFile(
        path: path,
        sampleRate: sampleRateValue,
        channels: channels,
        bitDepth: bitDepth,
        samples: samples
    )
}

func writeWavFile(to path: String, samples: [Float], sampleRate: Int) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )

    var output = Data(count: 44 + samples.count * 2)
    output.replaceSubrange(0..<4, with: Data("RIFF".utf8))
    writeUInt32LE(&output, UInt32(36 + (samples.count * 2)), at: 4)
    output.replaceSubrange(8..<12, with: Data("WAVE".utf8))
    output.replaceSubrange(12..<16, with: Data("fmt ".utf8))
    writeUInt32LE(&output, 16, at: 16)
    writeUInt16LE(&output, 1, at: 20)
    writeUInt16LE(&output, 1, at: 22)
    writeUInt32LE(&output, UInt32(sampleRate), at: 24)
    writeUInt32LE(&output, UInt32(sampleRate * 2), at: 28)
    writeUInt16LE(&output, 2, at: 32)
    writeUInt16LE(&output, 16, at: 34)
    output.replaceSubrange(36..<40, with: Data("data".utf8))
    writeUInt32LE(&output, UInt32(samples.count * 2), at: 40)

    for (index, sample) in samples.enumerated() {
        let clamped = max(-1.0, min(1.0, sample))
        let intValue = Int16((clamped * 32767.0).rounded(.towardZero))
        writeUInt16LE(&output, UInt16(bitPattern: intValue), at: 44 + (index * 2))
    }

    try output.write(to: url)
}

final class AecReplayProcessor {
    private let handle: UnsafeMutableRawPointer

    init(streamDelayMs: Int?) throws {
        guard let handle = prismical_aec3_create(Int32(sampleRate), 1) else {
            throw ReplayError.bridgeUnavailable
        }
        self.handle = handle
        if let streamDelayMs {
            prismical_aec3_set_stream_delay_ms(handle, Int32(max(0, streamDelayMs)))
        }
    }

    deinit {
        prismical_aec3_destroy(handle)
    }

    var isReal: Bool {
        prismical_aec3_is_real() != 0
    }

    func process(renderSamples: [Float], captureSamples: [Float]) -> [Float] {
        guard !captureSamples.isEmpty else { return [] }

        var processed: [Float] = []
        processed.reserveCapacity(captureSamples.count)

        var frameStart = 0
        while frameStart < captureSamples.count {
            let captureFrameCount = min(frameSize, captureSamples.count - frameStart)
            var renderFrame = Array(repeating: Float.zero, count: frameSize)
            var captureFrame = Array(repeating: Float.zero, count: frameSize)

            if frameStart < renderSamples.count {
                let renderFrameCount = min(frameSize, renderSamples.count - frameStart)
                renderFrame[0..<renderFrameCount] = renderSamples[frameStart..<(frameStart + renderFrameCount)]
            }

            captureFrame[0..<captureFrameCount] = captureSamples[frameStart..<(frameStart + captureFrameCount)]

            renderFrame.withUnsafeBufferPointer { renderBuffer in
                _ = prismical_aec3_ingest_render_samples(
                    handle,
                    renderBuffer.baseAddress,
                    Int32(renderBuffer.count)
                )
            }

            var outputFrame = Array(repeating: Float.zero, count: frameSize)
            let writtenSamples = captureFrame.withUnsafeBufferPointer { captureBuffer in
                outputFrame.withUnsafeMutableBufferPointer { outputBuffer in
                    Int(
                        prismical_aec3_process_capture_samples(
                            handle,
                            captureBuffer.baseAddress,
                            Int32(captureBuffer.count),
                            outputBuffer.baseAddress,
                            Int32(outputBuffer.count)
                        )
                    )
                }
            }

            let usableSamples = min(captureFrameCount, writtenSamples)
            if usableSamples > 0 {
                processed.append(contentsOf: outputFrame.prefix(usableSamples))
            }

            frameStart += captureFrameCount
        }

        return processed
    }
}

func readUInt16LE(_ data: Data, at offset: Int) -> UInt16 {
    data.withUnsafeBytes { rawBuffer in
        rawBuffer.loadUnaligned(fromByteOffset: offset, as: UInt16.self).littleEndian
    }
}

func readInt16LE(_ data: Data, at offset: Int) -> Int16 {
    Int16(bitPattern: readUInt16LE(data, at: offset))
}

func readUInt32LE(_ data: Data, at offset: Int) -> UInt32 {
    data.withUnsafeBytes { rawBuffer in
        rawBuffer.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian
    }
}

func writeUInt16LE(_ data: inout Data, _ value: UInt16, at offset: Int) {
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { bytes in
        data.replaceSubrange(offset..<(offset + 2), with: bytes)
    }
}

func writeUInt32LE(_ data: inout Data, _ value: UInt32, at offset: Int) {
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { bytes in
        data.replaceSubrange(offset..<(offset + 4), with: bytes)
    }
}

do {
    try main()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
