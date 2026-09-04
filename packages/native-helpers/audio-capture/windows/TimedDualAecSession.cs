using System.Diagnostics;

namespace AudioCapture.Windows;

internal sealed record MicrophoneFrameWaitRun(long ThroughSampleIndexExclusive, long DeadlineTicks);

internal sealed class TimedDualAecSession : IDisposable
{
    public const int DefaultMicrophoneHoldbackMs = 300;
    public const int DefaultRenderWaitTimeoutMs = 300;

    private readonly int frameSampleCount = CaptureConstants.FrameSize;
    private readonly CaptureTraceWriter? traceWriter;
    private readonly int microphoneHoldbackSamples;
    private readonly long renderWaitTimeoutTicks;
    private readonly int renderRetentionSamples = CaptureConstants.SampleRate * 5;
    private readonly IEchoReducer echoReducer;
    private readonly List<AudioSegment> microphoneSegments = [];
    private readonly List<AudioSegment> renderSegments = [];
    private readonly List<float> pendingSystemPacketSamples = [];
    private readonly List<MicrophoneFrameWaitRun> microphoneFrameWaitRuns = [];
    private long? timelineStartSampleIndex;
    private long? nextMicrophoneFrameStart;
    private long? nextSystemPacketFrameStart;
    private long? nextExpectedSystemPacketInputSampleIndex;
    private long latestMicrophoneSampleIndex;
    private long latestRenderSampleIndex;

    public TimedDualAecSession(
        int microphoneHoldbackMs = DefaultMicrophoneHoldbackMs,
        int? renderWaitTimeoutMs = null,
        CaptureTraceWriter? traceWriter = null
    )
    {
        this.traceWriter = traceWriter;
        if (WebRtcAec3EchoReducer.TryCreate(out var nativeEchoReducer, out var nativeReason))
        {
            echoReducer = nativeEchoReducer;
        }
        else
        {
            echoReducer = new ReferenceEchoReducer();
            Logger.Info($"WebRTC AEC3 unavailable; using reference reducer: {nativeReason}");
        }

        MicrophoneHoldbackMs = Math.Max(0, microphoneHoldbackMs);
        RenderWaitTimeoutMs = Math.Max(0, renderWaitTimeoutMs ?? microphoneHoldbackMs);
        microphoneHoldbackSamples =
            (CaptureConstants.SampleRate * MicrophoneHoldbackMs) / 1000;
        renderWaitTimeoutTicks =
            (long)((RenderWaitTimeoutMs / 1000.0) * Stopwatch.Frequency);
    }

    public int MicrophoneHoldbackMs { get; }
    public int RenderWaitTimeoutMs { get; }
    public string AecModeDescription => echoReducer.ModeDescription;
    public string MicrophoneHoldbackDescription => $"{MicrophoneHoldbackMs}ms";
    public string RenderWaitTimeoutDescription => $"{RenderWaitTimeoutMs}ms";

    public IReadOnlyList<NativeTimedSessionOutputChunk> IngestMicrophone(TimedAudioChunk chunk)
    {
        if (chunk.Samples.Length == 0)
        {
            return [];
        }

        traceWriter?.RecordSamples(
            "timed_session_ingest_microphone",
            "timed-session-mic-ingest",
            chunk.Samples,
            new Dictionary<string, object?>
            {
                ["startSampleIndex"] = chunk.StartSampleIndex,
                ["rawStartSampleIndex"] = chunk.RawStartSampleIndex,
                ["sampleCount"] = chunk.Samples.Length
            }
        );

        AppendSegment(new AudioSegment(chunk.StartSampleIndex, [.. chunk.Samples]), microphoneSegments);
        timelineStartSampleIndex ??= chunk.StartSampleIndex;
        latestMicrophoneSampleIndex = Math.Max(
            latestMicrophoneSampleIndex,
            chunk.StartSampleIndex + chunk.Samples.Length
        );
        nextMicrophoneFrameStart ??= microphoneSegments.FirstOrDefault()?.StartSampleIndex;

        var nowTicks = Stopwatch.GetTimestamp();
        RegisterMicrophoneFrameWaitDeadlines(nowTicks);
        var outputs = new List<NativeTimedSessionOutputChunk>();
        var drainBoundary = MicrophoneDrainBoundary(flushing: false, nowTicks);
        if (drainBoundary > 0)
        {
            DrainMicrophoneFrames(drainBoundary, flushing: false, outputs);
        }

        return outputs;
    }

    public IReadOnlyList<NativeTimedSessionOutputChunk> IngestSystem(TimedAudioChunk chunk)
    {
        if (chunk.Samples.Length == 0)
        {
            return [];
        }

        traceWriter?.RecordSamples(
            "timed_session_ingest_render",
            "timed-session-system-ingest",
            chunk.Samples,
            new Dictionary<string, object?>
            {
                ["startSampleIndex"] = chunk.StartSampleIndex,
                ["rawStartSampleIndex"] = chunk.RawStartSampleIndex,
                ["sampleCount"] = chunk.Samples.Length
            }
        );

        AppendSegment(new AudioSegment(chunk.StartSampleIndex, [.. chunk.Samples]), renderSegments);
        timelineStartSampleIndex =
            timelineStartSampleIndex != null
                ? Math.Min(timelineStartSampleIndex.Value, chunk.StartSampleIndex)
                : chunk.StartSampleIndex;
        AppendSystemPacketSamples(chunk);
        latestRenderSampleIndex = Math.Max(
            latestRenderSampleIndex,
            chunk.StartSampleIndex + chunk.Samples.Length
        );

        var outputs = new List<NativeTimedSessionOutputChunk>();
        DrainSystemPackets(latestRenderSampleIndex, outputs);
        var drainBoundary = MicrophoneDrainBoundary(false, Stopwatch.GetTimestamp());
        if (drainBoundary > 0)
        {
            DrainMicrophoneFrames(drainBoundary, flushing: false, outputs);
        }

        PruneRenderSegments();
        return outputs;
    }

    public IReadOnlyList<NativeTimedSessionOutputChunk> Finish()
    {
        var finalSampleBoundary = Math.Max(latestMicrophoneSampleIndex, latestRenderSampleIndex);
        if (finalSampleBoundary <= 0)
        {
            return [];
        }

        var roundedBoundary =
            ((finalSampleBoundary + frameSampleCount - 1) / frameSampleCount) * frameSampleCount;
        var outputs = new List<NativeTimedSessionOutputChunk>();
        DrainSystemPackets(roundedBoundary, outputs);
        DrainMicrophoneFrames(roundedBoundary, flushing: true, outputs);
        return outputs;
    }

    public void Reset()
    {
        microphoneSegments.Clear();
        renderSegments.Clear();
        pendingSystemPacketSamples.Clear();
        microphoneFrameWaitRuns.Clear();
        timelineStartSampleIndex = null;
        nextMicrophoneFrameStart = null;
        nextSystemPacketFrameStart = null;
        nextExpectedSystemPacketInputSampleIndex = null;
        latestMicrophoneSampleIndex = 0;
        latestRenderSampleIndex = 0;
        echoReducer.Reset();
    }

    public void Dispose()
    {
        echoReducer.Dispose();
    }

    private long MicrophoneDrainBoundary(bool flushing, long nowTicks)
    {
        if (flushing)
        {
            return latestMicrophoneSampleIndex;
        }

        var renderReadySampleIndex = latestRenderSampleIndex - microphoneHoldbackSamples;
        var renderLimitedBoundary =
            renderReadySampleIndex > 0
                ? Math.Max(0, Math.Min(latestMicrophoneSampleIndex, renderReadySampleIndex))
                : 0;

        return Math.Max(renderLimitedBoundary, TimedOutMicrophoneDrainBoundary(nowTicks));
    }

    private void RegisterMicrophoneFrameWaitDeadlines(long nowTicks)
    {
        if (nextMicrophoneFrameStart == null)
        {
            return;
        }

        var queuedBoundary = Math.Max(
            nextMicrophoneFrameStart.Value,
            microphoneFrameWaitRuns.LastOrDefault()?.ThroughSampleIndexExclusive ??
                nextMicrophoneFrameStart.Value
        );
        var readyBoundary = nextMicrophoneFrameStart.Value;

        while (readyBoundary + frameSampleCount <= latestMicrophoneSampleIndex)
        {
            readyBoundary += frameSampleCount;
        }

        if (readyBoundary <= queuedBoundary)
        {
            return;
        }

        microphoneFrameWaitRuns.Add(
            new MicrophoneFrameWaitRun(readyBoundary, nowTicks + renderWaitTimeoutTicks)
        );
    }

    private long TimedOutMicrophoneDrainBoundary(long nowTicks)
    {
        if (nextMicrophoneFrameStart == null)
        {
            return 0;
        }

        long timedOutBoundary = 0;
        foreach (var run in microphoneFrameWaitRuns)
        {
            if (run.DeadlineTicks > nowTicks)
            {
                break;
            }

            timedOutBoundary = Math.Max(timedOutBoundary, run.ThroughSampleIndexExclusive);
        }

        return timedOutBoundary;
    }

    private void DrainMicrophoneFrames(
        long sampleIndexExclusive,
        bool flushing,
        List<NativeTimedSessionOutputChunk> outputs
    )
    {
        if (sampleIndexExclusive <= 0)
        {
            return;
        }

        if (nextMicrophoneFrameStart == null)
        {
            if (microphoneSegments.FirstOrDefault() is { } firstMicrophone)
            {
                nextMicrophoneFrameStart = Math.Min(
                    timelineStartSampleIndex ?? firstMicrophone.StartSampleIndex,
                    firstMicrophone.StartSampleIndex
                );
            }
            else if (flushing)
            {
                nextMicrophoneFrameStart = timelineStartSampleIndex;
            }
        }

        while (
            nextMicrophoneFrameStart is { } frameStart &&
            frameStart + frameSampleCount <= sampleIndexExclusive
        )
        {
            var microphoneFrame =
                ExtractSamples(microphoneSegments, frameStart, frameSampleCount, fillSilence: true) ??
                new float[frameSampleCount];
            var renderFrame =
                ExtractSamples(renderSegments, frameStart, frameSampleCount, fillSilence: true) ??
                new float[frameSampleCount];

            DrainSystemPackets(frameStart + frameSampleCount, outputs);
            echoReducer.IngestRender(renderFrame);
            EmitMicrophoneFrame(frameStart, microphoneFrame, outputs);

            nextMicrophoneFrameStart = frameStart + frameSampleCount;
            PruneMicrophoneFrameWaitRuns(nextMicrophoneFrameStart.Value);
            PruneMicrophoneSegments(nextMicrophoneFrameStart.Value);
            PruneRenderSegments();
        }
    }

    private void EmitMicrophoneFrame(
        long startSampleIndex,
        float[] captureSamples,
        List<NativeTimedSessionOutputChunk> outputs
    )
    {
        if (captureSamples.Length == 0)
        {
            return;
        }

        outputs.Add(MakeOutputChunk(CaptureSource.MicRaw, startSampleIndex, captureSamples));
        var processedSamples = NormalizedFrameLength(
            echoReducer.ProcessCapture(captureSamples),
            captureSamples.Length
        );
        outputs.Add(MakeOutputChunk(CaptureSource.MicProcessed, startSampleIndex, processedSamples));
    }

    private static float[] NormalizedFrameLength(float[] samples, int targetCount)
    {
        if (samples.Length == targetCount)
        {
            return samples;
        }

        if (samples.Length > targetCount)
        {
            return samples.Take(targetCount).ToArray();
        }

        var output = new float[targetCount];
        Array.Copy(samples, output, samples.Length);
        return output;
    }

    private void DrainSystemPackets(
        long sampleIndexExclusive,
        List<NativeTimedSessionOutputChunk> outputs
    )
    {
        if (sampleIndexExclusive <= 0)
        {
            return;
        }

        if (nextSystemPacketFrameStart == null)
        {
            if (timelineStartSampleIndex == null)
            {
                return;
            }

            nextSystemPacketFrameStart = timelineStartSampleIndex.Value;
        }

        while (
            nextSystemPacketFrameStart is { } frameStart &&
            frameStart + frameSampleCount <= sampleIndexExclusive
        )
        {
            var systemFrame = DequeueSystemPacketFrame();
            outputs.Add(MakeOutputChunk(CaptureSource.System, frameStart, systemFrame));
            nextSystemPacketFrameStart = frameStart + frameSampleCount;
        }
    }

    private NativeTimedSessionOutputChunk MakeOutputChunk(
        CaptureSource source,
        long startSampleIndex,
        float[] samples
    )
    {
        traceWriter?.RecordSamples(
            "timed_session_output",
            $"timed-session-output-{TraceHelpers.CaptureSourceName(source)}",
            samples,
            new Dictionary<string, object?>
            {
                ["source"] = TraceHelpers.CaptureSourceName(source),
                ["startSampleIndex"] = startSampleIndex,
                ["sampleCount"] = samples.Length
            }
        );

        return new NativeTimedSessionOutputChunk(source, startSampleIndex, samples);
    }

    private void AppendSystemPacketSamples(TimedAudioChunk chunk)
    {
        if (chunk.Samples.Length == 0)
        {
            return;
        }

        var timelineStart = timelineStartSampleIndex ?? chunk.StartSampleIndex;
        if (nextExpectedSystemPacketInputSampleIndex == null)
        {
            var initialGapSamples = Math.Max(0, (int)(chunk.StartSampleIndex - timelineStart));
            if (initialGapSamples > 0)
            {
                pendingSystemPacketSamples.AddRange(Enumerable.Repeat(0.0f, initialGapSamples));
            }

            pendingSystemPacketSamples.AddRange(chunk.Samples);
            nextExpectedSystemPacketInputSampleIndex = chunk.StartSampleIndex + chunk.Samples.Length;
            return;
        }

        var expectedStart = nextExpectedSystemPacketInputSampleIndex.Value;
        if (chunk.StartSampleIndex > expectedStart)
        {
            var gapSamples = (int)(chunk.StartSampleIndex - expectedStart);
            pendingSystemPacketSamples.AddRange(Enumerable.Repeat(0.0f, gapSamples));
            pendingSystemPacketSamples.AddRange(chunk.Samples);
            nextExpectedSystemPacketInputSampleIndex = chunk.StartSampleIndex + chunk.Samples.Length;
            return;
        }

        var overlapSamples = Math.Max(0, (int)(expectedStart - chunk.StartSampleIndex));
        if (overlapSamples >= chunk.Samples.Length)
        {
            return;
        }

        pendingSystemPacketSamples.AddRange(chunk.Samples.Skip(overlapSamples));
        nextExpectedSystemPacketInputSampleIndex = expectedStart + (chunk.Samples.Length - overlapSamples);
    }

    private float[] DequeueSystemPacketFrame()
    {
        if (pendingSystemPacketSamples.Count >= frameSampleCount)
        {
            var frame = pendingSystemPacketSamples.Take(frameSampleCount).ToArray();
            pendingSystemPacketSamples.RemoveRange(0, frameSampleCount);
            return frame;
        }

        if (pendingSystemPacketSamples.Count == 0)
        {
            return new float[frameSampleCount];
        }

        var output = new float[frameSampleCount];
        pendingSystemPacketSamples.CopyTo(0, output, 0, pendingSystemPacketSamples.Count);
        pendingSystemPacketSamples.Clear();
        return output;
    }

    private static void AppendSegment(AudioSegment segment, List<AudioSegment> segments)
    {
        if (segment.Samples.Count == 0)
        {
            return;
        }

        if (segments.LastOrDefault() is { } lastSegment &&
            segment.StartSampleIndex <= lastSegment.EndSampleIndex)
        {
            var overlap = Math.Max(0, (int)(lastSegment.EndSampleIndex - segment.StartSampleIndex));
            if (overlap >= segment.Samples.Count)
            {
                return;
            }

            lastSegment.Samples.AddRange(segment.Samples.Skip(overlap));
            return;
        }

        segments.Add(segment);
    }

    private static float[]? ExtractSamples(
        List<AudioSegment> segments,
        long startSampleIndex,
        int frameLength,
        bool fillSilence
    )
    {
        if (frameLength <= 0)
        {
            return [];
        }

        var endSampleIndex = startSampleIndex + frameLength;
        var output = new float[frameLength];
        var coverageCursor = startSampleIndex;
        var wroteSamples = false;

        foreach (var segment in segments)
        {
            if (segment.EndSampleIndex <= startSampleIndex)
            {
                continue;
            }

            if (segment.StartSampleIndex >= endSampleIndex)
            {
                break;
            }

            var overlapStart = Math.Max(startSampleIndex, segment.StartSampleIndex);
            var overlapEnd = Math.Min(endSampleIndex, segment.EndSampleIndex);
            if (overlapEnd <= overlapStart)
            {
                continue;
            }

            if (!fillSilence && overlapStart > coverageCursor)
            {
                return null;
            }

            var sourceOffset = (int)(overlapStart - segment.StartSampleIndex);
            var destinationOffset = (int)(overlapStart - startSampleIndex);
            var sampleCount = (int)(overlapEnd - overlapStart);
            segment.Samples.CopyTo(sourceOffset, output, destinationOffset, sampleCount);
            coverageCursor = overlapEnd;
            wroteSamples = true;
        }

        if (!fillSilence && coverageCursor < endSampleIndex)
        {
            return null;
        }

        return wroteSamples || fillSilence ? output : null;
    }

    private void PruneMicrophoneSegments(long beforeSampleIndex)
    {
        TrimSegments(microphoneSegments, beforeSampleIndex);
    }

    private void PruneRenderSegments()
    {
        if (renderSegments.Count == 0)
        {
            return;
        }

        var retentionBoundary = Math.Max(0, latestRenderSampleIndex - renderRetentionSamples);
        var pendingMicrophoneBoundary = nextMicrophoneFrameStart ?? retentionBoundary;
        var pendingSystemPacketBoundary = nextSystemPacketFrameStart ?? retentionBoundary;
        var pruneBefore = Math.Min(
            retentionBoundary,
            Math.Min(pendingMicrophoneBoundary, pendingSystemPacketBoundary)
        );
        TrimSegments(renderSegments, pruneBefore);
    }

    private static void TrimSegments(List<AudioSegment> segments, long beforeSampleIndex)
    {
        if (beforeSampleIndex <= 0)
        {
            return;
        }

        for (var index = segments.Count - 1; index >= 0; index -= 1)
        {
            var segment = segments[index];
            if (segment.EndSampleIndex <= beforeSampleIndex)
            {
                segments.RemoveAt(index);
                continue;
            }

            if (segment.StartSampleIndex >= beforeSampleIndex)
            {
                continue;
            }

            var trimCount = (int)(beforeSampleIndex - segment.StartSampleIndex);
            if (trimCount >= segment.Samples.Count)
            {
                segments.RemoveAt(index);
                continue;
            }

            var trimmed = segment.Samples.Skip(trimCount).ToList();
            segments[index] = new AudioSegment(beforeSampleIndex, trimmed);
        }

        segments.Sort((left, right) => left.StartSampleIndex.CompareTo(right.StartSampleIndex));
    }

    private void PruneMicrophoneFrameWaitRuns(long beforeSampleIndex)
    {
        while (
            microphoneFrameWaitRuns.Count > 0 &&
            microphoneFrameWaitRuns[0].ThroughSampleIndexExclusive <= beforeSampleIndex
        )
        {
            microphoneFrameWaitRuns.RemoveAt(0);
        }
    }
}
