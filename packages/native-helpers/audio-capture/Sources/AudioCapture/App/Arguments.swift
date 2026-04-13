import Foundation

// CLI parsing for the production capture binary.

struct ParsedArguments {
    let mode: CaptureMode
    let debugArtifactsDirectory: String?
    let aecRenderHoldbackMs: Int
    let aecRenderWaitTimeoutMs: Int
    let checkSystemAudioPermission: Bool
}

func parseArguments() throws -> ParsedArguments {
    let arguments = CommandLine.arguments
    var mode: CaptureMode?
    var debugArtifactsDirectory: String?
    var aecRenderHoldbackMs = NativeTimedDualAecSession.defaultMicrophoneHoldbackMs
    var aecRenderWaitTimeoutMs: Int?
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

    if let holdbackIndex = arguments.firstIndex(of: "--aec-render-holdback-ms"),
       holdbackIndex + 1 < arguments.count,
       let parsedHoldbackMs = Int(arguments[holdbackIndex + 1])
    {
        aecRenderHoldbackMs = max(0, parsedHoldbackMs)
    }

    if let timeoutIndex = arguments.firstIndex(of: "--aec-render-wait-timeout-ms"),
       timeoutIndex + 1 < arguments.count,
       let parsedTimeoutMs = Int(arguments[timeoutIndex + 1])
    {
        aecRenderWaitTimeoutMs = max(0, parsedTimeoutMs)
    }

    guard let mode else {
        throw CaptureError.invalidArguments
    }

    return ParsedArguments(
        mode: mode,
        debugArtifactsDirectory: debugArtifactsDirectory,
        aecRenderHoldbackMs: aecRenderHoldbackMs,
        aecRenderWaitTimeoutMs: aecRenderWaitTimeoutMs ?? aecRenderHoldbackMs,
        checkSystemAudioPermission: checkSystemAudioPermission
    )
}
