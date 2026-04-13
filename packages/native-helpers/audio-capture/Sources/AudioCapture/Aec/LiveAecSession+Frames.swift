import Foundation

// Frame draining, gap materialization, and segment-retention helpers for the live AEC session.

extension NativeTimedDualAecSession {
    // Materialize the next eligible 10 ms capture/render pair on the shared session timeline.
    func drainMicrophoneFrames(
        through sampleIndexExclusive: Int64,
        flushing: Bool,
        outputs: inout [NativeTimedSessionOutputChunk]
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

            drainSystemPackets(through: frameStart + Int64(frameSampleCount), outputs: &outputs)
            aecProcessor.ingestRender(renderFrame)
            emitMicrophoneFrame(
                startSampleIndex: frameStart,
                captureSamples: microphoneFrame,
                outputs: &outputs
            )

            nextMicrophoneFrameStart = frameStart + Int64(frameSampleCount)
            pruneMicrophoneFrameWaitRuns(before: nextMicrophoneFrameStart ?? frameStart)
            pruneMicrophoneSegments(before: nextMicrophoneFrameStart ?? frameStart)
            pruneRenderSegments()
        }
    }

    // Emit mic_raw and mic_processed as identical passthrough — no AEC3 involved.
    func emitMicrophoneFramePassthrough(
        startSampleIndex: Int64,
        captureSamples: [Float],
        outputs: inout [NativeTimedSessionOutputChunk]
    ) {
        guard !captureSamples.isEmpty else { return }

        outputs.append(makeOutputChunk(
            source: .micRaw,
            startSampleIndex: startSampleIndex,
            samples: captureSamples
        ))
        outputs.append(makeOutputChunk(
            source: .micProcessed,
            startSampleIndex: startSampleIndex,
            samples: captureSamples
        ))
    }

    // Emit mic_raw (passthrough) and mic_processed (echo-cancelled) output chunks for one frame.
    func emitMicrophoneFrame(
        startSampleIndex: Int64,
        captureSamples: [Float],
        outputs: inout [NativeTimedSessionOutputChunk]
    ) {
        guard !captureSamples.isEmpty else { return }

        outputs.append(makeOutputChunk(
            source: .micRaw,
            startSampleIndex: startSampleIndex,
            samples: captureSamples
        ))

        let processedSamples = normalizedFrameLength(
            aecProcessor.processCapture(captureSamples),
            targetCount: captureSamples.count
        )
        outputs.append(makeOutputChunk(
            source: .micProcessed,
            startSampleIndex: startSampleIndex,
            samples: processedSamples
        ))
    }

    // Pad or truncate a sample array to exactly targetCount samples.
    func normalizedFrameLength(_ samples: [Float], targetCount: Int) -> [Float] {
        if samples.count == targetCount {
            return samples
        }
        if samples.count > targetCount {
            return Array(samples.prefix(targetCount))
        }
        return samples + Array(repeating: Float.zero, count: targetCount - samples.count)
    }

    // Dequeue complete 10 ms system-audio frames from the pending buffer and emit them as output.
    func drainSystemPackets(
        through sampleIndexExclusive: Int64,
        outputs: inout [NativeTimedSessionOutputChunk]
    ) {
        guard sampleIndexExclusive > 0 else { return }

        if nextSystemPacketFrameStart == nil {
            guard let timelineStartSampleIndex else { return }
            nextSystemPacketFrameStart = timelineStartSampleIndex
        }

        while let frameStart = nextSystemPacketFrameStart,
              frameStart + Int64(frameSampleCount) <= sampleIndexExclusive {
            let systemFrame = dequeueSystemPacketFrame()
            outputs.append(makeOutputChunk(
                source: .system,
                startSampleIndex: frameStart,
                samples: systemFrame
            ))
            nextSystemPacketFrameStart = frameStart + Int64(frameSampleCount)
        }
    }

    // Build a traced output chunk for a given source (mic_raw, mic_processed, or system).
    func makeOutputChunk(
        source: CaptureSource,
        startSampleIndex: Int64,
        samples: [Float]
    ) -> NativeTimedSessionOutputChunk {
        traceWriter?.recordSamples(
            event: "timed_session_output",
            channel: "timed-session-output-\(captureSourceName(source))",
            samples: samples,
            metadata: [
                "source": captureSourceName(source),
                "startSampleIndex": startSampleIndex,
                "sampleCount": samples.count
            ]
        )

        return NativeTimedSessionOutputChunk(
            source: source,
            startSampleIndex: startSampleIndex,
            samples: samples
        )
    }

    // Append render samples to the flat system-packet buffer, inserting silence for any gaps.
    func appendSystemPacketSamples(from chunk: TimedAudioChunk) {
        guard !chunk.samples.isEmpty else { return }

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

    // Pop one 480-sample frame from the pending system-packet buffer, zero-padding if underrun.
    func dequeueSystemPacketFrame() -> [Float] {
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

    // Merge a new audio chunk into the segment list, coalescing with the tail if contiguous/overlapping.
    func appendSegment(_ segment: AudioSegment, to segments: inout [AudioSegment]) {
        guard !segment.samples.isEmpty else { return }

        if let lastSegment = segments.last, segment.startSampleIndex <= lastSegment.endSampleIndex {
            let overlap = max(0, Int(lastSegment.endSampleIndex - segment.startSampleIndex))
            guard overlap < segment.samples.count else { return }
            segments[segments.count - 1].samples.append(contentsOf: segment.samples.dropFirst(overlap))
            return
        }

        segments.append(segment)
    }

    // Read exactly frameLength samples from the segment list at the given position, filling gaps with silence.
    func extractSamples(
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

    // Discard microphone segment data that has already been processed.
    func pruneMicrophoneSegments(before sampleIndex: Int64) {
        microphoneSegments = trimSegments(microphoneSegments, before: sampleIndex)
    }

    // Free render data that falls before the earliest still-needed cursor (mic, system, or retention).
    func pruneRenderSegments() {
        guard !renderSegments.isEmpty else { return }

        let retentionBoundary = max(0, latestRenderSampleIndex - renderRetentionSamples)
        let pendingMicrophoneBoundary = nextMicrophoneFrameStart ?? retentionBoundary
        let pendingSystemPacketBoundary = nextSystemPacketFrameStart ?? retentionBoundary
        let pruneBefore = min(
            retentionBoundary,
            min(pendingMicrophoneBoundary, pendingSystemPacketBoundary)
        )
        renderSegments = trimSegments(renderSegments, before: pruneBefore)
    }

    // Return a copy of segments with all data before sampleIndex removed.
    func trimSegments(_ segments: [AudioSegment], before sampleIndex: Int64) -> [AudioSegment] {
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
