import Foundation
import Darwin

// Production executable entrypoint for the native audio-capture helper.

@main
struct AudioCaptureApp {
    static func main() {
        let coordinator: CaptureCoordinator
        let checkSystemAudioPermission: Bool

        do {
            let parsedArguments = try parseArguments()
            coordinator = CaptureCoordinator(
                mode: parsedArguments.mode,
                debugArtifactsDirectory: parsedArguments.debugArtifactsDirectory,
                aecRenderHoldbackMs: parsedArguments.aecRenderHoldbackMs,
                aecRenderWaitTimeoutMs: parsedArguments.aecRenderWaitTimeoutMs
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
