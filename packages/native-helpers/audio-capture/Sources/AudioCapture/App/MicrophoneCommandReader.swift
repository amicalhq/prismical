import Foundation

private struct MicrophoneCommandPayload: Decodable {
    let cmd: String
    let uid: String?
    let rev: Int
}

// Reads declarative microphone commands without tying stdin EOF to process lifetime.
final class MicrophoneCommandReader {
    private weak var coordinator: CaptureCoordinator?
    private let queue = DispatchQueue(label: "ai.prismical.audio-capture.stdin")
    private var pending = Data()

    init(coordinator: CaptureCoordinator) {
        self.coordinator = coordinator
    }

    func start() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            self?.queue.async {
                self?.consume(data)
            }
        }
    }

    func stop() {
        FileHandle.standardInput.readabilityHandler = nil
    }

    private func consume(_ data: Data) {
        pending.append(data)
        while let newlineIndex = pending.firstIndex(of: 0x0A) {
            let line = Data(pending[..<newlineIndex])
            pending.removeSubrange(...newlineIndex)
            handleLine(line)
        }
    }

    private func handleLine(_ data: Data) {
        guard !data.isEmpty,
              let command = try? JSONDecoder().decode(MicrophoneCommandPayload.self, from: data),
              command.rev >= 0
        else {
            Logger.error("Ignoring invalid microphone command")
            return
        }

        switch command.cmd {
        case "set-mic":
            guard let uid = command.uid, !uid.isEmpty else {
                Logger.error("Ignoring set-mic command without a device UID")
                return
            }
            coordinator?.setMicrophone(uid: uid, revision: command.rev)
        case "follow-default":
            coordinator?.followDefaultMicrophone(revision: command.rev)
        default:
            Logger.error("Ignoring unknown microphone command: \(command.cmd)")
        }
    }
}
