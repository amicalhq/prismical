namespace AudioCapture.Windows;

internal sealed class CaptureSession : IDisposable
{
    private readonly ParsedArguments arguments;
    private readonly CaptureTraceWriter? traceWriter;
    private readonly PacketWriter writer;
    private readonly object dualSessionLock = new();
    private WasapiSource? microphoneSource;
    private WasapiSource? systemSource;
    private TimedDualAecSession? timedSession;
    private CollapsedSourceTimelineMapper? microphoneTimelineMapper;
    private CollapsedSourceTimelineMapper? systemTimelineMapper;
    private bool stopped;

    public CaptureSession(ParsedArguments arguments)
    {
        this.arguments = arguments;
        traceWriter = string.IsNullOrWhiteSpace(arguments.DebugArtifactsDirectory)
            ? null
            : new CaptureTraceWriter(Path.Combine(arguments.DebugArtifactsDirectory, "trace"));
        writer = new PacketWriter(traceWriter);
    }

    public void Start()
    {
        if (arguments.Mode == CaptureMode.Dual)
        {
            StartDual();
            return;
        }

        StartSingle(arguments.Mode);
    }

    public void Stop()
    {
        if (stopped)
        {
            return;
        }

        stopped = true;
        microphoneSource?.Stop();
        systemSource?.Stop();

        if (timedSession != null)
        {
            lock (dualSessionLock)
            {
                EmitOutputs(timedSession.Finish());
                timedSession.Reset();
                timedSession.Dispose();
                timedSession = null;
            }
        }

        microphoneTimelineMapper?.Reset();
        systemTimelineMapper?.Reset();
        traceWriter?.Dispose();
        Logger.Info($"{arguments.Mode.ToString().ToLowerInvariant()} mode capture stopped");
    }

    public void Dispose()
    {
        Stop();
        microphoneSource?.Dispose();
        systemSource?.Dispose();
        timedSession?.Dispose();
        traceWriter?.Dispose();
    }

    private void StartSingle(CaptureMode mode)
    {
        var clock = new SharedAudioSampleClock();
        var tracker = new SourceSamplePositionTracker(clock);

        if (mode == CaptureMode.Mic)
        {
            microphoneSource = new WasapiSource(
                CaptureInputKind.Microphone,
                traceWriter,
                arguments.DebugArtifactsDirectory,
                (samples, hostTimestamp) => HandleSingleSourceSamples(
                    CaptureSource.MicRaw,
                    "microphone_tracker_resolve",
                    tracker,
                    samples,
                    hostTimestamp
                )
            );
            microphoneSource.Start();
            return;
        }

        systemSource = new WasapiSource(
            CaptureInputKind.System,
            traceWriter,
            arguments.DebugArtifactsDirectory,
            (samples, hostTimestamp) => HandleSingleSourceSamples(
                CaptureSource.System,
                "system_tracker_resolve",
                tracker,
                samples,
                hostTimestamp
            )
        );
        systemSource.Start();
    }

    private void StartDual()
    {
        var sharedClock = new SharedAudioSampleClock();
        var microphoneTracker = new SourceSamplePositionTracker(sharedClock);
        var systemTracker = new SourceSamplePositionTracker(sharedClock);
        microphoneTimelineMapper = new CollapsedSourceTimelineMapper(minimumGapToPreserve: 1);
        systemTimelineMapper = new CollapsedSourceTimelineMapper(minimumGapToPreserve: 1);
        timedSession = new TimedDualAecSession(
            arguments.AecRenderHoldbackMs,
            arguments.AecRenderWaitTimeoutMs,
            traceWriter
        );

        microphoneSource = new WasapiSource(
            CaptureInputKind.Microphone,
            traceWriter,
            arguments.DebugArtifactsDirectory,
            (samples, hostTimestamp) =>
                HandleDualMicrophoneSamples(microphoneTracker, samples, hostTimestamp)
        );
        microphoneSource.Start();

        try
        {
            systemSource = new WasapiSource(
                CaptureInputKind.System,
                traceWriter,
                arguments.DebugArtifactsDirectory,
                (samples, hostTimestamp) =>
                    HandleDualSystemSamples(systemTracker, samples, hostTimestamp)
            );
            systemSource.Start();
        }
        catch
        {
            microphoneSource.Stop();
            microphoneSource = null;
            throw;
        }

        Logger.Info(
            $"Dual mode capture started: aec={timedSession.AecModeDescription} frameSize={CaptureConstants.FrameSize} renderHoldback={timedSession.MicrophoneHoldbackDescription} renderWaitTimeout={timedSession.RenderWaitTimeoutDescription}"
        );
    }

    private void HandleSingleSourceSamples(
        CaptureSource source,
        string trackerEventName,
        SourceSamplePositionTracker tracker,
        float[] samples,
        long? hostTimestamp
    )
    {
        var startSampleIndex = tracker.ResolveStartSampleIndex(hostTimestamp, samples.Length);
        traceWriter?.Record(
            trackerEventName,
            new Dictionary<string, object?>
            {
                ["hostTime"] = hostTimestamp,
                ["startSampleIndex"] = startSampleIndex,
                ["sampleCount"] = samples.Length
            }
        );
        writer.Write(
            source,
            samples,
            TraceHelpers.TimestampMsForSampleIndex(startSampleIndex),
            startSampleIndex
        );
    }

    private void HandleDualMicrophoneSamples(
        SourceSamplePositionTracker microphoneTracker,
        float[] samples,
        long? hostTimestamp
    )
    {
        if (timedSession == null || microphoneTimelineMapper == null)
        {
            return;
        }

        var rawStartSampleIndex = microphoneTracker.ResolveStartSampleIndex(
            hostTimestamp,
            samples.Length
        );
        var timelineRegistration = microphoneTimelineMapper.RegisterChunk(
            rawStartSampleIndex,
            samples.Length
        );
        var sessionStartSampleIndex = timelineRegistration.SessionStartSampleIndex;
        traceWriter?.Record(
            "microphone_tracker_resolve",
            new Dictionary<string, object?>
            {
                ["hostTime"] = hostTimestamp,
                ["startSampleIndex"] = rawStartSampleIndex,
                ["sessionStartSampleIndex"] = sessionStartSampleIndex,
                ["sampleCount"] = samples.Length
            }
        );
        traceWriter?.Record(
            "microphone_session_timeline_map",
            new Dictionary<string, object?>
            {
                ["rawStartSampleIndex"] = rawStartSampleIndex,
                ["sessionStartSampleIndex"] = sessionStartSampleIndex,
                ["sampleCount"] = samples.Length,
                ["rawGapSampleCount"] = timelineRegistration.RawGapSampleCount,
                ["preservedGapSampleCount"] = timelineRegistration.PreservedGapSampleCount
            }
        );

        var chunk = new TimedAudioChunk(sessionStartSampleIndex, rawStartSampleIndex, samples);
        lock (dualSessionLock)
        {
            EmitOutputs(timedSession.IngestMicrophone(chunk));
        }
    }

    private void HandleDualSystemSamples(
        SourceSamplePositionTracker systemTracker,
        float[] samples,
        long? hostTimestamp
    )
    {
        if (timedSession == null || systemTimelineMapper == null)
        {
            return;
        }

        var rawStartSampleIndex = systemTracker.ResolveStartSampleIndex(hostTimestamp, samples.Length);
        var timelineRegistration = systemTimelineMapper.RegisterChunk(
            rawStartSampleIndex,
            samples.Length
        );
        var sessionStartSampleIndex = timelineRegistration.SessionStartSampleIndex;
        traceWriter?.Record(
            "system_tracker_resolve",
            new Dictionary<string, object?>
            {
                ["hostTime"] = hostTimestamp,
                ["startSampleIndex"] = rawStartSampleIndex,
                ["sessionStartSampleIndex"] = sessionStartSampleIndex,
                ["sampleCount"] = samples.Length
            }
        );
        traceWriter?.Record(
            "system_session_timeline_map",
            new Dictionary<string, object?>
            {
                ["rawStartSampleIndex"] = rawStartSampleIndex,
                ["sessionStartSampleIndex"] = sessionStartSampleIndex,
                ["sampleCount"] = samples.Length,
                ["rawGapSampleCount"] = timelineRegistration.RawGapSampleCount,
                ["preservedGapSampleCount"] = timelineRegistration.PreservedGapSampleCount
            }
        );

        var chunk = new TimedAudioChunk(sessionStartSampleIndex, rawStartSampleIndex, samples);
        lock (dualSessionLock)
        {
            EmitOutputs(timedSession.IngestSystem(chunk));
        }
    }

    private void EmitOutputs(IReadOnlyList<NativeTimedSessionOutputChunk> outputs)
    {
        if (outputs.Count == 0)
        {
            return;
        }

        foreach (var output in outputs)
        {
            var presentationStartSampleIndex = PresentationStartSampleIndex(output);
            traceWriter?.Record(
                "timed_session_output_map",
                new Dictionary<string, object?>
                {
                    ["source"] = TraceHelpers.CaptureSourceName(output.Source),
                    ["sessionStartSampleIndex"] = output.StartSampleIndex,
                    ["presentationStartSampleIndex"] = presentationStartSampleIndex,
                    ["sampleCount"] = output.Samples.Length
                }
            );
            writer.Write(
                output.Source,
                output.Samples,
                TraceHelpers.TimestampMsForSampleIndex(presentationStartSampleIndex),
                presentationStartSampleIndex
            );
        }
    }

    private long PresentationStartSampleIndex(NativeTimedSessionOutputChunk output)
    {
        return output.Source switch
        {
            CaptureSource.MicRaw or CaptureSource.MicProcessed
                => microphoneTimelineMapper?.RawStartSampleIndex(output.StartSampleIndex) ??
                    output.StartSampleIndex,
            CaptureSource.System
                => systemTimelineMapper?.RawStartSampleIndex(output.StartSampleIndex) ??
                    output.StartSampleIndex,
            _ => output.StartSampleIndex
        };
    }
}
