import Foundation

// Encodes fixed packet headers and PCM payloads for the Electron-side reader.

final class PacketWriter {
    private let output = FileHandle.standardOutput
    private let lock = NSLock()
    private let startedAt = DispatchTime.now().uptimeNanoseconds
    private let traceWriter: CaptureTraceWriter?
    private var sequences: [CaptureSource: UInt32] = [
        .micRaw: 0,
        .system: 0,
        .micProcessed: 0
    ]

    init(traceWriter: CaptureTraceWriter? = nil) {
        self.traceWriter = traceWriter
    }

    func write(
        source: CaptureSource,
        samples: [Float],
        sampleRate: UInt32 = 48_000,
        channels: UInt8 = 1,
        timestampMs: UInt64? = nil,
        sampleStartIndex: Int64? = nil
    ) {
        guard !samples.isEmpty else { return }

        let resolvedTimestampMs =
            timestampMs ??
            UInt64((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
        let resolvedSampleStartIndex = sampleStartIndex.map { max(Int64(0), $0) } ?? 0
        let clampedSampleStartIndex = UInt32(
            min(UInt64(UInt32.max), UInt64(resolvedSampleStartIndex))
        )
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
        writeUInt64(&header, resolvedTimestampMs, at: 16)
        writeUInt32(&header, UInt32(payload.count), at: 24)
        writeUInt32(&header, clampedSampleStartIndex, at: 28)

        lock.lock()
        defer { lock.unlock() }

        output.write(header)
        output.write(payload)

        traceWriter?.recordSamples(
            event: "packet_emit",
            channel: "packet-\(captureSourceName(source))",
            samples: samples,
            metadata: [
                "source": captureSourceName(source),
                "timestampMs": Int64(resolvedTimestampMs),
                "sampleStartIndex": resolvedSampleStartIndex,
                "durationMs": Int(durationMs),
                "sequenceNum": Int(sequenceNum),
                "sampleRate": Int(sampleRate),
                "channels": Int(channels),
                "sampleCount": samples.count
            ]
        )
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
