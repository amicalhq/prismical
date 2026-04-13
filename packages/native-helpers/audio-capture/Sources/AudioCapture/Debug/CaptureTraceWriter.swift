import AVFoundation
import CoreAudio
import Foundation

final class CaptureTraceWriter {
    private let directoryURL: URL
    private let jsonlURL: URL
    private var jsonHandle: FileHandle?
    private var channelHandles: [String: FileHandle] = [:]
    private var channelByteOffsets: [String: UInt64] = [:]
    private let lock = NSLock()
    private var isClosed = false

    init?(directoryPath: String) {
        self.directoryURL = URL(fileURLWithPath: directoryPath)
        self.jsonlURL = directoryURL.appendingPathComponent("native-capture-trace.jsonl")

        do {
            try FileManager.default.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true
            )
            FileManager.default.createFile(atPath: jsonlURL.path, contents: nil)
            self.jsonHandle = try FileHandle(forWritingTo: jsonlURL)
        } catch {
            Logger.error("Failed to initialize capture trace writer at \(jsonlURL.path): \(error.localizedDescription)")
            return nil
        }
    }

    deinit {
        try? close()
    }

    func record(event: String, metadata: [String: Any] = [:]) {
        lock.lock()
        defer { lock.unlock() }

        guard !isClosed, let jsonHandle else { return }

        var payload = metadata
        payload["event"] = event
        payload["loggedAtEpochMs"] = Int64((Date().timeIntervalSince1970 * 1000.0).rounded())

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            try jsonHandle.write(contentsOf: data)
            try jsonHandle.write(contentsOf: Data([0x0A]))
        } catch {
            Logger.error("Failed to write capture trace event \(event): \(error.localizedDescription)")
        }
    }

    func recordSamples(
        event: String,
        channel: String,
        samples: [Float],
        metadata: [String: Any] = [:]
    ) {
        let payload = samples.withUnsafeBufferPointer { buffer in
            Data(buffer: buffer)
        }
        recordData(
            event: event,
            channel: channel,
            fileExtension: "f32le",
            payload: payload,
            sampleCount: samples.count,
            metadata: metadata
        )
    }

    func recordBytes(
        event: String,
        channel: String,
        payload: Data,
        metadata: [String: Any] = [:]
    ) {
        recordData(
            event: event,
            channel: channel,
            fileExtension: "bin",
            payload: payload,
            sampleCount: nil,
            metadata: metadata
        )
    }

    private func recordData(
        event: String,
        channel: String,
        fileExtension: String,
        payload: Data,
        sampleCount: Int?,
        metadata: [String: Any]
    ) {
        lock.lock()
        defer { lock.unlock() }

        guard !isClosed, let jsonHandle else { return }
        guard let appendResult = appendDataLocked(
            channel: channel,
            fileExtension: fileExtension,
            payload: payload
        ) else {
            return
        }

        var payload = metadata
        payload["event"] = event
        payload["loggedAtEpochMs"] = Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
        payload["traceChannel"] = channel
        payload["traceFilePath"] = appendResult.filePath
        payload["traceByteOffset"] = Int64(appendResult.byteOffset)
        if let sampleCount {
            payload["traceSampleOffset"] = Int64(appendResult.byteOffset / 4)
            payload["traceSampleCount"] = sampleCount
        }

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            try jsonHandle.write(contentsOf: data)
            try jsonHandle.write(contentsOf: Data([0x0A]))
        } catch {
            Logger.error("Failed to write capture trace sample event \(event): \(error.localizedDescription)")
        }
    }

    func close() throws {
        lock.lock()
        defer { lock.unlock() }

        guard !isClosed else { return }
        isClosed = true

        try jsonHandle?.synchronize()
        try jsonHandle?.close()
        jsonHandle = nil

        for (_, handle) in channelHandles {
            try handle.synchronize()
            try handle.close()
        }
        channelHandles.removeAll()
        channelByteOffsets.removeAll()
    }

    private func appendDataLocked(
        channel: String,
        fileExtension: String,
        payload: Data
    ) -> (filePath: String, byteOffset: UInt64)? {
        guard !payload.isEmpty else { return nil }

        let channelKey = "\(channel).\(fileExtension)"
        let fileURL = directoryURL.appendingPathComponent(channelKey)
        let handle: FileHandle
        if let existingHandle = channelHandles[channelKey] {
            handle = existingHandle
        } else {
            do {
                FileManager.default.createFile(atPath: fileURL.path, contents: nil)
                let newHandle = try FileHandle(forWritingTo: fileURL)
                channelHandles[channelKey] = newHandle
                channelByteOffsets[channelKey] = 0
                handle = newHandle
            } catch {
                Logger.error("Failed to initialize trace channel \(channel): \(error.localizedDescription)")
                return nil
            }
        }

        let byteOffset = channelByteOffsets[channelKey, default: 0]

        do {
            try handle.write(contentsOf: payload)
            channelByteOffsets[channelKey] = byteOffset + UInt64(payload.count)
            return (fileURL.path, byteOffset)
        } catch {
            Logger.error("Failed to append trace channel \(channel): \(error.localizedDescription)")
            return nil
        }
    }
}

func nonNilTraceFields(_ fields: [(String, Any?)]) -> [String: Any] {
    var result: [String: Any] = [:]
    for (key, value) in fields {
        if let value {
            result[key] = value
        }
    }
    return result
}

func captureSourceName(_ source: CaptureSource) -> String {
    switch source {
    case .micRaw:
        return "mic_raw"
    case .system:
        return "system"
    case .micProcessed:
        return "mic_processed"
    }
}

func audioTimeStampFields(
    _ timeStamp: UnsafePointer<AudioTimeStamp>?,
    prefix: String
) -> [String: Any] {
    guard let timeStamp else { return [:] }
    let value = timeStamp.pointee
    return [
        "\(prefix)SampleTime": value.mSampleTime,
        "\(prefix)HostTime": Int64(value.mHostTime),
        "\(prefix)RateScalar": value.mRateScalar,
        "\(prefix)WordClockTime": Int64(value.mWordClockTime),
        "\(prefix)Flags": Int(value.mFlags.rawValue),
        "\(prefix)SmpteSubframes": Int(value.mSMPTETime.mSubframes),
        "\(prefix)SmpteSubframeDivisor": Int(value.mSMPTETime.mSubframeDivisor),
        "\(prefix)SmpteCounter": Int(value.mSMPTETime.mCounter),
        "\(prefix)SmpteType": Int(value.mSMPTETime.mType.rawValue),
        "\(prefix)SmpteFlags": Int(value.mSMPTETime.mFlags.rawValue),
        "\(prefix)SmpteHours": Int(value.mSMPTETime.mHours),
        "\(prefix)SmpteMinutes": Int(value.mSMPTETime.mMinutes),
        "\(prefix)SmpteSeconds": Int(value.mSMPTETime.mSeconds),
        "\(prefix)SmpteFrames": Int(value.mSMPTETime.mFrames)
    ]
}

func avAudioFormatFields(
    _ format: AVAudioFormat?,
    prefix: String
) -> [String: Any] {
    guard let format else { return [:] }
    let streamDescription = format.streamDescription.pointee
    var fields: [String: Any] = [
        "\(prefix)SampleRate": format.sampleRate,
        "\(prefix)ChannelCount": Int(format.channelCount),
        "\(prefix)Interleaved": format.isInterleaved,
        "\(prefix)CommonFormat": commonFormat(from: streamDescription).map(commonFormatName) ?? "unknown",
        "\(prefix)FormatID": Int(streamDescription.mFormatID),
        "\(prefix)FormatFlags": Int(streamDescription.mFormatFlags),
        "\(prefix)BytesPerPacket": Int(streamDescription.mBytesPerPacket),
        "\(prefix)FramesPerPacket": Int(streamDescription.mFramesPerPacket),
        "\(prefix)BytesPerFrame": Int(streamDescription.mBytesPerFrame),
        "\(prefix)ChannelsPerFrame": Int(streamDescription.mChannelsPerFrame),
        "\(prefix)BitsPerChannel": Int(streamDescription.mBitsPerChannel)
    ]
    if let channelLayout = format.channelLayout {
        fields["\(prefix)ChannelLayoutTag"] = Int(channelLayout.layout.pointee.mChannelLayoutTag)
    }
    return fields
}
