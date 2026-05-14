using NAudio.CoreAudioApi;

namespace AudioCapture.Windows;

internal static class Program
{
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
        using var stdinShutdown = StartStdinShutdownListener(cancellation, stopped);

        try
        {
            if (parsedArguments.CheckSystemAudioPermission)
            {
                using var enumerator = new MMDeviceEnumerator();
                _ = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                return 0;
            }

            using var session = new CaptureSession(parsedArguments);
            session.Start();
            Logger.Info("Capture binary ready");
            stopped.Wait();
            session.Stop();
            return 0;
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

    private static IDisposable? StartStdinShutdownListener(
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
                        if (
                            string.Equals(line.Trim(), "stop", StringComparison.OrdinalIgnoreCase) ||
                            string.Equals(line.Trim(), "shutdown", StringComparison.OrdinalIgnoreCase)
                        )
                        {
                            cancellation.Cancel();
                            stopped.Set();
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
}
