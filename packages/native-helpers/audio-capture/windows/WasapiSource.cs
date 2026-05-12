using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace AudioCapture.Windows;

internal enum CaptureInputKind
{
    Microphone,
    System
}

internal sealed class WasapiSource : IDisposable
{
    private readonly CaptureInputKind kind;
    private readonly CaptureTraceWriter? traceWriter;
    private readonly string? debugArtifactsDirectory;
    private readonly Action<float[], long?> onSamples;
    private readonly object sourceLock = new();
    private readonly MMDeviceEnumerator enumerator = new();
    private readonly string sourceName;
    private readonly string traceChannelBase;
    private IWaveIn? capture;
    private DebugWavWriter? preResampleDebugWriter;
    private DebugWavWriter? postResampleDebugWriter;
    private SourceSamplePositionTracker? preResampleDebugTracker;
    private SourceSamplePositionTracker? postResampleDebugTracker;
    private long preResampleDebugEndSampleIndex;
    private long postResampleDebugEndSampleIndex;
    private ulong callbackSequence;

    public WasapiSource(
        CaptureInputKind kind,
        CaptureTraceWriter? traceWriter,
        string? debugArtifactsDirectory,
        Action<float[], long?> onSamples
    )
    {
        this.kind = kind;
        this.traceWriter = traceWriter;
        this.debugArtifactsDirectory = debugArtifactsDirectory;
        this.onSamples = onSamples;
        sourceName = kind == CaptureInputKind.Microphone ? "microphone" : "system";
        traceChannelBase = kind == CaptureInputKind.Microphone ? "mic" : "system-selected";
    }

    public void Start()
    {
        lock (sourceLock)
        {
            if (capture != null)
            {
                return;
            }

            var device = ResolveDevice();
            capture =
                kind == CaptureInputKind.System
                    ? new WasapiLoopbackCapture(device)
                    : new WasapiCapture(device);
            capture.DataAvailable += HandleDataAvailable;
            capture.RecordingStopped += HandleRecordingStopped;

            var format = capture.WaveFormat;
            InitializeDebugWriters(format);
            RecordStarted(device, format);
            capture.StartRecording();

            Logger.Info(
                $"{Capitalize(sourceName)} capture started: device=\"{device.FriendlyName}\" sampleRate={format.SampleRate} channels={format.Channels} bits={format.BitsPerSample} encoding={format.Encoding}"
            );
        }
    }

    public void Stop()
    {
        IWaveIn? captureToStop;
        lock (sourceLock)
        {
            captureToStop = capture;
            capture = null;
        }

        if (captureToStop == null)
        {
            return;
        }

        captureToStop.DataAvailable -= HandleDataAvailable;
        captureToStop.RecordingStopped -= HandleRecordingStopped;

        try
        {
            captureToStop.StopRecording();
        }
        catch (Exception ex)
        {
            Logger.Error($"Failed to stop {sourceName} capture: {ex.Message}");
        }

        captureToStop.Dispose();
        FinalizeDebugWriters();
        Logger.Info($"{Capitalize(sourceName)} capture stopped");
    }

    public void Dispose()
    {
        Stop();
        enumerator.Dispose();
    }

    private MMDevice ResolveDevice()
    {
        return kind == CaptureInputKind.System
            ? enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)
            : enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Multimedia);
    }

    private void HandleDataAvailable(object? sender, WaveInEventArgs eventArgs)
    {
        try
        {
            if (eventArgs.BytesRecorded <= 0 || sender is not IWaveIn waveIn)
            {
                return;
            }

            var callbackSequence = this.callbackSequence;
            this.callbackSequence += 1;
            var inputBytes = eventArgs.Buffer.AsSpan(0, eventArgs.BytesRecorded);
            var waveFormat = waveIn.WaveFormat;
            var inputSampleRate = Math.Max(1, waveFormat.SampleRate);
            var monoSamples = PcmConverter.ToMonoFloat(inputBytes, waveFormat);
            if (monoSamples.Length == 0)
            {
                return;
            }

            var resampledSamples = Resampler.Resample(
                monoSamples,
                inputSampleRate,
                CaptureConstants.SampleRate
            );
            var hostTimestamp = EstimateBufferStartTimestamp(monoSamples.Length, inputSampleRate);
            RecordCallback(inputBytes, monoSamples, resampledSamples, waveFormat, callbackSequence, hostTimestamp);
            AppendDebugSamples(monoSamples, resampledSamples, hostTimestamp);
            onSamples(resampledSamples, hostTimestamp);
        }
        catch (Exception ex)
        {
            Logger.Error($"{Capitalize(sourceName)} capture callback failed: {ex}");
        }
    }

    private static long EstimateBufferStartTimestamp(int sampleCount, int sampleRate)
    {
        var nowTicks = Stopwatch.GetTimestamp();
        var durationTicks = (long)Math.Round(sampleCount / (double)sampleRate * Stopwatch.Frequency);
        return Math.Max(0, nowTicks - durationTicks);
    }

    private void RecordCallback(
        ReadOnlySpan<byte> inputBytes,
        float[] monoSamples,
        float[] resampledSamples,
        WaveFormat waveFormat,
        ulong callbackSequence,
        long hostTimestamp
    )
    {
        if (kind == CaptureInputKind.Microphone)
        {
            traceWriter?.RecordSamples(
                "mic_audio_unit_callback",
                "mic-audio-unit-raw",
                resampledSamples,
                new Dictionary<string, object?>
                {
                    ["backend"] = "wasapi",
                    ["callbackSequence"] = (long)callbackSequence,
                    ["numberFrames"] = resampledSamples.Length,
                    ["sampleCount"] = resampledSamples.Length,
                    ["hostTime"] = hostTimestamp,
                    ["sourceSampleRate"] = waveFormat.SampleRate,
                    ["sourceChannels"] = waveFormat.Channels,
                    ["sourceEncoding"] = waveFormat.Encoding.ToString()
                }
            );
            return;
        }

        traceWriter?.Record(
            "system_audio_callback",
            new Dictionary<string, object?>
            {
                ["backend"] = "wasapi-loopback",
                ["callbackSequence"] = (long)callbackSequence,
                ["inputBytes"] = inputBytes.Length,
                ["inputBufferCount"] = 1,
                ["outputBytes"] = 0,
                ["outputBufferCount"] = 0,
                ["selectedSource"] = "input",
                ["inputHostTime"] = hostTimestamp,
                ["sourceSampleRate"] = waveFormat.SampleRate,
                ["sourceChannels"] = waveFormat.Channels,
                ["sourceEncoding"] = waveFormat.Encoding.ToString()
            }
        );
        traceWriter?.RecordBytes(
            "system_audio_callback_buffer",
            "system-callback-input-buffer-0",
            inputBytes,
            new Dictionary<string, object?>
            {
                ["backend"] = "wasapi-loopback",
                ["callbackSequence"] = (long)callbackSequence,
                ["scope"] = "input",
                ["bufferIndex"] = 0,
                ["selectedSource"] = "input",
                ["byteCount"] = inputBytes.Length,
                ["bufferChannels"] = waveFormat.Channels,
                ["isSelectedInputBuffer"] = true
            }
        );
        traceWriter?.RecordSamples(
            "system-selected_pre_resample",
            "system-selected-pre-resample",
            monoSamples,
            new Dictionary<string, object?>
            {
                ["backend"] = "wasapi-loopback",
                ["callbackSequence"] = (long)callbackSequence,
                ["selectedSource"] = "input",
                ["hostTime"] = hostTimestamp,
                ["sourceSampleRate"] = waveFormat.SampleRate,
                ["formatSampleRate"] = waveFormat.SampleRate,
                ["formatChannelCount"] = waveFormat.Channels,
                ["formatInterleaved"] = true,
                ["callbackChannelCount"] = waveFormat.Channels,
                ["commonFormat"] = waveFormat.Encoding.ToString(),
                ["sampleCount"] = monoSamples.Length
            }
        );
        traceWriter?.RecordSamples(
            "system-selected_post_resample",
            "system-selected-post-resample",
            resampledSamples,
            new Dictionary<string, object?>
            {
                ["backend"] = "wasapi-loopback",
                ["callbackSequence"] = (long)callbackSequence,
                ["selectedSource"] = "input",
                ["hostTime"] = hostTimestamp,
                ["sourceSampleRate"] = waveFormat.SampleRate,
                ["outputSampleRate"] = CaptureConstants.SampleRate,
                ["sampleCount"] = resampledSamples.Length
            }
        );
    }

    private void InitializeDebugWriters(WaveFormat format)
    {
        if (kind != CaptureInputKind.System || string.IsNullOrWhiteSpace(debugArtifactsDirectory))
        {
            return;
        }

        preResampleDebugWriter = new DebugWavWriter(
            Path.Combine(debugArtifactsDirectory, "system-pre-resample.wav"),
            (uint)Math.Max(1, format.SampleRate)
        );
        postResampleDebugWriter = new DebugWavWriter(
            Path.Combine(debugArtifactsDirectory, "system-post-resample.wav"),
            CaptureConstants.SampleRate
        );
        var anchor = Stopwatch.GetTimestamp();
        preResampleDebugTracker = new SourceSamplePositionTracker(
            new SharedAudioSampleClock(Math.Max(1, format.SampleRate))
        );
        postResampleDebugTracker = new SourceSamplePositionTracker(
            new SharedAudioSampleClock(CaptureConstants.SampleRate)
        );
        preResampleDebugTracker.ResolveStartSampleIndex(anchor, 0);
        postResampleDebugTracker.ResolveStartSampleIndex(anchor, 0);
        preResampleDebugEndSampleIndex = 0;
        postResampleDebugEndSampleIndex = 0;
    }

    private void AppendDebugSamples(float[] monoSamples, float[] resampledSamples, long hostTimestamp)
    {
        try
        {
            AppendTimedDebugSamples(
                monoSamples,
                hostTimestamp,
                preResampleDebugTracker,
                preResampleDebugWriter,
                ref preResampleDebugEndSampleIndex
            );
            AppendTimedDebugSamples(
                resampledSamples,
                hostTimestamp,
                postResampleDebugTracker,
                postResampleDebugWriter,
                ref postResampleDebugEndSampleIndex
            );
        }
        catch (Exception ex)
        {
            Logger.Error($"Failed to write debug audio files: {ex.Message}");
        }
    }

    private static void AppendTimedDebugSamples(
        float[] samples,
        long hostTimestamp,
        SourceSamplePositionTracker? tracker,
        DebugWavWriter? writer,
        ref long endSampleIndex
    )
    {
        if (samples.Length == 0 || tracker == null || writer == null)
        {
            return;
        }

        var startSampleIndex = tracker.ResolveStartSampleIndex(hostTimestamp, samples.Length);
        var gapSamples = Math.Max(0, (int)(startSampleIndex - endSampleIndex));
        if (gapSamples > 0)
        {
            writer.AppendSilence(gapSamples);
        }

        writer.Append(samples);
        endSampleIndex = startSampleIndex + samples.Length;
    }

    private void FinalizeDebugWriters()
    {
        preResampleDebugWriter?.FinalizeFile();
        postResampleDebugWriter?.FinalizeFile();
        preResampleDebugWriter = null;
        postResampleDebugWriter = null;
        preResampleDebugTracker = null;
        postResampleDebugTracker = null;
    }

    private void RecordStarted(MMDevice device, WaveFormat format)
    {
        var eventName =
            kind == CaptureInputKind.Microphone
                ? "microphone_capture_started"
                : "system_capture_started";
        traceWriter?.Record(
            eventName,
            new Dictionary<string, object?>
            {
                ["backend"] = kind == CaptureInputKind.Microphone ? "wasapi" : "wasapi-loopback",
                ["deviceId"] = device.ID,
                ["deviceFriendlyName"] = device.FriendlyName,
                ["sampleRate"] = format.SampleRate,
                ["channels"] = format.Channels,
                ["bitsPerSample"] = format.BitsPerSample,
                ["encoding"] = format.Encoding.ToString()
            }
        );
    }

    private void HandleRecordingStopped(object? sender, StoppedEventArgs eventArgs)
    {
        if (eventArgs.Exception != null)
        {
            Logger.Error($"{Capitalize(sourceName)} capture stopped unexpectedly: {eventArgs.Exception}");
        }
    }

    private static string Capitalize(string value)
    {
        return value.Length == 0 ? value : char.ToUpperInvariant(value[0]) + value[1..];
    }
}
