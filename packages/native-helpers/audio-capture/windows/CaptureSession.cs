using System.Diagnostics;

namespace AudioCapture.Windows;

internal sealed class CaptureSession : IDisposable
{
    private readonly ParsedArguments arguments;
    private readonly CaptureTraceWriter? traceWriter;
    private readonly PacketWriter writer;
    private readonly object dualSessionLock = new();
    private readonly Action<Exception>? onFatalError;
    private MicrophoneBindingController? microphoneBindingController;
    private WasapiSource? systemSource;
    private TimedDualAecSession? timedSession;
    private MicrophoneTimelineWriter? microphoneTimelineWriter;
    private CollapsedSourceTimelineMapper? microphoneTimelineMapper;
    private CollapsedSourceTimelineMapper? systemTimelineMapper;
    private bool microphoneIsLive;
    private long microphoneSilenceEndSampleIndex;
    private bool stopped;

    public CaptureSession(ParsedArguments arguments, Action<Exception>? onFatalError = null)
    {
        this.arguments = arguments;
        this.onFatalError = onFatalError;
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

    public void SetMicrophone(string deviceId, int revision)
    {
        if (arguments.Mode != CaptureMode.System)
        {
            microphoneBindingController?.SetMicrophone(deviceId, revision);
        }
    }

    public void FollowDefaultMicrophone(int revision)
    {
        if (arguments.Mode != CaptureMode.System)
        {
            microphoneBindingController?.FollowDefault(revision);
        }
    }

    public void Stop()
    {
        if (stopped)
        {
            return;
        }

        stopped = true;
        microphoneBindingController?.Stop();
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
        microphoneTimelineWriter = null;
        traceWriter?.Dispose();
        Logger.Info($"{arguments.Mode.ToString().ToLowerInvariant()} mode capture stopped");
    }

    public void Dispose()
    {
        Stop();
        microphoneBindingController?.Dispose();
        systemSource?.Dispose();
        timedSession?.Dispose();
        traceWriter?.Dispose();
    }

    private void StartSingle(CaptureMode mode)
    {
        var anchorTimestamp = Stopwatch.GetTimestamp();
        if (mode == CaptureMode.Mic)
        {
            microphoneTimelineWriter = new MicrophoneTimelineWriter(
                anchorTimestamp,
                writer,
                traceWriter,
                gapMs => microphoneBindingController?.ReportTimelineJump(gapMs)
            );
            microphoneBindingController = new MicrophoneBindingController(
                arguments.MicrophoneDeviceId,
                traceWriter,
                arguments.DebugArtifactsDirectory,
                microphoneTimelineWriter.HandleSamples,
                onSilenceTick: microphoneTimelineWriter.HandleSilenceTick
            );
            microphoneBindingController.Start();
            return;
        }

        var clock = new SharedAudioSampleClock(
            CaptureConstants.SampleRate,
            anchorTimestamp
        );
        var tracker = new SourceSamplePositionTracker(clock);
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
            ),
            onUnexpectedStop: HandleSystemUnexpectedStop
        );
        systemSource.Start();
    }

    private void StartDual()
    {
        var sharedClock = new SharedAudioSampleClock(
            CaptureConstants.SampleRate,
            Stopwatch.GetTimestamp()
        );
        var microphoneTracker = new SourceSamplePositionTracker(sharedClock);
        var systemTracker = new SourceSamplePositionTracker(sharedClock);
        microphoneTimelineMapper = new CollapsedSourceTimelineMapper(minimumGapToPreserve: 1);
        systemTimelineMapper = new CollapsedSourceTimelineMapper(minimumGapToPreserve: 1);
        timedSession = new TimedDualAecSession(
            arguments.AecRenderHoldbackMs,
            arguments.AecRenderWaitTimeoutMs,
            traceWriter
        );

        microphoneIsLive = false;
        microphoneSilenceEndSampleIndex = 0;
        microphoneBindingController = new MicrophoneBindingController(
            arguments.MicrophoneDeviceId,
            traceWriter,
            arguments.DebugArtifactsDirectory,
            (samples, hostTimestamp) =>
                HandleDualMicrophoneSamples(microphoneTracker, samples, hostTimestamp),
            onRealAudioStopped: () =>
            {
                lock (dualSessionLock)
                {
                    microphoneIsLive = false;
                }
            }
        );
        microphoneBindingController.Start();

        try
        {
            systemSource = new WasapiSource(
                CaptureInputKind.System,
                traceWriter,
                arguments.DebugArtifactsDirectory,
                (samples, hostTimestamp) =>
                    HandleDualSystemSamples(systemTracker, samples, hostTimestamp),
                onUnexpectedStop: HandleSystemUnexpectedStop
            );
            systemSource.Start();
        }
        catch
        {
            microphoneBindingController.Dispose();
            microphoneBindingController = null;
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

    private int HandleDualMicrophoneSamples(
        SourceSamplePositionTracker microphoneTracker,
        float[] samples,
        long? hostTimestamp
    )
    {
        if (timedSession == null || microphoneTimelineMapper == null)
        {
            return 0;
        }

        var rawStartSampleIndex = microphoneTracker.ResolveStartSampleIndex(
            hostTimestamp,
            samples.Length
        );
        lock (dualSessionLock)
        {
            microphoneIsLive = true;
            var trimmedSamples = (int)Math.Min(
                samples.Length,
                Math.Max(0, microphoneSilenceEndSampleIndex - rawStartSampleIndex)
            );
            if (trimmedSamples >= samples.Length)
            {
                return trimmedSamples;
            }

            var liveSamples = trimmedSamples == 0 ? samples : samples[trimmedSamples..];
            var liveStartSampleIndex = rawStartSampleIndex + trimmedSamples;
            var timelineRegistration = microphoneTimelineMapper.RegisterChunk(
                liveStartSampleIndex,
                liveSamples.Length
            );
            var sessionStartSampleIndex = timelineRegistration.SessionStartSampleIndex;
            traceWriter?.Record(
                "microphone_tracker_resolve",
                new Dictionary<string, object?>
                {
                    ["hostTime"] = hostTimestamp,
                    ["startSampleIndex"] = liveStartSampleIndex,
                    ["sessionStartSampleIndex"] = sessionStartSampleIndex,
                    ["sampleCount"] = liveSamples.Length,
                    ["trimmedSampleCount"] = trimmedSamples
                }
            );
            traceWriter?.Record(
                "microphone_session_timeline_map",
                new Dictionary<string, object?>
                {
                    ["rawStartSampleIndex"] = liveStartSampleIndex,
                    ["sessionStartSampleIndex"] = sessionStartSampleIndex,
                    ["sampleCount"] = liveSamples.Length,
                    ["rawGapSampleCount"] = timelineRegistration.RawGapSampleCount,
                    ["preservedGapSampleCount"] = timelineRegistration.PreservedGapSampleCount
                }
            );

            var chunk = new TimedAudioChunk(
                sessionStartSampleIndex,
                liveStartSampleIndex,
                liveSamples
            );
            EmitOutputs(timedSession.IngestMicrophone(chunk));
            return trimmedSamples;
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
            if (!microphoneIsLive)
            {
                microphoneSilenceEndSampleIndex = Math.Max(
                    microphoneSilenceEndSampleIndex,
                    rawStartSampleIndex + samples.Length
                );
                var silenceChunk = new TimedAudioChunk(
                    sessionStartSampleIndex,
                    rawStartSampleIndex,
                    new float[samples.Length]
                );
                EmitOutputs(timedSession.IngestMicrophone(silenceChunk));
            }
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

    private void HandleSystemUnexpectedStop(Exception exception)
    {
        onFatalError?.Invoke(exception);
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
