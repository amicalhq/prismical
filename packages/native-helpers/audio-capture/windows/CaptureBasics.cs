namespace AudioCapture.Windows;

internal enum CaptureMode
{
    Mic,
    System,
    Dual
}

internal enum CaptureSource : byte
{
    MicRaw = 1,
    System = 2,
    MicProcessed = 3
}

internal static class CaptureConstants
{
    public const int SampleRate = 48_000;
    public const int FrameSize = 480;
}

internal static class Logger
{
    public static void Info(string message)
    {
        Console.Error.WriteLine($"[audio-capture] {message}");
    }

    public static void Error(string message)
    {
        Console.Error.WriteLine($"[audio-capture] ERROR: {message}");
    }
}

internal sealed record ParsedArguments(
    CaptureMode Mode,
    string? DebugArtifactsDirectory,
    int AecRenderHoldbackMs,
    int AecRenderWaitTimeoutMs,
    bool CheckSystemAudioPermission
)
{
    public static ParsedArguments Parse(string[] args)
    {
        CaptureMode? mode = null;
        string? debugArtifactsDirectory = null;
        var aecRenderHoldbackMs = TimedDualAecSession.DefaultMicrophoneHoldbackMs;
        int? aecRenderWaitTimeoutMs = null;
        var checkSystemAudioPermission = args.Contains("--check-system-audio-permission");

        for (var index = 0; index < args.Length; index += 1)
        {
            if (args[index] == "--mode" && index + 1 < args.Length)
            {
                mode = ParseMode(args[index + 1]);
                index += 1;
                continue;
            }

            if (args[index] == "--debug-artifacts-dir" && index + 1 < args.Length)
            {
                debugArtifactsDirectory = args[index + 1];
                index += 1;
                continue;
            }

            if (
                args[index] == "--aec-render-holdback-ms" &&
                index + 1 < args.Length &&
                int.TryParse(args[index + 1], out var parsedHoldbackMs)
            )
            {
                aecRenderHoldbackMs = Math.Max(0, parsedHoldbackMs);
                index += 1;
                continue;
            }

            if (
                args[index] == "--aec-render-wait-timeout-ms" &&
                index + 1 < args.Length &&
                int.TryParse(args[index + 1], out var parsedTimeoutMs)
            )
            {
                aecRenderWaitTimeoutMs = Math.Max(0, parsedTimeoutMs);
                index += 1;
                continue;
            }

            if (!args[index].StartsWith("--", StringComparison.Ordinal) && mode == null)
            {
                mode = ParseMode(args[index]);
            }
        }

        if (mode == null)
        {
            throw new ArgumentException("Invalid arguments. Use --mode mic|system|dual.");
        }

        return new ParsedArguments(
            mode.Value,
            debugArtifactsDirectory,
            aecRenderHoldbackMs,
            aecRenderWaitTimeoutMs ?? aecRenderHoldbackMs,
            checkSystemAudioPermission
        );
    }

    private static CaptureMode ParseMode(string value)
    {
        return value.ToLowerInvariant() switch
        {
            "mic" => CaptureMode.Mic,
            "system" => CaptureMode.System,
            "dual" => CaptureMode.Dual,
            _ => throw new ArgumentException("Invalid arguments. Use --mode mic|system|dual.")
        };
    }
}

internal static class TraceHelpers
{
    public static string CaptureSourceName(CaptureSource source)
    {
        return source switch
        {
            CaptureSource.MicRaw => "mic_raw",
            CaptureSource.System => "system",
            CaptureSource.MicProcessed => "mic_processed",
            _ => source.ToString()
        };
    }

    public static ulong TimestampMsForSampleIndex(long sampleIndex)
    {
        if (sampleIndex <= 0)
        {
            return 0;
        }

        return (ulong)((sampleIndex / (double)CaptureConstants.SampleRate) * 1000.0);
    }
}
