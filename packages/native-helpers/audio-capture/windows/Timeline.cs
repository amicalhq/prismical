using System.Diagnostics;

namespace AudioCapture.Windows;

internal sealed record TimedAudioChunk(
    long StartSampleIndex,
    long RawStartSampleIndex,
    float[] Samples
);

internal sealed record NativeTimedSessionOutputChunk(
    CaptureSource Source,
    long StartSampleIndex,
    float[] Samples
);

internal sealed record TimelineRegistration(
    long SessionStartSampleIndex,
    long RawGapSampleCount,
    long PreservedGapSampleCount
);

internal sealed record AudioSegment(long StartSampleIndex, List<float> Samples)
{
    public long EndSampleIndex => StartSampleIndex + Samples.Count;
}

internal sealed class CollapsedSourceTimelineMapper
{
    private readonly object mapperLock = new();
    private readonly long minimumGapToPreserve;
    private readonly List<TimelineMappingSegment> segments = [];
    private long? nextCollapsedStartSampleIndex;
    private long? previousRawEndSampleIndex;

    public CollapsedSourceTimelineMapper(long minimumGapToPreserve = 1)
    {
        this.minimumGapToPreserve = Math.Max(0, minimumGapToPreserve);
    }

    public TimelineRegistration RegisterChunk(long rawStartSampleIndex, int sampleCount)
    {
        lock (mapperLock)
        {
            var rawGapSampleCount = Math.Max(
                0,
                rawStartSampleIndex - (previousRawEndSampleIndex ?? rawStartSampleIndex)
            );
            var preservedGapSampleCount =
                rawGapSampleCount > minimumGapToPreserve ? rawGapSampleCount : 0;
            var sessionStartSampleIndex =
                nextCollapsedStartSampleIndex != null
                    ? nextCollapsedStartSampleIndex.Value + preservedGapSampleCount
                    : rawStartSampleIndex;

            nextCollapsedStartSampleIndex = sessionStartSampleIndex + sampleCount;
            previousRawEndSampleIndex = rawStartSampleIndex + sampleCount;
            segments.Add(
                new TimelineMappingSegment(
                    sessionStartSampleIndex,
                    rawStartSampleIndex,
                    sampleCount
                )
            );

            return new TimelineRegistration(
                sessionStartSampleIndex,
                rawGapSampleCount,
                preservedGapSampleCount
            );
        }
    }

    public long RawStartSampleIndex(long sessionStartSampleIndex)
    {
        lock (mapperLock)
        {
            long lastDelta = 0;
            var hasSegment = false;

            foreach (var segment in segments)
            {
                if (sessionStartSampleIndex < segment.SessionStartSampleIndex)
                {
                    break;
                }

                lastDelta = segment.RawStartSampleIndex - segment.SessionStartSampleIndex;
                hasSegment = true;

                if (sessionStartSampleIndex < segment.SessionEndSampleIndex)
                {
                    return segment.RawStartSampleIndex +
                        (sessionStartSampleIndex - segment.SessionStartSampleIndex);
                }
            }

            return hasSegment ? sessionStartSampleIndex + lastDelta : sessionStartSampleIndex;
        }
    }

    public void Reset()
    {
        lock (mapperLock)
        {
            nextCollapsedStartSampleIndex = null;
            previousRawEndSampleIndex = null;
            segments.Clear();
        }
    }

    private sealed record TimelineMappingSegment(
        long SessionStartSampleIndex,
        long RawStartSampleIndex,
        int SampleCount
    )
    {
        public long SessionEndSampleIndex => SessionStartSampleIndex + SampleCount;
    }
}

internal sealed class SharedAudioSampleClock
{
    private readonly object clockLock = new();
    private readonly double sampleRate;
    private long? anchorTimestamp;

    public SharedAudioSampleClock(double sampleRate = CaptureConstants.SampleRate)
    {
        this.sampleRate = sampleRate;
    }

    public long SampleIndex(long hostTimestamp)
    {
        lock (clockLock)
        {
            if (anchorTimestamp == null)
            {
                anchorTimestamp = hostTimestamp;
                return 0;
            }

            var elapsedTicks = hostTimestamp - anchorTimestamp.Value;
            return (long)((elapsedTicks / (double)Stopwatch.Frequency) * sampleRate);
        }
    }
}

internal sealed class SourceSamplePositionTracker
{
    private readonly SharedAudioSampleClock clock;
    private readonly object trackerLock = new();
    private long nextFallbackSampleIndex;

    public SourceSamplePositionTracker(SharedAudioSampleClock clock)
    {
        this.clock = clock;
    }

    public long ResolveStartSampleIndex(long? hostTimestamp, int sampleCount)
    {
        lock (trackerLock)
        {
            long? computedSampleIndex =
                hostTimestamp != null ? clock.SampleIndex(hostTimestamp.Value) : null;
            var startSampleIndex = Math.Max(
                computedSampleIndex ?? nextFallbackSampleIndex,
                nextFallbackSampleIndex
            );
            nextFallbackSampleIndex = startSampleIndex + sampleCount;
            return startSampleIndex;
        }
    }
}
