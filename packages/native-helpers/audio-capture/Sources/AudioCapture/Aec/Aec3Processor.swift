import Foundation
import Aec3Bridge

// Thin Swift wrapper around the native AEC3 bridge plus the fixed 10 ms frame contract.

final class Aec3Processor {
    private let sampleRate: Int
    private let channels: Int
    private var handle: UnsafeMutableRawPointer?

    // Allocate the native AEC3 engine handle.
    init(sampleRate: Int = 48_000, channels: Int = 1) {
        self.sampleRate = sampleRate
        self.channels = channels
        self.handle = prismical_aec3_create(Int32(sampleRate), Int32(channels))
    }

    // Free the native AEC3 engine handle if one was created.
    deinit {
        guard let handle else { return }
        prismical_aec3_destroy(handle)
    }

    // True when the real WebRTC AEC3 library is linked, false for the stub.
    var isReal: Bool {
        prismical_aec3_is_real() != 0
    }

    // Feed render (speaker/system) audio so AEC3 can learn the echo path.
    func ingestRender(_ samples: [Float]) {
        guard let handle, !samples.isEmpty else { return }
        _ = samples.withUnsafeBufferPointer { buffer in
            prismical_aec3_ingest_render_samples(handle, buffer.baseAddress, Int32(buffer.count))
        }
    }

    // Run echo cancellation on capture (microphone) audio and return the cleaned signal.
    func processCapture(_ samples: [Float]) -> [Float] {
        guard let handle, !samples.isEmpty else { return samples }

        var output = Array(repeating: Float.zero, count: samples.count)
        let writtenSamples = samples.withUnsafeBufferPointer { inputBuffer in
            output.withUnsafeMutableBufferPointer { outputBuffer in
                Int(
                    prismical_aec3_process_capture_samples(
                        handle,
                        inputBuffer.baseAddress,
                        Int32(samples.count),
                        outputBuffer.baseAddress,
                        Int32(outputBuffer.count)
                    )
                )
            }
        }

        guard writtenSamples > 0 else { return [] }
        return Array(output.prefix(writtenSamples))
    }

    // Process any leftover sub-frame capture samples still buffered in the engine.
    func flushCaptureRemainder() -> [Float]? {
        guard let handle else { return nil }

        var output = Array(repeating: Float.zero, count: FixedFrameAecProcessor.frameSize)
        let writtenSamples = output.withUnsafeMutableBufferPointer { outputBuffer in
            Int(
                prismical_aec3_flush_capture(
                    handle,
                    outputBuffer.baseAddress,
                    Int32(outputBuffer.count)
                )
            )
        }

        guard writtenSamples > 0 else { return nil }
        return Array(output.prefix(writtenSamples))
    }

    // Reinitialize the adaptive filter, discarding all learned echo state.
    func reset() {
        guard let handle else { return }
        prismical_aec3_reset(handle)
    }
}

// Convenience wrapper that delegates to Aec3Processor with the fixed 48 kHz / 480-sample frame contract.
final class FixedFrameAecProcessor {
    static let sampleRate = 48_000
    static let frameSize = 480

    private let processor: Aec3Processor

    init(processor: Aec3Processor = Aec3Processor()) {
        self.processor = processor
    }

    var isReal: Bool {
        processor.isReal
    }

    func ingestRender(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        processor.ingestRender(samples)
    }

    func processCapture(_ samples: [Float]) -> [Float] {
        processor.processCapture(samples)
    }

    func flushCaptureRemainder() -> [Float]? {
        processor.flushCaptureRemainder()
    }

    func reset() {
        processor.reset()
    }
}
