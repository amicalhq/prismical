using System.Text.Json;
using System.Text.Json.Serialization;
using NAudio.CoreAudioApi;

namespace AudioCapture.Windows;

internal sealed record MicrophoneCommandPayload(
    [property: JsonPropertyName("cmd")] string Cmd,
    [property: JsonPropertyName("uid")] string? Uid,
    [property: JsonPropertyName("rev")] int? Revision
);

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static int Main(string[] args)
    {
        ParsedArguments parsedArguments;
        try
        {
            parsedArguments = ParsedArguments.Parse(args);
        }
        catch (Exception ex)
        {
            Logger.Error(ex.Message);
            return 1;
        }

        using var cancellation = new CancellationTokenSource();
        using var stopped = new ManualResetEventSlim(false);
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
            stopped.Set();
        };
        try
        {
            if (parsedArguments.CheckSystemAudioPermission)
            {
                using var enumerator = new MMDeviceEnumerator();
                _ = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                return 0;
            }

            var exitCode = 0;
            using var session = new CaptureSession(
                parsedArguments,
                _ =>
                {
                    Interlocked.Exchange(ref exitCode, 1);
                    stopped.Set();
                }
            );
            session.Start();
            using var stdinShutdown = StartStdinListener(session, cancellation, stopped);
            Logger.Info("Capture binary ready");
            stopped.Wait();
            session.Stop();
            return Volatile.Read(ref exitCode);
        }
        catch (OperationCanceledException)
        {
            return 0;
        }
        catch (Exception ex)
        {
            Logger.Error(ex.ToString());
            return 1;
        }
    }

    private static IDisposable? StartStdinListener(
        CaptureSession session,
        CancellationTokenSource cancellation,
        ManualResetEventSlim stopped
    )
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
                        var trimmed = line.Trim();
                        if (
                            string.Equals(trimmed, "stop", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(trimmed, "shutdown", StringComparison.OrdinalIgnoreCase)
                        )
                        {
                            cancellation.Cancel();
                            stopped.Set();
                            return;
                        }

                        HandleMicrophoneCommand(session, trimmed);
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

    private static void HandleMicrophoneCommand(CaptureSession session, string line)
    {
        if (!line.StartsWith('{'))
        {
            return;
        }

        MicrophoneCommandPayload? command;
        try
        {
            command = JsonSerializer.Deserialize<MicrophoneCommandPayload>(line, JsonOptions);
        }
        catch (JsonException)
        {
            Logger.Error("Ignoring invalid microphone command");
            return;
        }

        if (command?.Revision is not { } revision || revision < 0)
        {
            Logger.Error("Ignoring invalid microphone command");
            return;
        }

        switch (command.Cmd)
        {
            case "set-mic" when !string.IsNullOrWhiteSpace(command.Uid):
                session.SetMicrophone(command.Uid, revision);
                break;
            case "follow-default":
                session.FollowDefaultMicrophone(revision);
                break;
            case "set-mic":
                Logger.Error("Ignoring set-mic command without a device UID");
                break;
            default:
                Logger.Error($"Ignoring unknown microphone command: {command.Cmd}");
                break;
        }
    }
}
