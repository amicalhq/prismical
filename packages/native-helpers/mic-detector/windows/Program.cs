using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

namespace PrismicalMicDetector.Windows;

internal sealed record MicActiveApp(
    [property: JsonPropertyName("bundleId")] string BundleId,
    [property: JsonPropertyName("pid")] int Pid,
    [property: JsonPropertyName("detectedAtMs")] long DetectedAtMs,
    [property: JsonPropertyName("applicationName")] string? ApplicationName
);

internal sealed record SnapshotMessage(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("timestampMs")] long TimestampMs,
    [property: JsonPropertyName("apps")] IReadOnlyList<MicActiveApp> Apps
);

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<int> Main()
    {
        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        using var stdinShutdown = StartStdinShutdownListener(cancellation);

        try
        {
            using var detector = new MicDetector();
            LogInfo("Microphone activity detector started");

            while (!cancellation.IsCancellationRequested)
            {
                EmitSnapshot(detector);

                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), cancellation.Token);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }

            LogInfo("Microphone activity detector stopped");
            return 0;
        }
        catch (Exception ex)
        {
            LogError($"Fatal detector error: {ex}");
            return 1;
        }
    }

    private static IDisposable? StartStdinShutdownListener(CancellationTokenSource cancellation)
    {
        if (!Console.IsInputRedirected)
        {
            return null;
        }

        var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token);
        _ = Task.Run(
            () =>
            {
                try
                {
                    string? line;
                    while (!linkedCancellation.IsCancellationRequested &&
                           (line = Console.In.ReadLine()) != null)
                    {
                        if (
                            string.Equals(line.Trim(), "stop", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(line.Trim(), "shutdown", StringComparison.OrdinalIgnoreCase)
                        )
                        {
                            cancellation.Cancel();
                            return;
                        }
                    }
                }
                catch (ObjectDisposedException)
                {
                    // Process teardown can close stdin while this background read is active.
                }
            },
            linkedCancellation.Token
        );
        return linkedCancellation;
    }

    private static void EmitSnapshot(MicDetector detector)
    {
        try
        {
            var timestampMs = CurrentTimestampMs();
            var apps = detector.LoadActiveInputApps(timestampMs);
            var message = new SnapshotMessage("snapshot", timestampMs, apps);
            Console.Out.WriteLine(JsonSerializer.Serialize(message, JsonOptions));
            Console.Out.Flush();
        }
        catch (Exception ex)
        {
            LogError($"Failed to load active input apps: {ex.Message}");
        }
    }

    private static long CurrentTimestampMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    private static void LogInfo(string message)
    {
        Console.Error.WriteLine($"[prismical-mic-detector] {message}");
    }

    private static void LogError(string message)
    {
        Console.Error.WriteLine($"[prismical-mic-detector] ERROR: {message}");
    }
}

internal sealed class MicDetector : IDisposable
{
    private readonly MMDeviceEnumerator deviceEnumerator = new();

    public IReadOnlyList<MicActiveApp> LoadActiveInputApps(long detectedAtMs)
    {
        var appsByPid = new Dictionary<int, MicActiveApp>();

        foreach (var device in deviceEnumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
        {
            try
            {
                var sessionManager = device.AudioSessionManager;
                sessionManager.RefreshSessions();
                var sessions = sessionManager.Sessions;

                for (var index = 0; index < sessions.Count; index += 1)
                {
                    using var session = sessions[index];
                    if (session.State != AudioSessionState.AudioSessionStateActive)
                    {
                        continue;
                    }

                    var pid = unchecked((int)session.GetProcessID);
                    if (pid <= 0 || appsByPid.ContainsKey(pid))
                    {
                        continue;
                    }

                    var identity = ProcessIdentityResolver.Resolve(pid);
                    if (identity == null)
                    {
                        continue;
                    }

                    appsByPid[pid] = new MicActiveApp(
                        identity.BundleId,
                        pid,
                        detectedAtMs,
                        identity.ApplicationName
                    );
                }
            }
            catch (Exception ex)
            {
                LogError($"Failed to inspect capture device '{device.FriendlyName}': {ex.Message}");
            }
        }

        return appsByPid.Values
            .OrderBy(app => app.BundleId, StringComparer.OrdinalIgnoreCase)
            .ThenBy(app => app.Pid)
            .ToList();
    }

    public void Dispose()
    {
        deviceEnumerator.Dispose();
    }

    private static void LogError(string message)
    {
        Console.Error.WriteLine($"[prismical-mic-detector] ERROR: {message}");
    }
}

internal sealed record ProcessIdentity(string BundleId, string? ApplicationName);

internal static class ProcessIdentityResolver
{
    public static ProcessIdentity? Resolve(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            var executablePath = TryGetExecutablePath(process);
            var executableName = ResolveExecutableName(process, executablePath);
            if (string.IsNullOrWhiteSpace(executableName))
            {
                return null;
            }

            var applicationName = ResolveApplicationName(process, executablePath);
            return new ProcessIdentity(executableName.ToLowerInvariant(), applicationName);
        }
        catch
        {
            return null;
        }
    }

    private static string? TryGetExecutablePath(Process process)
    {
        try
        {
            return process.MainModule?.FileName;
        }
        catch
        {
            return null;
        }
    }

    private static string ResolveExecutableName(Process process, string? executablePath)
    {
        if (!string.IsNullOrWhiteSpace(executablePath))
        {
            var fileName = Path.GetFileName(executablePath);
            if (!string.IsNullOrWhiteSpace(fileName))
            {
                return fileName;
            }
        }

        return process.ProcessName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? process.ProcessName
            : $"{process.ProcessName}.exe";
    }

    private static string? ResolveApplicationName(Process process, string? executablePath)
    {
        if (!string.IsNullOrWhiteSpace(executablePath))
        {
            try
            {
                var versionInfo = FileVersionInfo.GetVersionInfo(executablePath);
                if (!string.IsNullOrWhiteSpace(versionInfo.FileDescription))
                {
                    return versionInfo.FileDescription;
                }

                if (!string.IsNullOrWhiteSpace(versionInfo.ProductName))
                {
                    return versionInfo.ProductName;
                }
            }
            catch
            {
                // Fall back to the process name below.
            }
        }

        return string.IsNullOrWhiteSpace(process.ProcessName) ? null : process.ProcessName;
    }
}
