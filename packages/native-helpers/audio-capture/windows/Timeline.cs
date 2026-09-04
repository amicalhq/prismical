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

    public SharedAudioSampleClock(
        double sampleRate = CaptureConstants.SampleRate,
        long? anchorTimestamp = null
    )
    {
        this.sampleRate = sampleRate;
        this.anchorTimestamp = anchorTimestamp;
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

internal sealed class MicrophoneTimelineWriter
{
    private const long MaximumSilenceDebtSamples = CaptureConstants.SampleRate * 20L;
    private const int MaximumSilencePacketSamples = CaptureConstants.SampleRate;

    private readonly object writerLock = new();
    private readonly SharedAudioSampleClock clock;
    private readonly PacketWriter writer;
    private readonly CaptureTraceWriter? traceWriter;
    private readonly Action<int> onTimelineJump;
    private long cursor;

    public MicrophoneTimelineWriter(
        long anchorTimestamp,
        PacketWriter writer,
        CaptureTraceWriter? traceWriter,
        Action<int> onTimelineJump
    )
    {
        clock = new SharedAudioSampleClock(
            CaptureConstants.SampleRate,
            anchorTimestamp
        );
        this.writer = writer;
        this.traceWriter = traceWriter;
        this.onTimelineJump = onTimelineJump;
    }

    public void HandleSilenceTick(long hostTimestamp)
    {
        lock (writerLock)
        {
            EmitSilenceThrough(clock.SampleIndex(hostTimestamp));
        }
    }

    public int HandleSamples(float[] samples, long? hostTimestamp)
    {
        if (samples.Length == 0)
        {
            return 0;
        }

        lock (writerLock)
        {
            var rawStartSampleIndex = Math.Max(
                0,
                clock.SampleIndex(hostTimestamp ?? Stopwatch.GetTimestamp())
            );
            if (rawStartSampleIndex > cursor)
            {
                EmitSilenceThrough(rawStartSampleIndex);
            }

            var overlap = (int)Math.Min(
                samples.Length,
                Math.Max(0, cursor - rawStartSampleIndex)
            );
            if (overlap >= samples.Length)
            {
                return overlap;
            }

            var outputSamples = overlap == 0 ? samples : samples[overlap..];
            var startSampleIndex = rawStartSampleIndex + overlap;
            Write(outputSamples, startSampleIndex);
            cursor = startSampleIndex + outputSamples.Length;
            return overlap;
        }
    }

    private void EmitSilenceThrough(long targetSampleIndex)
    {
        var owedSamples = targetSampleIndex - cursor;
        if (owedSamples < CaptureConstants.FrameSize)
        {
            return;
        }

        if (owedSamples > MaximumSilenceDebtSamples)
        {
            cursor = targetSampleIndex;
            onTimelineJump(
                (int)((owedSamples * 1000) / CaptureConstants.SampleRate)
            );
            return;
        }

        while (cursor < targetSampleIndex)
        {
            var sampleCount = (int)Math.Min(
                MaximumSilencePacketSamples,
                targetSampleIndex - cursor
            );
            Write(new float[sampleCount], cursor);
            cursor += sampleCount;
        }
    }

    private void Write(float[] samples, long startSampleIndex)
    {
        traceWriter?.Record(
            "microphone_timeline_write",
            new Dictionary<string, object?>
            {
                ["startSampleIndex"] = startSampleIndex,
                ["sampleCount"] = samples.Length
            }
        );
        writer.Write(
            CaptureSource.MicRaw,
            samples,
            TraceHelpers.TimestampMsForSampleIndex(startSampleIndex),
            startSampleIndex
        );
    }
}
