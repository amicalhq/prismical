import AppKit
import CoreAudio
import Darwin
import Foundation

struct MicInputDevice: Codable {
    let uid: String
    let name: String
}

struct MicActiveApp: Codable {
    let bundleId: String
    let pid: Int32
    let detectedAtMs: UInt64
    let applicationName: String?
    let inputDevices: [MicInputDevice]?
}

struct SnapshotMessage: Codable {
    let type: String
    let timestampMs: UInt64
    let apps: [MicActiveApp]
}

enum DetectorError: Error, LocalizedError {
    case propertyUnavailable(selector: AudioObjectPropertySelector)
    case osStatus(selector: AudioObjectPropertySelector, status: OSStatus)

    var errorDescription: String? {
        switch self {
        case let .propertyUnavailable(selector):
            return "Audio property unavailable for selector \(selector)"
        case let .osStatus(selector, status):
            return "CoreAudio call failed for selector \(selector) with status \(status)"
        }
    }
}

enum Logger {
    static func info(_ message: String) {
        record("info", message)
    }

    static func error(_ message: String) {
        record("error", message)
    }

    private static func record(_ level: String, _ message: String) {
        let timestamp = ISO8601DateFormatter()
        timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let frame: [String: Any] = ["schemaVersion": 1, "timestamp": timestamp.string(from: Date()),
            "level": level, "scope": "mic-detector", "message": String(message.prefix(2048))]
        guard let data = try? JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { return }
        write(line + "\n")
    }

    private static func write(_ message: String) {
        guard let data = message.data(using: .utf8) else { return }
        FileHandle.standardError.write(data)
    }
}

final class SnapshotWriter {
    private let encoder = JSONEncoder()

    func write(apps: [MicActiveApp]) {
        let message = SnapshotMessage(type: "snapshot", timestampMs: currentTimestampMs(), apps: apps)

        do {
            let data = try encoder.encode(message)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        } catch {
            Logger.error("Failed to encode microphone snapshot")
        }
    }

    private func currentTimestampMs() -> UInt64 {
        UInt64(Date().timeIntervalSince1970 * 1000.0)
    }
}

final class MicDetector {
    private let writer = SnapshotWriter()
    private var timer: DispatchSourceTimer?

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "ai.prismical.mic-detector"))
        timer.schedule(deadline: .now(), repeating: .seconds(1))
        timer.setEventHandler { [weak self] in
            self?.emitSnapshot()
        }
        self.timer = timer
        timer.resume()
        Logger.info("Microphone activity detector started")
    }

    func stop() {
        timer?.cancel()
        timer = nil
        Logger.info("Microphone activity detector stopped")
    }

    private func emitSnapshot() {
        do {
            let apps = try loadActiveInputApps()
            writer.write(apps: apps)
        } catch {
            Logger.error("Failed to load active input applications")
        }
    }

    private func loadActiveInputApps() throws -> [MicActiveApp] {
        let processObjectIDs = try getProcessObjectIDs()
        let nowMs = UInt64(Date().timeIntervalSince1970 * 1000.0)

        return try processObjectIDs.compactMap { processObjectID in
            guard try isProcessRunningInput(processObjectID) else {
                return nil
            }

            let pid = try getProcessPID(processObjectID)
            guard let identity = resolveApplicationIdentity(
                for: pid,
                processObjectID: processObjectID
            ) else {
                return nil
            }

            return MicActiveApp(
                bundleId: identity.bundleId,
                pid: pid,
                detectedAtMs: nowMs,
                applicationName: identity.applicationName,
                inputDevices: loadInputDevices(for: processObjectID)
            )
        }
    }

    private func resolveApplicationIdentity(
        for pid: pid_t,
        processObjectID: AudioObjectID
    ) -> (bundleId: String, applicationName: String?)? {
        if let runningApplication = NSRunningApplication(processIdentifier: pid),
           let bundleId = runningApplication.bundleIdentifier,
           !bundleId.isEmpty {
            return (bundleId, runningApplication.localizedName)
        }

        if let executablePath = getExecutablePath(for: pid),
           let bundleURL = findBundleURL(forExecutablePath: executablePath),
           let bundle = Bundle(url: bundleURL),
           let bundleId = bundle.bundleIdentifier,
           !bundleId.isEmpty {
            let applicationName =
                (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ??
                (bundle.object(forInfoDictionaryKey: kCFBundleNameKey as String) as? String)

            return (bundleId, applicationName)
        }

        guard let bundleId = try? getStringProperty(
            objectID: processObjectID,
            selector: kAudioProcessPropertyBundleID
        ), !bundleId.isEmpty else {
            return nil
        }

        return (bundleId, nil)
    }

    private func loadInputDevices(for processObjectID: AudioObjectID) -> [MicInputDevice]? {
        guard let deviceIDs = try? getObjectIDs(
            objectID: processObjectID,
            selector: kAudioProcessPropertyDevices,
            scope: kAudioObjectPropertyScopeInput
        ) else {
            return nil
        }

        var devices: [MicInputDevice] = []
        for deviceID in deviceIDs {
            guard deviceID != kAudioObjectUnknown,
                  let uid = try? getStringProperty(
                      objectID: deviceID,
                      selector: kAudioDevicePropertyDeviceUID
                  ),
                  let name = try? getStringProperty(
                      objectID: deviceID,
                      selector: kAudioObjectPropertyName
                  ) else {
                return nil
            }
            devices.append(MicInputDevice(uid: uid, name: name))
        }

        return devices
    }

    private func getExecutablePath(for pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(PROC_PIDPATHINFO_SIZE))
        let result = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard result > 0 else {
            return nil
        }

        return String(cString: buffer)
    }

    private func findBundleURL(forExecutablePath path: String) -> URL? {
        var currentURL = URL(fileURLWithPath: path).deletingLastPathComponent()

        while currentURL.path != "/" {
            if currentURL.pathExtension == "app" {
                return currentURL
            }

            currentURL.deleteLastPathComponent()
        }

        return nil
    }

    private func getProcessObjectIDs() throws -> [AudioObjectID] {
        let systemObjectID = AudioObjectID(UInt32(kAudioObjectSystemObject))
        return try getObjectIDs(
            objectID: systemObjectID,
            selector: kAudioHardwarePropertyProcessObjectList,
            scope: kAudioObjectPropertyScopeGlobal
        )
    }

    private func getObjectIDs(
        objectID: AudioObjectID,
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope
    ) throws -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain
        )

        guard AudioObjectHasProperty(objectID, &address) else {
            throw DetectorError.propertyUnavailable(selector: address.mSelector)
        }

        var dataSize: UInt32 = 0
        let sizeStatus = AudioObjectGetPropertyDataSize(
            objectID,
            &address,
            0,
            nil,
            &dataSize
        )
        guard sizeStatus == noErr else {
            throw DetectorError.osStatus(selector: address.mSelector, status: sizeStatus)
        }

        let count = Int(dataSize) / MemoryLayout<AudioObjectID>.stride
        guard count > 0 else {
            return []
        }
        var objectIDs = Array<AudioObjectID>(repeating: 0, count: count)
        let readStatus = objectIDs.withUnsafeMutableBufferPointer { buffer in
            AudioObjectGetPropertyData(
                objectID,
                &address,
                0,
                nil,
                &dataSize,
                buffer.baseAddress!
            )
        }
        guard readStatus == noErr else {
            throw DetectorError.osStatus(selector: address.mSelector, status: readStatus)
        }

        return objectIDs
    }

    private func getStringProperty(
        objectID: AudioObjectID,
        selector: AudioObjectPropertySelector
    ) throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectHasProperty(objectID, &address) else {
            throw DetectorError.propertyUnavailable(selector: selector)
        }

        var value: CFString = "" as CFString
        var dataSize = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(
                objectID,
                &address,
                0,
                nil,
                &dataSize,
                pointer
            )
        }
        guard status == noErr else {
            throw DetectorError.osStatus(selector: selector, status: status)
        }

        return value as String
    }

    private func isProcessRunningInput(_ processObjectID: AudioObjectID) throws -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningInput,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var isRunningInput: UInt32 = 0
        var dataSize = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(
            processObjectID,
            &address,
            0,
            nil,
            &dataSize,
            &isRunningInput
        )
        guard status == noErr else {
            throw DetectorError.osStatus(selector: address.mSelector, status: status)
        }

        return isRunningInput != 0
    }

    private func getProcessPID(_ processObjectID: AudioObjectID) throws -> pid_t {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pid: pid_t = 0
        var dataSize = UInt32(MemoryLayout<pid_t>.size)
        let status = AudioObjectGetPropertyData(
            processObjectID,
            &address,
            0,
            nil,
            &dataSize,
            &pid
        )
        guard status == noErr else {
            throw DetectorError.osStatus(selector: address.mSelector, status: status)
        }

        return pid
    }
}

@main
struct PrismicalMicDetectorMain {
    static func main() {
        let detector = MicDetector()
        detector.start()

        let signalQueue = DispatchQueue(label: "ai.prismical.mic-detector.signals")
        let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
        signal(SIGTERM, SIG_IGN)
        sigtermSource.setEventHandler {
            detector.stop()
            exit(0)
        }
        sigtermSource.resume()

        RunLoop.main.run()
    }
}
