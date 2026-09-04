using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

namespace AudioCapture.Windows;

internal sealed class MicrophoneBindingController : IDisposable
{
    private readonly object bindingLock = new();
    private readonly MMDeviceEnumerator enumerator = new();
    private readonly EndpointNotificationClient notificationClient;
    private readonly CaptureTraceWriter? traceWriter;
    private readonly string? debugArtifactsDirectory;
    private readonly Func<float[], long?, int> onSamples;
    private readonly Action? onRealAudioStopped;
    private readonly Action<long>? onSilenceTick;
    private readonly string? initialDeviceId;

    private WasapiSource? source;
    private Timer? silenceTimer;
    private Timer? retryTimer;
    private Timer? watchdogTimer;
    private string? currentDeviceId;
    private string? currentDeviceName;
    private long generation;
    private int revision;
    private int retryAttempt;
    private long bindStartedTicks;
    private long lastCallbackTicks;
    private string pendingReason = "command";
    private bool followsDefault;
    private bool deliveringRealAudio;
    private bool isUnbound;
    private bool unavailableEventActive;
    private bool recoverOnActivation;
    private bool notificationsRegistered;
    private bool started;
    private bool stopped;

    public MicrophoneBindingController(
        string? initialDeviceId,
        CaptureTraceWriter? traceWriter,
        string? debugArtifactsDirectory,
        Func<float[], long?, int> onSamples,
        Action? onRealAudioStopped = null,
        Action<long>? onSilenceTick = null
    )
    {
        this.initialDeviceId = string.IsNullOrWhiteSpace(initialDeviceId)
            ? null
            : initialDeviceId;
        this.traceWriter = traceWriter;
        this.debugArtifactsDirectory = debugArtifactsDirectory;
        this.onSamples = onSamples;
        this.onRealAudioStopped = onRealAudioStopped;
        this.onSilenceTick = onSilenceTick;
        followsDefault = this.initialDeviceId == null;
        notificationClient = new EndpointNotificationClient(
            HandleDefaultDeviceChanged,
            HandleDeviceRemoved,
            HandleDeviceStateChanged,
            HandleDeviceAdded
        );
    }

    public void Start()
    {
        lock (bindingLock)
        {
            if (started || stopped)
            {
                return;
            }

            started = true;
            Marshal.ThrowExceptionForHR(
                enumerator.RegisterEndpointNotificationCallback(notificationClient)
            );
            notificationsRegistered = true;

            if (onSilenceTick != null)
            {
                silenceTimer = new Timer(
                    _ => HandleSilenceTick(),
                    null,
                    TimeSpan.Zero,
                    TimeSpan.FromMilliseconds(10)
                );
            }

            if (initialDeviceId != null)
            {
                BindFixed(initialDeviceId, "command");
            }
            else
            {
                BindDefault("command");
            }
        }
    }

    public void SetMicrophone(string deviceId, int commandRevision)
    {
        lock (bindingLock)
        {
            if (stopped || commandRevision < revision)
            {
                return;
            }

            revision = Math.Max(0, commandRevision);
            followsDefault = false;
            retryAttempt = 0;
            CancelRetry();

            if (SameDevice(currentDeviceId, deviceId))
            {
                if (deliveringRealAudio)
                {
                    EmitBound("command", blackoutMs: 0, trimmedSamples: 0);
                }
                else
                {
                    pendingReason = "command";
                }
                return;
            }

            BindFixed(deviceId, "command");
        }
    }

    public void FollowDefault(int commandRevision)
    {
        lock (bindingLock)
        {
            if (stopped || commandRevision < revision)
            {
                return;
            }

            revision = Math.Max(0, commandRevision);
            followsDefault = true;
            retryAttempt = 0;
            CancelRetry();
            BindDefault("command", emitIfCurrent: true);
        }
    }

    public void ReportTimelineJump(int gapMs)
    {
        lock (bindingLock)
        {
            if (stopped)
            {
                return;
            }

            Logger.MicEvent(
                new Dictionary<string, object>
                {
                    ["kind"] = "timeline-jump",
                    ["gap_ms"] = Math.Max(0, gapMs),
                    ["rev"] = revision
                }
            );
        }
    }

    public void Stop()
    {
        lock (bindingLock)
        {
            if (stopped)
            {
                return;
            }

            stopped = true;
            silenceTimer?.Dispose();
            silenceTimer = null;
            CancelRetry();

            if (notificationsRegistered)
            {
                _ = enumerator.UnregisterEndpointNotificationCallback(notificationClient);
                notificationsRegistered = false;
            }

            DisposeCurrentSource();
        }
    }

    public void Dispose()
    {
        Stop();
        enumerator.Dispose();
    }

    private void BindFixed(string deviceId, string reason)
    {
        followsDefault = false;
        if (!TryGetDeviceName(deviceId, out var deviceName, out var error))
        {
            EmitBindFailed(
                deviceId,
                "device-not-found",
                "MMDeviceEnumerator.GetDevice",
                error?.HResult
            );
            followsDefault = true;
            BindDefault(
                "autonomous-fallback",
                excludedDeviceId: deviceId,
                emitIfCurrent: true
            );
            return;
        }

        BindResolved(deviceId, deviceName, reason, fixedIntent: true);
    }

    private void BindDefault(
        string reason,
        string? excludedDeviceId = null,
        bool emitIfCurrent = false
    )
    {
        followsDefault = true;
        if (
            !TryGetDefaultDevice(out var deviceId, out var deviceName) ||
            SameDevice(deviceId, excludedDeviceId)
        )
        {
            DisposeCurrentSource();
            EnterUnbound();
            return;
        }

        if (SameDevice(currentDeviceId, deviceId))
        {
            if (emitIfCurrent && deliveringRealAudio)
            {
                EmitBound(reason, blackoutMs: 0, trimmedSamples: 0);
            }
            else if (emitIfCurrent)
            {
                pendingReason = reason;
            }
            return;
        }

        BindResolved(deviceId, deviceName, reason, fixedIntent: false);
    }

    private void BindResolved(
        string deviceId,
        string deviceName,
        string reason,
        bool fixedIntent
    )
    {
        var wasUnbound = isUnbound;
        CancelRetry();
        DisposeCurrentSource();
        isUnbound = false;
        recoverOnActivation = recoverOnActivation || wasUnbound;
        pendingReason = reason;
        bindStartedTicks = Stopwatch.GetTimestamp();

        var bindGeneration = ++generation;
        var nextSource = new WasapiSource(
            CaptureInputKind.Microphone,
            traceWriter,
            debugArtifactsDirectory,
            (samples, hostTimestamp) =>
                HandleSamples(bindGeneration, samples, hostTimestamp),
            deviceId,
            exception => HandleUnexpectedStop(bindGeneration, exception)
        );
        source = nextSource;
        currentDeviceId = deviceId;
        currentDeviceName = deviceName;

        try
        {
            nextSource.Start();
            StartWatchdog(bindGeneration);
        }
        catch (Exception ex)
        {
            EmitBindFailed(
                deviceId,
                "wasapi",
                "WasapiCapture.StartRecording(microphone)",
                ex.HResult
            );
            DisposeCurrentSource();

            if (fixedIntent)
            {
                followsDefault = true;
                BindDefault("autonomous-fallback", excludedDeviceId: deviceId);
            }
            else
            {
                EnterUnbound();
            }
        }
    }

    private void HandleSamples(long callbackGeneration, float[] samples, long? hostTimestamp)
    {
        if (!Monitor.TryEnter(bindingLock))
        {
            return;
        }

        try
        {
            if (stopped || callbackGeneration != generation || samples.Length == 0)
            {
                return;
            }

            var firstBuffer = !deliveringRealAudio;
            lastCallbackTicks = Stopwatch.GetTimestamp();
            deliveringRealAudio = true;
            retryAttempt = 0;
            var trimmedSamples = onSamples(samples, hostTimestamp);

            if (!firstBuffer)
            {
                return;
            }

            if (recoverOnActivation && currentDeviceId != null)
            {
                Logger.MicEvent(
                    new Dictionary<string, object>
                    {
                        ["kind"] = "recovered",
                        ["uid"] = currentDeviceId,
                        ["rev"] = revision
                    }
                );
                recoverOnActivation = false;
            }

            unavailableEventActive = false;
            var blackoutMs = (int)Math.Max(
                0,
                ((Stopwatch.GetTimestamp() - bindStartedTicks) * 1000L) / Stopwatch.Frequency
            );
            EmitBound(pendingReason, blackoutMs, trimmedSamples);
        }
        finally
        {
            Monitor.Exit(bindingLock);
        }
    }

    private void HandleUnexpectedStop(long stoppedGeneration, Exception exception)
    {
        lock (bindingLock)
        {
            if (
                stopped ||
                stoppedGeneration != generation ||
                currentDeviceId == null
            )
            {
                return;
            }

            HandleCaptureFailure(
                "wasapi",
                "WasapiCapture.RecordingStopped(microphone)",
                exception.HResult
            );
        }
    }

    private void HandleCaptureFailure(string reason, string? operation, int? status)
    {
        if (currentDeviceId == null)
        {
            return;
        }

        var failedDeviceId = currentDeviceId;
        var fixedIntent = !followsDefault;
        EmitBindFailed(failedDeviceId, reason, operation, status);
        DisposeCurrentSource();

        if (fixedIntent)
        {
            followsDefault = true;
            BindDefault("autonomous-fallback", excludedDeviceId: failedDeviceId);
        }
        else
        {
            EnterUnbound();
        }
    }

    private void HandleDefaultDeviceChanged(DataFlow flow, Role role)
    {
        if (flow != DataFlow.Capture || role != Role.Multimedia)
        {
            return;
        }

        lock (bindingLock)
        {
            if (stopped || !followsDefault)
            {
                return;
            }

            BindDefault("default-change");
        }
    }

    private void HandleDeviceRemoved(string deviceId)
    {
        lock (bindingLock)
        {
            if (
                stopped ||
                !SameDevice(currentDeviceId, deviceId) ||
                IsDeviceActive(deviceId)
            )
            {
                return;
            }

            HandleDeviceLoss(deviceId);
        }
    }

    private void HandleDeviceStateChanged(string deviceId, DeviceState state)
    {
        lock (bindingLock)
        {
            if (stopped)
            {
                return;
            }

            if (
                SameDevice(currentDeviceId, deviceId) &&
                (state & DeviceState.Active) == 0 &&
                !IsDeviceActive(deviceId)
            )
            {
                HandleDeviceLoss(deviceId);
                return;
            }

            if (isUnbound && (state & DeviceState.Active) != 0)
            {
                retryAttempt = 0;
                BindDefault("autonomous-fallback");
            }
        }
    }

    private void HandleDeviceAdded()
    {
        lock (bindingLock)
        {
            if (!stopped && isUnbound)
            {
                retryAttempt = 0;
                BindDefault("autonomous-fallback");
            }
        }
    }

    private void HandleDeviceLoss(string deviceId)
    {
        Logger.MicEvent(
            new Dictionary<string, object>
            {
                ["kind"] = "lost",
                ["uid"] = deviceId,
                ["rev"] = revision
            }
        );
        DisposeCurrentSource();
        followsDefault = true;
        BindDefault("autonomous-fallback", excludedDeviceId: deviceId);
    }

    private void EnterUnbound()
    {
        isUnbound = true;
        deliveringRealAudio = false;
        ScheduleRetry();
        if (unavailableEventActive)
        {
            return;
        }

        unavailableEventActive = true;
        Logger.MicEvent(
            new Dictionary<string, object>
            {
                ["kind"] = "unavailable",
                ["rev"] = revision
            }
        );
    }

    private void HandleSilenceTick()
    {
        if (Volatile.Read(ref deliveringRealAudio))
        {
            return;
        }

        lock (bindingLock)
        {
            if (stopped || deliveringRealAudio)
            {
                return;
            }

            onSilenceTick?.Invoke(Stopwatch.GetTimestamp());
        }
    }

    private void StartWatchdog(long watchedGeneration)
    {
        CancelWatchdog();
        watchdogTimer = new Timer(
            _ => HandleWatchdog(watchedGeneration),
            null,
            TimeSpan.FromSeconds(1),
            TimeSpan.FromSeconds(1)
        );
    }

    private void HandleWatchdog(long watchedGeneration)
    {
        lock (bindingLock)
        {
            if (
                stopped ||
                watchedGeneration != generation ||
                currentDeviceId == null
            )
            {
                return;
            }

            var now = Stopwatch.GetTimestamp();
            if (!deliveringRealAudio)
            {
                if (now - bindStartedTicks >= Stopwatch.Frequency * 2L)
                {
                    HandleCaptureFailure("callback-timeout", operation: null, status: null);
                }
                return;
            }

            if (now - lastCallbackTicks >= Stopwatch.Frequency)
            {
                HandleDeviceLoss(currentDeviceId);
            }
        }
    }

    private void ScheduleRetry()
    {
        var delays = new[] { 1, 2, 5, 10 };
        var delaySeconds = delays[Math.Min(retryAttempt, delays.Length - 1)];
        retryAttempt += 1;
        CancelRetry();
        retryTimer = new Timer(
            _ =>
            {
                lock (bindingLock)
                {
                    retryTimer?.Dispose();
                    retryTimer = null;
                    if (stopped || !isUnbound)
                    {
                        return;
                    }

                    BindDefault("autonomous-fallback");
                }
            },
            null,
            TimeSpan.FromSeconds(delaySeconds),
            Timeout.InfiniteTimeSpan
        );
    }

    private void CancelRetry()
    {
        retryTimer?.Dispose();
        retryTimer = null;
    }

    private void CancelWatchdog()
    {
        watchdogTimer?.Dispose();
        watchdogTimer = null;
    }

    private void DisposeCurrentSource()
    {
        generation += 1;
        CancelWatchdog();
        if (deliveringRealAudio)
        {
            deliveringRealAudio = false;
            onRealAudioStopped?.Invoke();
        }

        var sourceToDispose = source;
        source = null;
        currentDeviceId = null;
        currentDeviceName = null;
        sourceToDispose?.Dispose();
    }

    private bool TryGetDefaultDevice(out string deviceId, out string deviceName)
    {
        try
        {
            using var device = enumerator.GetDefaultAudioEndpoint(
                DataFlow.Capture,
                Role.Multimedia
            );
            deviceId = device.ID;
            deviceName = device.FriendlyName;
            return (device.State & DeviceState.Active) != 0;
        }
        catch
        {
            deviceId = string.Empty;
            deviceName = string.Empty;
            return false;
        }
    }

    private bool TryGetDeviceName(
        string deviceId,
        out string deviceName,
        out Exception? error
    )
    {
        try
        {
            using var device = enumerator.GetDevice(deviceId);
            if ((device.State & DeviceState.Active) == 0)
            {
                deviceName = string.Empty;
                error = null;
                return false;
            }

            deviceName = device.FriendlyName;
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            deviceName = string.Empty;
            error = ex;
            return false;
        }
    }

    private bool IsDeviceActive(string deviceId)
    {
        try
        {
            using var device = enumerator.GetDevice(deviceId);
            return (device.State & DeviceState.Active) != 0;
        }
        catch
        {
            return false;
        }
    }

    private void EmitBound(string reason, int blackoutMs, int trimmedSamples)
    {
        if (currentDeviceId == null || currentDeviceName == null)
        {
            return;
        }

        Logger.MicEvent(
            new Dictionary<string, object>
            {
                ["kind"] = "bound",
                ["uid"] = currentDeviceId,
                ["name"] = currentDeviceName,
                ["mode"] = followsDefault ? "follow-default" : "fixed",
                ["rev"] = revision,
                ["reason"] = reason,
                ["blackout_ms"] = Math.Max(0, blackoutMs),
                ["trimmed_ms"] =
                    (Math.Max(0, trimmedSamples) * 1000) / CaptureConstants.SampleRate
            }
        );
    }

    private void EmitBindFailed(
        string deviceId,
        string reason,
        string? operation,
        int? status
    )
    {
        var message = new Dictionary<string, object>
        {
            ["kind"] = "bind-failed",
            ["uid"] = deviceId,
            ["rev"] = revision,
            ["reason"] = reason
        };
        if (operation != null)
        {
            message["operation"] = operation;
        }
        if (status != null)
        {
            message["os_status"] = status.Value;
        }
        Logger.MicEvent(message);
    }

    private static bool SameDevice(string? left, string? right)
    {
        return left != null &&
            right != null &&
            string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    }
}

internal sealed class EndpointNotificationClient : IMMNotificationClient
{
    private readonly Action<DataFlow, Role> onDefaultDeviceChanged;
    private readonly Action<string> onDeviceRemoved;
    private readonly Action<string, DeviceState> onDeviceStateChanged;
    private readonly Action onDeviceAdded;

    public EndpointNotificationClient(
        Action<DataFlow, Role> onDefaultDeviceChanged,
        Action<string> onDeviceRemoved,
        Action<string, DeviceState> onDeviceStateChanged,
        Action onDeviceAdded
    )
    {
        this.onDefaultDeviceChanged = onDefaultDeviceChanged;
        this.onDeviceRemoved = onDeviceRemoved;
        this.onDeviceStateChanged = onDeviceStateChanged;
        this.onDeviceAdded = onDeviceAdded;
    }

    public void OnDeviceStateChanged(string deviceId, DeviceState newState)
    {
        Dispatch(() => onDeviceStateChanged(deviceId, newState));
    }

    public void OnDeviceAdded(string deviceId)
    {
        Dispatch(onDeviceAdded);
    }

    public void OnDeviceRemoved(string deviceId)
    {
        Dispatch(() => onDeviceRemoved(deviceId));
    }

    public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
    {
        Dispatch(() => onDefaultDeviceChanged(flow, role));
    }

    public void OnPropertyValueChanged(string deviceId, PropertyKey key) { }

    private static void Dispatch(Action callback)
    {
        _ = Task.Run(
            () =>
            {
                try
                {
                    callback();
                }
                catch (Exception ex)
                {
                    Logger.Error($"Audio endpoint notification failed: {ex.Message}");
                }
            }
        );
    }
}
