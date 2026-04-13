import AVFoundation
import CoreAudio
import AudioToolbox
import Darwin
import Foundation

// Shared capture enums, errors, logging, and small PCM-format helpers.

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
        write("[audio-capture] \(message)\n")
    }

    static func error(_ message: String) {
        write("[audio-capture] ERROR: \(message)\n")
    }

    private static func write(_ value: String) {
        guard let data = value.data(using: .utf8) else { return }
        FileHandle.standardError.write(data)
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

typealias NormalizedSampleHandler = (_ samples: [Float], _ hostTime: UInt64?) -> Void
