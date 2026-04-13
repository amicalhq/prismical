import Foundation

// Shared sample-index tracking and raw-to-session timeline mapping helpers.

struct TimedAudioChunk {
    let startSampleIndex: Int64
    let rawStartSampleIndex: Int64
    let samples: [Float]
}

private struct TimelineMappingSegment {
    let sessionStartSampleIndex: Int64
    let rawStartSampleIndex: Int64
    let sampleCount: Int

    var sessionEndSampleIndex: Int64 {
        sessionStartSampleIndex + Int64(sampleCount)
    }
}

struct TimelineRegistration {
    let sessionStartSampleIndex: Int64
    let rawGapSampleCount: Int64
    let preservedGapSampleCount: Int64
}

final class CollapsedSourceTimelineMapper {
    private let lock = NSLock()
    private let minimumGapToPreserve: Int64
    private var nextCollapsedStartSampleIndex: Int64?
    private var previousRawEndSampleIndex: Int64?
    private var segments: [TimelineMappingSegment] = []

    init(minimumGapToPreserve: Int64 = 1) {
        self.minimumGapToPreserve = max(0, minimumGapToPreserve)
    }

    func registerChunk(rawStartSampleIndex: Int64, sampleCount: Int) -> TimelineRegistration {
        lock.lock()
        defer { lock.unlock() }

        let rawGapSampleCount = max(
            Int64(0),
            rawStartSampleIndex - (previousRawEndSampleIndex ?? rawStartSampleIndex)
        )
        let preservedGapSampleCount =
            rawGapSampleCount > minimumGapToPreserve ? rawGapSampleCount : 0
        let sessionStartSampleIndex = if let nextCollapsedStartSampleIndex {
            nextCollapsedStartSampleIndex + preservedGapSampleCount
        } else {
            rawStartSampleIndex
        }
        nextCollapsedStartSampleIndex = sessionStartSampleIndex + Int64(sampleCount)
        previousRawEndSampleIndex = rawStartSampleIndex + Int64(sampleCount)
        segments.append(
            TimelineMappingSegment(
                sessionStartSampleIndex: sessionStartSampleIndex,
                rawStartSampleIndex: rawStartSampleIndex,
                sampleCount: sampleCount
            )
        )
        return TimelineRegistration(
            sessionStartSampleIndex: sessionStartSampleIndex,
            rawGapSampleCount: rawGapSampleCount,
            preservedGapSampleCount: preservedGapSampleCount
        )
    }

    func rawStartSampleIndex(forSessionStartSampleIndex sessionStartSampleIndex: Int64) -> Int64 {
        lock.lock()
        defer { lock.unlock() }

        var lastDelta: Int64 = 0
        var hasSegment = false

        for segment in segments {
            if sessionStartSampleIndex < segment.sessionStartSampleIndex {
                break
            }

            lastDelta = segment.rawStartSampleIndex - segment.sessionStartSampleIndex
            hasSegment = true

            if sessionStartSampleIndex < segment.sessionEndSampleIndex {
                return
                    segment.rawStartSampleIndex +
                    (sessionStartSampleIndex - segment.sessionStartSampleIndex)
            }
        }

        if hasSegment {
            return sessionStartSampleIndex + lastDelta
        }

        return sessionStartSampleIndex
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }

        nextCollapsedStartSampleIndex = nil
        previousRawEndSampleIndex = nil
        segments.removeAll()
    }
}

func timestampMs(
    forSampleIndex sampleIndex: Int64,
    sampleRate: Int = FixedFrameAecProcessor.sampleRate
) -> UInt64 {
    guard sampleIndex > 0, sampleRate > 0 else { return 0 }
    return UInt64((Double(sampleIndex) / Double(sampleRate)) * 1000.0)
}

final class SharedAudioSampleClock {
    private let sampleRate: Double
    private let lock = NSLock()
    private var timebase = mach_timebase_info_data_t()
    private var anchorHostTime: UInt64?

    init(
        sampleRate: Double = Double(FixedFrameAecProcessor.sampleRate),
        anchorHostTime: UInt64? = nil
    ) {
        self.sampleRate = sampleRate
        self.anchorHostTime = anchorHostTime
        mach_timebase_info(&timebase)
    }

    func sampleIndex(forHostTime hostTime: UInt64) -> Int64 {
        lock.lock()
        defer { lock.unlock() }

        if anchorHostTime == nil {
            anchorHostTime = hostTime
            return 0
        }

        let elapsedTicks = hostTime &- (anchorHostTime ?? hostTime)
        let elapsedNanoseconds =
            (Double(elapsedTicks) * Double(timebase.numer)) / Double(timebase.denom)
        return Int64((elapsedNanoseconds * sampleRate) / 1_000_000_000.0)
    }
}

final class SourceSamplePositionTracker {
    private let clock: SharedAudioSampleClock
    private let lock = NSLock()
    private var nextFallbackSampleIndex: Int64 = 0

    init(clock: SharedAudioSampleClock) {
        self.clock = clock
    }

    func resolveStartSampleIndex(hostTime: UInt64?, sampleCount: Int) -> Int64 {
        lock.lock()
        defer { lock.unlock() }

        let computedSampleIndex = hostTime.map { clock.sampleIndex(forHostTime: $0) }
        let startSampleIndex = max(computedSampleIndex ?? nextFallbackSampleIndex, nextFallbackSampleIndex)
        nextFallbackSampleIndex = startSampleIndex + Int64(sampleCount)
        return startSampleIndex
    }
}
