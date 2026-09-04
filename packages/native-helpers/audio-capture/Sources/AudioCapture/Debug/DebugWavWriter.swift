import Foundation

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

    func appendSilence(sampleCount: Int) throws {
        guard sampleCount > 0 else { return }
        guard !isFinalized, let handle else { return }

        let silenceBytes = sampleCount * Int(channels) * 2
        try handle.write(contentsOf: Data(count: silenceBytes))
        dataSize += UInt32(silenceBytes)
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
