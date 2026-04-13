import Foundation
import Aec3Bridge

private let sampleRate = 48_000
private let channels = 1
private let frameSampleCount = 480
private let defaultHoldbackMs = 300

enum ReplayMode: String {
    case timedIngest = "timed-ingest"
    case rawTrackerAllGaps = "raw-tracker-all-gaps"
    case rawTrackerAllGapsDeferred = "raw-tracker-all-gaps-deferred"
}

enum ReplayError: Error, CustomStringConvertible {
    case usage(String)
    case invalidTrace(String)
    case invalidSidecar(String)
    case bridgeUnavailable

    var description: String {
        switch self {
        case .usage(let message):
            return message
        case .invalidTrace(let message):
            return message
        case .invalidSidecar(let message):
            return message
        case .bridgeUnavailable:
            return "Failed to initialize Prismical timed AEC3 bridge"
        }
    }
}

enum OutputSource: Int32, CaseIterable {
    case micRaw = 1
    case system = 2
    case micProcessed = 3

    var name: String {
        switch self {
        case .micRaw:
            return "mic_raw"
        case .system:
            return "system"
        case .micProcessed:
            return "mic_processed"
        }
    }
}

enum IngestKind {
    case microphone
    case render

    var name: String {
        switch self {
        case .microphone:
            return "microphone"
        case .render:
            return "render"
        }
    }
}

struct Arguments {
    let tracePath: String
    let outputDir: String
    let holdbackMs: Int
    let mode: ReplayMode
}

struct IngestChunk {
    let order: Int
    let kind: IngestKind
    let startSampleIndex: Int64
    let rawStartSampleIndex: Int64?
    let samples: [Float]
}

struct RawChunkStub {
    let order: Int
    let kind: IngestKind
    let samples: [Float]
}

struct TimelineMappingSegment {
    let sessionStartSampleIndex: Int64
    let rawStartSampleIndex: Int64
    let sampleCount: Int

    var sessionEndSampleIndex: Int64 {
        sessionStartSampleIndex + Int64(sampleCount)
    }
}

struct OutputChunk {
    let source: OutputSource
    let sessionStartSampleIndex: Int64
    let presentationStartSampleIndex: Int64
    let samples: [Float]
}

struct ReplaySummary {
    let summaryPath: String
    let ingestRenderSessionPath: String
    let ingestMicrophoneSessionPath: String
    let aecFedRenderPath: String
    let aecFedCapturePath: String
    let oneGoFromFedPath: String
    let systemSessionPath: String
    let micRawSessionPath: String
    let micProcessedSessionPath: String
    let systemPresentationPath: String
    let micRawPresentationPath: String
    let micProcessedPresentationPath: String
    let ingestEventCount: Int
    let renderIngestSamples: Int
    let microphoneIngestSamples: Int
    let outputChunkCounts: [String: Int]
    let outputSampleCounts: [String: Int]
}

struct TraceData {
    let timedIngestChunks: [IngestChunk]
    let rawMicChunks: [RawChunkStub]
    let rawSystemChunks: [RawChunkStub]
    let microphoneTimelineSegments: [TimelineMappingSegment]
    let systemTimelineSegments: [TimelineMappingSegment]
}

final class Float32SidecarCache {
    private var dataByPath: [String: Data] = [:]

    func sliceSamples(filePath: String, sampleOffset: Int, sampleCount: Int) throws -> [Float] {
        guard sampleOffset >= 0, sampleCount >= 0 else {
            throw ReplayError.invalidSidecar("Negative offset/count for \(filePath)")
        }

        let data = try loadData(filePath: filePath)
        let byteOffset = sampleOffset * MemoryLayout<Float>.size
        let byteCount = sampleCount * MemoryLayout<Float>.size
        guard byteOffset + byteCount <= data.count else {
            throw ReplayError.invalidSidecar(
                "Requested samples \(sampleOffset)..<\(sampleOffset + sampleCount) exceed \(filePath)"
            )
        }

        var samples: [Float] = []
        samples.reserveCapacity(sampleCount)
        data.withUnsafeBytes { rawBuffer in
            for index in 0..<sampleCount {
                let bitPattern = rawBuffer.loadUnaligned(
                    fromByteOffset: byteOffset + (index * MemoryLayout<Float>.size),
                    as: UInt32.self
                ).littleEndian
                samples.append(Float(bitPattern: bitPattern))
            }
        }
        return samples
    }

    private func loadData(filePath: String) throws -> Data {
        let resolved = URL(fileURLWithPath: filePath).standardized.path
        if let cached = dataByPath[resolved] {
            return cached
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: resolved))
        dataByPath[resolved] = data
        return data
    }
}

final class TraceTimelineMapper {
    private let segments: [TimelineMappingSegment]

    init(segments: [TimelineMappingSegment]) {
        self.segments = segments.sorted { left, right in
            left.sessionStartSampleIndex < right.sessionStartSampleIndex
        }
    }

    func rawStartSampleIndex(forSessionStartSampleIndex sessionStartSampleIndex: Int64) -> Int64 {
        var lastDelta: Int64 = 0
        var hasSegment = false

        for segment in segments {
            if sessionStartSampleIndex < segment.sessionStartSampleIndex {
                break
            }

            lastDelta = segment.rawStartSampleIndex - segment.sessionStartSampleIndex
            hasSegment = true

            if sessionStartSampleIndex < segment.sessionEndSampleIndex {
                return segment.rawStartSampleIndex +
                    (sessionStartSampleIndex - segment.sessionStartSampleIndex)
            }
        }

        if hasSegment {
            return sessionStartSampleIndex + lastDelta
        }

        return sessionStartSampleIndex
    }
}

struct AudioSegment {
    let startSampleIndex: Int64
    var samples: [Float]

    var endSampleIndex: Int64 {
        startSampleIndex + Int64(samples.count)
    }
}

struct SessionOutputChunk {
    let source: OutputSource
    let sessionStartSampleIndex: Int64
    let samples: [Float]
}

final class LockstepAecBridge {
    private let handle: UnsafeMutableRawPointer

    init(sampleRate: Int = 48_000, channels: Int = 1) throws {
        guard let handle = prismical_aec3_create(Int32(sampleRate), Int32(channels)) else {
            throw ReplayError.bridgeUnavailable
        }
        self.handle = handle
    }

    deinit {
        prismical_aec3_destroy(handle)
    }

    func ingestRender(_ samples: [Float]) {
        guard !samples.isEmpty else { return }
        samples.withUnsafeBufferPointer { buffer in
            _ = prismical_aec3_ingest_render_samples(
                handle,
                buffer.baseAddress,
                Int32(buffer.count)
            )
        }
    }

    func processCapture(_ samples: [Float]) -> [Float] {
        guard !samples.isEmpty else { return [] }

        var output = Array(repeating: Float.zero, count: samples.count)
        let written = samples.withUnsafeBufferPointer { inputBuffer in
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

        guard written > 0 else { return [] }
        return Array(output.prefix(written))
    }

    func reset() {
        prismical_aec3_reset(handle)
    }
}

func runOneGoReplay(renderSamples: [Float], captureSamples: [Float]) throws -> [Float] {
    guard !captureSamples.isEmpty else { return [] }

    guard let handle = prismical_aec3_create(Int32(sampleRate), Int32(channels)) else {
        throw ReplayError.bridgeUnavailable
    }
    defer { prismical_aec3_destroy(handle) }
    var processed: [Float] = []
    processed.reserveCapacity(captureSamples.count)

    var frameStart = 0
    while frameStart < captureSamples.count {
        let captureFrameCount = min(frameSampleCount, captureSamples.count - frameStart)
        var renderFrame = Array(repeating: Float.zero, count: frameSampleCount)
        var captureFrame = Array(repeating: Float.zero, count: frameSampleCount)

        if frameStart < renderSamples.count {
            let renderFrameCount = min(frameSampleCount, renderSamples.count - frameStart)
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

        var outputFrame = Array(repeating: Float.zero, count: frameSampleCount)
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

        let usableCount = min(captureFrameCount, writtenSamples)
        if usableCount > 0 {
            processed.append(contentsOf: outputFrame.prefix(usableCount))
        }

        frameStart += captureFrameCount
    }

    return processed
}

final class LockstepReplaySession {
    private let frameSampleCount: Int
    private let microphoneHoldbackSamples: Int64
    private let renderRetentionSamples = Int64(sampleRate * 5)
    private let aecBridge: LockstepAecBridge
    private let drainDuringIngest: Bool
    private var microphoneSegments: [AudioSegment] = []
    private var renderSegments: [AudioSegment] = []
    private var pendingSystemPacketSamples: [Float] = []
    private var timelineStartSampleIndex: Int64?
    private var nextMicrophoneFrameStart: Int64?
    private var nextSystemPacketFrameStart: Int64?
    private var nextExpectedSystemPacketInputSampleIndex: Int64?
    private var latestMicrophoneSampleIndex: Int64 = 0
    private var latestRenderSampleIndex: Int64 = 0
    private(set) var aecFedRenderSamples: [Float] = []
    private(set) var aecFedCaptureSamples: [Float] = []

    init(holdbackMs: Int, drainDuringIngest: Bool = true) throws {
        self.frameSampleCount = 480
        self.microphoneHoldbackSamples =
            (Int64(sampleRate) * Int64(channels) * Int64(max(0, holdbackMs))) / 1000
        self.aecBridge = try LockstepAecBridge()
        self.drainDuringIngest = drainDuringIngest
    }

    func ingest(_ chunk: IngestChunk) -> [SessionOutputChunk] {
        switch chunk.kind {
        case .microphone:
            return ingestMicrophone(chunk)
        case .render:
            return ingestRender(chunk)
        }
    }

    func finish() -> [SessionOutputChunk] {
        let finalSampleBoundary = max(latestMicrophoneSampleIndex, latestRenderSampleIndex)
        guard finalSampleBoundary > 0 else { return [] }

        let roundedBoundary =
            ((finalSampleBoundary + Int64(frameSampleCount) - 1) / Int64(frameSampleCount)) *
            Int64(frameSampleCount)

        var outputs: [SessionOutputChunk] = []
        drainSystemPackets(through: roundedBoundary, outputs: &outputs)
        drainMicrophoneFrames(through: roundedBoundary, flushing: true, outputs: &outputs)
        return outputs
    }

    private func ingestMicrophone(_ chunk: IngestChunk) -> [SessionOutputChunk] {
        appendSegment(
            AudioSegment(startSampleIndex: chunk.startSampleIndex, samples: chunk.samples),
            to: &microphoneSegments
        )
        if timelineStartSampleIndex == nil {
            timelineStartSampleIndex = chunk.startSampleIndex
        }
        latestMicrophoneSampleIndex = max(
            latestMicrophoneSampleIndex,
            chunk.startSampleIndex + Int64(chunk.samples.count)
        )
        if nextMicrophoneFrameStart == nil {
            nextMicrophoneFrameStart = microphoneSegments.first?.startSampleIndex
        }

        var outputs: [SessionOutputChunk] = []
        if drainDuringIngest {
            let drainBoundary = microphoneDrainBoundary(flushing: false)
            if drainBoundary > 0 {
                drainMicrophoneFrames(through: drainBoundary, flushing: false, outputs: &outputs)
            }
        }
        return outputs
    }

    private func ingestRender(_ chunk: IngestChunk) -> [SessionOutputChunk] {
        appendSegment(
            AudioSegment(startSampleIndex: chunk.startSampleIndex, samples: chunk.samples),
            to: &renderSegments
        )
        if let timelineStartSampleIndex {
            self.timelineStartSampleIndex = min(timelineStartSampleIndex, chunk.startSampleIndex)
        } else {
            timelineStartSampleIndex = chunk.startSampleIndex
        }
        appendSystemPacketSamples(from: chunk)
        latestRenderSampleIndex = max(
            latestRenderSampleIndex,
            chunk.startSampleIndex + Int64(chunk.samples.count)
        )

        var outputs: [SessionOutputChunk] = []
        if drainDuringIngest {
            drainSystemPackets(through: latestRenderSampleIndex, outputs: &outputs)
            let drainBoundary = microphoneDrainBoundary(flushing: false)
            if drainBoundary > 0 {
                drainMicrophoneFrames(through: drainBoundary, flushing: false, outputs: &outputs)
            }
        }
        pruneRenderSegments()
        return outputs
    }

    private func microphoneDrainBoundary(flushing: Bool) -> Int64 {
        if flushing {
            return latestMicrophoneSampleIndex
        }

        let renderReadySampleIndex = latestRenderSampleIndex - microphoneHoldbackSamples
        if renderReadySampleIndex <= 0 {
            return 0
        }

        return max(0, min(latestMicrophoneSampleIndex, renderReadySampleIndex))
    }

    private func drainMicrophoneFrames(
        through sampleIndexExclusive: Int64,
        flushing: Bool,
        outputs: inout [SessionOutputChunk]
    ) {
        guard sampleIndexExclusive > 0 else { return }

        if nextMicrophoneFrameStart == nil {
            if let firstMicrophoneStart = microphoneSegments.first?.startSampleIndex {
                nextMicrophoneFrameStart = min(
                    timelineStartSampleIndex ?? firstMicrophoneStart,
                    firstMicrophoneStart
                )
            } else if flushing {
                nextMicrophoneFrameStart = timelineStartSampleIndex
            }
        }

        while let frameStart = nextMicrophoneFrameStart,
              frameStart + Int64(frameSampleCount) <= sampleIndexExclusive {
            let microphoneFrame = extractSamples(
                from: microphoneSegments,
                startSampleIndex: frameStart,
                frameLength: frameSampleCount,
                fillSilence: true
            ) ?? Array(repeating: .zero, count: frameSampleCount)
            let renderFrame = extractSamples(
                from: renderSegments,
                startSampleIndex: frameStart,
                frameLength: frameSampleCount,
                fillSilence: true
            ) ?? Array(repeating: .zero, count: frameSampleCount)

            aecFedRenderSamples.append(contentsOf: renderFrame)
            aecFedCaptureSamples.append(contentsOf: microphoneFrame)
            drainSystemPackets(through: frameStart + Int64(frameSampleCount), outputs: &outputs)
            aecBridge.ingestRender(renderFrame)
            emitMicrophoneFrame(
                startSampleIndex: frameStart,
                captureSamples: microphoneFrame,
                outputs: &outputs
            )

            nextMicrophoneFrameStart = frameStart + Int64(frameSampleCount)
            pruneMicrophoneSegments(before: nextMicrophoneFrameStart ?? frameStart)
            pruneRenderSegments()
        }
    }

    private func emitMicrophoneFrame(
        startSampleIndex: Int64,
        captureSamples: [Float],
        outputs: inout [SessionOutputChunk]
    ) {
        guard !captureSamples.isEmpty else { return }

        outputs.append(
            SessionOutputChunk(
                source: .micRaw,
                sessionStartSampleIndex: startSampleIndex,
                samples: captureSamples
            )
        )

        let processedRaw = aecBridge.processCapture(captureSamples)
        let processed = normalizeFrameLength(
            processedRaw,
            targetCount: captureSamples.count
        )
        outputs.append(
            SessionOutputChunk(
                source: .micProcessed,
                sessionStartSampleIndex: startSampleIndex,
                samples: processed
            )
        )
    }

    private func normalizeFrameLength(_ samples: [Float], targetCount: Int) -> [Float] {
        if samples.count == targetCount {
            return samples
        }
        if samples.count > targetCount {
            return Array(samples.prefix(targetCount))
        }
        return samples + Array(repeating: Float.zero, count: targetCount - samples.count)
    }

    private func drainSystemPackets(
        through sampleIndexExclusive: Int64,
        outputs: inout [SessionOutputChunk]
    ) {
        guard sampleIndexExclusive > 0 else { return }

        if nextSystemPacketFrameStart == nil {
            guard let timelineStartSampleIndex else { return }
            nextSystemPacketFrameStart = timelineStartSampleIndex
        }

        while let frameStart = nextSystemPacketFrameStart,
              frameStart + Int64(frameSampleCount) <= sampleIndexExclusive {
            outputs.append(
                SessionOutputChunk(
                    source: .system,
                    sessionStartSampleIndex: frameStart,
                    samples: dequeueSystemPacketFrame()
                )
            )
            nextSystemPacketFrameStart = frameStart + Int64(frameSampleCount)
        }
    }

    private func appendSystemPacketSamples(from chunk: IngestChunk) {
        let timelineStart = timelineStartSampleIndex ?? chunk.startSampleIndex
        if nextExpectedSystemPacketInputSampleIndex == nil {
            let initialGapSamples = max(0, Int(chunk.startSampleIndex - timelineStart))
            if initialGapSamples > 0 {
                pendingSystemPacketSamples.append(
                    contentsOf: repeatElement(Float.zero, count: initialGapSamples)
                )
            }
            pendingSystemPacketSamples.append(contentsOf: chunk.samples)
            nextExpectedSystemPacketInputSampleIndex =
                chunk.startSampleIndex + Int64(chunk.samples.count)
            return
        }

        let expectedStart = nextExpectedSystemPacketInputSampleIndex ?? chunk.startSampleIndex
        if chunk.startSampleIndex > expectedStart {
            let gapSamples = Int(chunk.startSampleIndex - expectedStart)
            pendingSystemPacketSamples.append(
                contentsOf: repeatElement(Float.zero, count: gapSamples)
            )
            pendingSystemPacketSamples.append(contentsOf: chunk.samples)
            nextExpectedSystemPacketInputSampleIndex =
                chunk.startSampleIndex + Int64(chunk.samples.count)
            return
        }

        let overlapSamples = max(0, Int(expectedStart - chunk.startSampleIndex))
        guard overlapSamples < chunk.samples.count else { return }
        pendingSystemPacketSamples.append(contentsOf: chunk.samples.dropFirst(overlapSamples))
        nextExpectedSystemPacketInputSampleIndex =
            expectedStart + Int64(chunk.samples.count - overlapSamples)
    }

    private func dequeueSystemPacketFrame() -> [Float] {
        if pendingSystemPacketSamples.count >= frameSampleCount {
            let frame = Array(pendingSystemPacketSamples.prefix(frameSampleCount))
            pendingSystemPacketSamples.removeFirst(frameSampleCount)
            return frame
        }

        if pendingSystemPacketSamples.isEmpty {
            return Array(repeating: Float.zero, count: frameSampleCount)
        }

        let frame = pendingSystemPacketSamples +
            Array(repeating: Float.zero, count: frameSampleCount - pendingSystemPacketSamples.count)
        pendingSystemPacketSamples.removeAll(keepingCapacity: true)
        return frame
    }

    private func appendSegment(_ segment: AudioSegment, to segments: inout [AudioSegment]) {
        guard !segment.samples.isEmpty else { return }

        if let lastSegment = segments.last, segment.startSampleIndex <= lastSegment.endSampleIndex {
            let overlap = max(0, Int(lastSegment.endSampleIndex - segment.startSampleIndex))
            guard overlap < segment.samples.count else { return }
            segments[segments.count - 1].samples.append(contentsOf: segment.samples.dropFirst(overlap))
            return
        }

        segments.append(segment)
    }

    private func extractSamples(
        from segments: [AudioSegment],
        startSampleIndex: Int64,
        frameLength: Int,
        fillSilence: Bool
    ) -> [Float]? {
        guard frameLength > 0 else { return [] }

        let endSampleIndex = startSampleIndex + Int64(frameLength)
        var output = Array(repeating: Float.zero, count: frameLength)
        var coverageCursor = startSampleIndex
        var wroteSamples = false

        for segment in segments {
            if segment.endSampleIndex <= startSampleIndex {
                continue
            }
            if segment.startSampleIndex >= endSampleIndex {
                break
            }

            let overlapStart = max(startSampleIndex, segment.startSampleIndex)
            let overlapEnd = min(endSampleIndex, segment.endSampleIndex)
            guard overlapEnd > overlapStart else { continue }

            if !fillSilence && overlapStart > coverageCursor {
                return nil
            }

            let sourceOffset = Int(overlapStart - segment.startSampleIndex)
            let destinationOffset = Int(overlapStart - startSampleIndex)
            let sampleCount = Int(overlapEnd - overlapStart)
            output.replaceSubrange(
                destinationOffset..<(destinationOffset + sampleCount),
                with: segment.samples[sourceOffset..<(sourceOffset + sampleCount)]
            )

            coverageCursor = overlapEnd
            wroteSamples = true
        }

        if !fillSilence && coverageCursor < endSampleIndex {
            return nil
        }

        return wroteSamples || fillSilence ? output : nil
    }

    private func pruneMicrophoneSegments(before sampleIndex: Int64) {
        microphoneSegments = trimSegments(microphoneSegments, before: sampleIndex)
    }

    private func pruneRenderSegments() {
        guard !renderSegments.isEmpty else { return }

        let retentionBoundary = max(0, latestRenderSampleIndex - renderRetentionSamples)
        let pendingMicrophoneBoundary = nextMicrophoneFrameStart ?? retentionBoundary
        let pendingSystemPacketBoundary = nextSystemPacketFrameStart ?? retentionBoundary
        let pruneBefore = min(retentionBoundary, min(pendingMicrophoneBoundary, pendingSystemPacketBoundary))
        renderSegments = trimSegments(renderSegments, before: pruneBefore)
    }

    private func trimSegments(_ segments: [AudioSegment], before sampleIndex: Int64) -> [AudioSegment] {
        guard sampleIndex > 0 else { return segments }

        return segments.compactMap { segment in
            if segment.endSampleIndex <= sampleIndex {
                return nil
            }

            if segment.startSampleIndex >= sampleIndex {
                return segment
            }

            let trimCount = Int(sampleIndex - segment.startSampleIndex)
            guard trimCount < segment.samples.count else { return nil }

            return AudioSegment(
                startSampleIndex: sampleIndex,
                samples: Array(segment.samples.dropFirst(trimCount))
            )
        }
    }
}

func main() throws {
    let arguments = try parseArguments()
    let traceData = try loadTraceData(tracePath: arguments.tracePath)
    let outputDirURL = URL(fileURLWithPath: arguments.outputDir, isDirectory: true)
    try FileManager.default.createDirectory(
        at: outputDirURL,
        withIntermediateDirectories: true
    )

    let summary = try replayTrace(
        tracePath: arguments.tracePath,
        outputDirURL: outputDirURL,
        holdbackMs: arguments.holdbackMs,
        mode: arguments.mode,
        ingestChunks: reconstructIngestChunks(traceData: traceData, mode: arguments.mode),
        microphoneTimelineMapper: makeTimelineMapper(
            source: .microphone,
            traceData: traceData,
            mode: arguments.mode
        ),
        systemTimelineMapper: makeTimelineMapper(
            source: .render,
            traceData: traceData,
            mode: arguments.mode
        )
    )

    let payload: [String: Any] = [
        "tracePath": arguments.tracePath,
        "outputDir": arguments.outputDir,
        "holdbackMs": arguments.holdbackMs,
        "mode": arguments.mode.rawValue,
        "summaryPath": summary.summaryPath,
        "ingestEventCount": summary.ingestEventCount,
        "renderIngestSamples": summary.renderIngestSamples,
        "microphoneIngestSamples": summary.microphoneIngestSamples,
        "outputChunkCounts": summary.outputChunkCounts,
        "outputSampleCounts": summary.outputSampleCounts,
        "files": [
            "ingestRenderSessionPath": summary.ingestRenderSessionPath,
            "ingestMicrophoneSessionPath": summary.ingestMicrophoneSessionPath,
            "systemSessionPath": summary.systemSessionPath,
            "micRawSessionPath": summary.micRawSessionPath,
            "micProcessedSessionPath": summary.micProcessedSessionPath,
            "systemPresentationPath": summary.systemPresentationPath,
            "micRawPresentationPath": summary.micRawPresentationPath,
            "micProcessedPresentationPath": summary.micProcessedPresentationPath
        ]
    ]

    let json = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func parseArguments() throws -> Arguments {
    let args = Array(CommandLine.arguments.dropFirst())
    var tracePath: String?
    var outputDir: String?
    var holdbackMs = defaultHoldbackMs
    var mode: ReplayMode = .timedIngest

    var index = 0
    while index < args.count {
        let token = args[index]
        guard index + 1 < args.count else {
            throw ReplayError.usage("Missing value for \(token)")
        }

        switch token {
        case "--trace":
            tracePath = args[index + 1]
        case "--output-dir":
            outputDir = args[index + 1]
        case "--holdback-ms":
            guard let parsed = Int(args[index + 1]) else {
                throw ReplayError.usage("Invalid integer for --holdback-ms")
            }
            holdbackMs = max(0, parsed)
        case "--mode":
            guard let parsed = ReplayMode(rawValue: args[index + 1]) else {
                throw ReplayError.usage("Invalid value for --mode")
            }
            mode = parsed
        default:
            throw ReplayError.usage("Unknown argument: \(token)")
        }

        index += 2
    }

    guard let tracePath, let outputDir else {
        throw ReplayError.usage(
            "Usage: prismical-aec3-live-trace-replay --trace <native-capture-trace.jsonl> --output-dir <dir> [--holdback-ms 300] [--mode timed-ingest|raw-tracker-all-gaps]"
        )
    }

    return Arguments(
        tracePath: tracePath,
        outputDir: outputDir,
        holdbackMs: holdbackMs,
        mode: mode
    )
}

typealias JsonObject = [String: Any]

func loadTraceData(tracePath: String) throws -> TraceData {
    let lines = try String(contentsOfFile: tracePath, encoding: .utf8)
        .split(separator: "\n", omittingEmptySubsequences: true)
        .map(String.init)

    let cache = Float32SidecarCache()
    var timedIngestChunks: [IngestChunk] = []
    var rawMicChunks: [RawChunkStub] = []
    var rawSystemChunks: [RawChunkStub] = []
    var microphoneTimelineSegments: [TimelineMappingSegment] = []
    var systemTimelineSegments: [TimelineMappingSegment] = []

    for (order, line) in lines.enumerated() {
        guard let data = line.data(using: .utf8) else {
            throw ReplayError.invalidTrace("Invalid UTF-8 at line \(order + 1)")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? JsonObject else {
            throw ReplayError.invalidTrace("Invalid JSON object at line \(order + 1)")
        }

        let event = stringValue(json, key: "event") ?? ""
        switch event {
        case "timed_session_ingest_microphone", "timed_session_ingest_render":
            guard let startSampleIndex = int64Value(json, key: "startSampleIndex"),
                  intValue(json, key: "sampleCount") != nil,
                  let traceFilePath = stringValue(json, key: "traceFilePath"),
                  let traceSampleOffset = intValue(json, key: "traceSampleOffset"),
                  let traceSampleCount = intValue(json, key: "traceSampleCount")
            else {
                throw ReplayError.invalidTrace("Missing timed ingest fields at line \(order + 1)")
            }

            let samples = try cache.sliceSamples(
                filePath: traceFilePath,
                sampleOffset: traceSampleOffset,
                sampleCount: traceSampleCount
            )

            timedIngestChunks.append(
                IngestChunk(
                    order: order,
                    kind: event == "timed_session_ingest_microphone" ? .microphone : .render,
                    startSampleIndex: startSampleIndex,
                    rawStartSampleIndex: int64Value(json, key: "rawStartSampleIndex"),
                    samples: samples
                )
            )

        case "mic_audio_unit_callback":
            guard let traceFilePath = stringValue(json, key: "traceFilePath"),
                  let traceSampleOffset = intValue(json, key: "traceSampleOffset"),
                  let traceSampleCount = intValue(json, key: "traceSampleCount")
            else {
                throw ReplayError.invalidTrace("Missing mic raw callback fields at line \(order + 1)")
            }
            rawMicChunks.append(
                RawChunkStub(
                    order: order,
                    kind: .microphone,
                    samples: try cache.sliceSamples(
                        filePath: traceFilePath,
                        sampleOffset: traceSampleOffset,
                        sampleCount: traceSampleCount
                    )
                )
            )

        case "system-selected_post_resample":
            guard let traceFilePath = stringValue(json, key: "traceFilePath"),
                  let traceSampleOffset = intValue(json, key: "traceSampleOffset"),
                  let traceSampleCount = intValue(json, key: "traceSampleCount")
            else {
                throw ReplayError.invalidTrace("Missing system raw callback fields at line \(order + 1)")
            }
            rawSystemChunks.append(
                RawChunkStub(
                    order: order,
                    kind: .render,
                    samples: try cache.sliceSamples(
                        filePath: traceFilePath,
                        sampleOffset: traceSampleOffset,
                        sampleCount: traceSampleCount
                    )
                )
            )

        case "microphone_session_timeline_map":
            if let segment = try makeTimelineSegment(json: json, event: event) {
                microphoneTimelineSegments.append(segment)
            }

        case "system_session_timeline_map":
            if let segment = try makeTimelineSegment(json: json, event: event) {
                systemTimelineSegments.append(segment)
            }

        default:
            break
        }
    }

    if timedIngestChunks.isEmpty {
        throw ReplayError.invalidTrace("No timed_session_ingest_* events found in \(tracePath)")
    }

    return TraceData(
        timedIngestChunks: timedIngestChunks.sorted { $0.order < $1.order },
        rawMicChunks: rawMicChunks.sorted { $0.order < $1.order },
        rawSystemChunks: rawSystemChunks.sorted { $0.order < $1.order },
        microphoneTimelineSegments: microphoneTimelineSegments.sorted { $0.sessionStartSampleIndex < $1.sessionStartSampleIndex },
        systemTimelineSegments: systemTimelineSegments.sorted { $0.sessionStartSampleIndex < $1.sessionStartSampleIndex }
    )
}

enum MapperSource {
    case microphone
    case render
}

func reconstructIngestChunks(traceData: TraceData, mode: ReplayMode) -> [IngestChunk] {
    switch mode {
    case .timedIngest:
        return traceData.timedIngestChunks
    case .rawTrackerAllGaps, .rawTrackerAllGapsDeferred:
        precondition(traceData.rawMicChunks.count == traceData.microphoneTimelineSegments.count)
        precondition(traceData.rawSystemChunks.count == traceData.systemTimelineSegments.count)

        let micChunks = zip(traceData.rawMicChunks, traceData.microphoneTimelineSegments).map { rawChunk, timeline in
            IngestChunk(
                order: rawChunk.order,
                kind: .microphone,
                startSampleIndex: timeline.rawStartSampleIndex,
                rawStartSampleIndex: timeline.rawStartSampleIndex,
                samples: rawChunk.samples
            )
        }
        let systemChunks = zip(traceData.rawSystemChunks, traceData.systemTimelineSegments).map { rawChunk, timeline in
            IngestChunk(
                order: rawChunk.order,
                kind: .render,
                startSampleIndex: timeline.rawStartSampleIndex,
                rawStartSampleIndex: timeline.rawStartSampleIndex,
                samples: rawChunk.samples
            )
        }
        return (micChunks + systemChunks).sorted { left, right in
            left.order < right.order
        }
    }
}

func makeTimelineMapper(source: MapperSource, traceData: TraceData, mode: ReplayMode) -> TraceTimelineMapper {
    let baseSegments: [TimelineMappingSegment]
    switch source {
    case .microphone:
        baseSegments = traceData.microphoneTimelineSegments
    case .render:
        baseSegments = traceData.systemTimelineSegments
    }

    switch mode {
    case .timedIngest:
        return TraceTimelineMapper(segments: baseSegments)
    case .rawTrackerAllGaps, .rawTrackerAllGapsDeferred:
        let identitySegments = baseSegments.map { segment in
            TimelineMappingSegment(
                sessionStartSampleIndex: segment.rawStartSampleIndex,
                rawStartSampleIndex: segment.rawStartSampleIndex,
                sampleCount: segment.sampleCount
            )
        }
        return TraceTimelineMapper(segments: identitySegments)
    }
}

func makeTimelineSegment(json: JsonObject, event: String) throws -> TimelineMappingSegment? {
    guard let rawStartSampleIndex = int64Value(json, key: "rawStartSampleIndex"),
          let sessionStartSampleIndex = int64Value(json, key: "sessionStartSampleIndex"),
          let sampleCount = intValue(json, key: "sampleCount")
    else {
        throw ReplayError.invalidTrace("Missing timeline mapping fields for \(event)")
    }

    return TimelineMappingSegment(
        sessionStartSampleIndex: sessionStartSampleIndex,
        rawStartSampleIndex: rawStartSampleIndex,
        sampleCount: sampleCount
    )
}

func replayTrace(
    tracePath: String,
    outputDirURL: URL,
    holdbackMs: Int,
    mode: ReplayMode,
    ingestChunks: [IngestChunk],
    microphoneTimelineMapper: TraceTimelineMapper,
    systemTimelineMapper: TraceTimelineMapper
) throws -> ReplaySummary {
    let session = try LockstepReplaySession(
        holdbackMs: holdbackMs,
        drainDuringIngest: mode != .rawTrackerAllGapsDeferred
    )

    var renderIngestChunks: [(start: Int64, samples: [Float])] = []
    var microphoneIngestChunks: [(start: Int64, samples: [Float])] = []
    var outputChunks: [OutputChunk] = []

    func appendOutputs(_ sessionOutputs: [SessionOutputChunk]) {
        for output in sessionOutputs {
            let presentationStartSampleIndex: Int64
            switch output.source {
            case .system:
                presentationStartSampleIndex =
                    systemTimelineMapper.rawStartSampleIndex(
                        forSessionStartSampleIndex: output.sessionStartSampleIndex
                    )
            case .micRaw, .micProcessed:
                presentationStartSampleIndex =
                    microphoneTimelineMapper.rawStartSampleIndex(
                        forSessionStartSampleIndex: output.sessionStartSampleIndex
                    )
            }

            outputChunks.append(
                OutputChunk(
                    source: output.source,
                    sessionStartSampleIndex: output.sessionStartSampleIndex,
                    presentationStartSampleIndex: presentationStartSampleIndex,
                    samples: output.samples
                )
            )
        }
    }

    for chunk in ingestChunks {
        switch chunk.kind {
        case .microphone:
            microphoneIngestChunks.append((chunk.startSampleIndex, chunk.samples))
        case .render:
            renderIngestChunks.append((chunk.startSampleIndex, chunk.samples))
        }
        appendOutputs(session.ingest(chunk))
    }

    appendOutputs(session.finish())

    let ingestRenderSessionPath = outputDirURL.appendingPathComponent("ingest-render-session.wav").path
    let ingestMicrophoneSessionPath = outputDirURL.appendingPathComponent("ingest-microphone-session.wav").path
    let aecFedRenderPath = outputDirURL.appendingPathComponent("aec-fed-render.wav").path
    let aecFedCapturePath = outputDirURL.appendingPathComponent("aec-fed-capture.wav").path
    let oneGoFromFedPath = outputDirURL.appendingPathComponent("onego-from-fed.wav").path
    let systemSessionPath = outputDirURL.appendingPathComponent("output-system-session.wav").path
    let micRawSessionPath = outputDirURL.appendingPathComponent("output-mic_raw-session.wav").path
    let micProcessedSessionPath = outputDirURL.appendingPathComponent("output-mic_processed-session.wav").path
    let systemPresentationPath = outputDirURL.appendingPathComponent("output-system-presentation.wav").path
    let micRawPresentationPath = outputDirURL.appendingPathComponent("output-mic_raw-presentation.wav").path
    let micProcessedPresentationPath = outputDirURL.appendingPathComponent("output-mic_processed-presentation.wav").path

    try writeTimelineWav(
        to: ingestRenderSessionPath,
        chunks: renderIngestChunks.map { TimedTimelineChunk(startSampleIndex: $0.start, samples: $0.samples) }
    )
    try writeTimelineWav(
        to: ingestMicrophoneSessionPath,
        chunks: microphoneIngestChunks.map { TimedTimelineChunk(startSampleIndex: $0.start, samples: $0.samples) }
    )
    try writeWavFile(to: aecFedRenderPath, samples: session.aecFedRenderSamples, sampleRate: sampleRate)
    try writeWavFile(to: aecFedCapturePath, samples: session.aecFedCaptureSamples, sampleRate: sampleRate)
    try writeWavFile(
        to: oneGoFromFedPath,
        samples: try runOneGoReplay(
            renderSamples: session.aecFedRenderSamples,
            captureSamples: session.aecFedCaptureSamples
        ),
        sampleRate: sampleRate
    )

    let systemOutputs = outputChunks.filter { $0.source == .system }
    let micRawOutputs = outputChunks.filter { $0.source == .micRaw }
    let micProcessedOutputs = outputChunks.filter { $0.source == .micProcessed }

    try writeTimelineWav(
        to: systemSessionPath,
        chunks: systemOutputs.map {
            TimedTimelineChunk(startSampleIndex: $0.sessionStartSampleIndex, samples: $0.samples)
        }
    )
    try writeTimelineWav(
        to: micRawSessionPath,
        chunks: micRawOutputs.map {
            TimedTimelineChunk(startSampleIndex: $0.sessionStartSampleIndex, samples: $0.samples)
        }
    )
    try writeTimelineWav(
        to: micProcessedSessionPath,
        chunks: micProcessedOutputs.map {
            TimedTimelineChunk(startSampleIndex: $0.sessionStartSampleIndex, samples: $0.samples)
        }
    )
    try writeTimelineWav(
        to: systemPresentationPath,
        chunks: systemOutputs.map {
            TimedTimelineChunk(startSampleIndex: $0.presentationStartSampleIndex, samples: $0.samples)
        }
    )
    try writeTimelineWav(
        to: micRawPresentationPath,
        chunks: micRawOutputs.map {
            TimedTimelineChunk(startSampleIndex: $0.presentationStartSampleIndex, samples: $0.samples)
        }
    )
    try writeTimelineWav(
        to: micProcessedPresentationPath,
        chunks: micProcessedOutputs.map {
            TimedTimelineChunk(startSampleIndex: $0.presentationStartSampleIndex, samples: $0.samples)
        }
    )

    let outputChunkCounts = Dictionary(
        uniqueKeysWithValues: OutputSource.allCases.map { source in
            (source.name, outputChunks.filter { $0.source == source }.count)
        }
    )
    let outputSampleCounts = Dictionary(
        uniqueKeysWithValues: OutputSource.allCases.map { source in
            (source.name, outputChunks.filter { $0.source == source }.reduce(0) { $0 + $1.samples.count })
        }
    )

    let summaryPayload: [String: Any] = [
        "tracePath": tracePath,
        "holdbackMs": holdbackMs,
        "ingestEventCount": ingestChunks.count,
        "renderIngestSamples": renderIngestChunks.reduce(0) { $0 + $1.samples.count },
        "microphoneIngestSamples": microphoneIngestChunks.reduce(0) { $0 + $1.samples.count },
        "outputChunkCounts": outputChunkCounts,
        "outputSampleCounts": outputSampleCounts,
        "files": [
            "ingestRenderSessionPath": ingestRenderSessionPath,
            "ingestMicrophoneSessionPath": ingestMicrophoneSessionPath,
            "aecFedRenderPath": aecFedRenderPath,
            "aecFedCapturePath": aecFedCapturePath,
            "oneGoFromFedPath": oneGoFromFedPath,
            "systemSessionPath": systemSessionPath,
            "micRawSessionPath": micRawSessionPath,
            "micProcessedSessionPath": micProcessedSessionPath,
            "systemPresentationPath": systemPresentationPath,
            "micRawPresentationPath": micRawPresentationPath,
            "micProcessedPresentationPath": micProcessedPresentationPath
        ]
    ]
    let summaryPath = outputDirURL.appendingPathComponent("summary.json").path
    let summaryData = try JSONSerialization.data(withJSONObject: summaryPayload, options: [.prettyPrinted, .sortedKeys])
    try summaryData.write(to: URL(fileURLWithPath: summaryPath))

    return ReplaySummary(
        summaryPath: summaryPath,
        ingestRenderSessionPath: ingestRenderSessionPath,
        ingestMicrophoneSessionPath: ingestMicrophoneSessionPath,
        aecFedRenderPath: aecFedRenderPath,
        aecFedCapturePath: aecFedCapturePath,
        oneGoFromFedPath: oneGoFromFedPath,
        systemSessionPath: systemSessionPath,
        micRawSessionPath: micRawSessionPath,
        micProcessedSessionPath: micProcessedSessionPath,
        systemPresentationPath: systemPresentationPath,
        micRawPresentationPath: micRawPresentationPath,
        micProcessedPresentationPath: micProcessedPresentationPath,
        ingestEventCount: ingestChunks.count,
        renderIngestSamples: renderIngestChunks.reduce(0) { $0 + $1.samples.count },
        microphoneIngestSamples: microphoneIngestChunks.reduce(0) { $0 + $1.samples.count },
        outputChunkCounts: outputChunkCounts,
        outputSampleCounts: outputSampleCounts
    )
}

struct TimedTimelineChunk {
    let startSampleIndex: Int64
    let samples: [Float]
}

func writeTimelineWav(to path: String, chunks: [TimedTimelineChunk]) throws {
    let samples = renderTimeline(chunks: chunks)
    try writeWavFile(to: path, samples: samples, sampleRate: sampleRate)
}

func renderTimeline(chunks: [TimedTimelineChunk]) -> [Float] {
    guard !chunks.isEmpty else { return [] }

    let sorted = chunks.sorted { left, right in
        left.startSampleIndex < right.startSampleIndex
    }
    let totalLength = sorted.reduce(Int64(0)) { partial, chunk in
        max(partial, chunk.startSampleIndex + Int64(chunk.samples.count))
    }
    guard totalLength > 0 else { return [] }

    var output = Array(repeating: Float.zero, count: Int(totalLength))
    for chunk in sorted {
        guard chunk.startSampleIndex >= 0 else { continue }
        let start = Int(chunk.startSampleIndex)
        if start >= output.count {
            continue
        }
        let writeCount = min(chunk.samples.count, output.count - start)
        guard writeCount > 0 else { continue }
        output.replaceSubrange(start..<(start + writeCount), with: chunk.samples.prefix(writeCount))
    }

    return output
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

func stringValue(_ json: JsonObject, key: String) -> String? {
    json[key] as? String
}

func intValue(_ json: JsonObject, key: String) -> Int? {
    if let value = json[key] as? Int {
        return value
    }
    if let value = json[key] as? NSNumber {
        return value.intValue
    }
    return nil
}

func int64Value(_ json: JsonObject, key: String) -> Int64? {
    if let value = json[key] as? Int64 {
        return value
    }
    if let value = json[key] as? Int {
        return Int64(value)
    }
    if let value = json[key] as? NSNumber {
        return value.int64Value
    }
    return nil
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
