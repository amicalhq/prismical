using System.Buffers;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace AudioCapture.Windows;

internal sealed class CaptureTraceWriter : IDisposable
{
    private readonly string directoryPath;
    private readonly FileStream jsonStream;
    private readonly object traceLock = new();
    private readonly Dictionary<string, FileStream> channelStreams = new();
    private readonly Dictionary<string, long> channelByteOffsets = new();
    private bool closed;

    public CaptureTraceWriter(string directoryPath)
    {
        this.directoryPath = directoryPath;
        Directory.CreateDirectory(directoryPath);
        jsonStream = new FileStream(
            Path.Combine(directoryPath, "native-capture-trace.jsonl"),
            FileMode.Create,
            FileAccess.Write,
            FileShare.Read
        );
    }

    public void Record(string eventName, IReadOnlyDictionary<string, object?>? metadata = null)
    {
        lock (traceLock)
        {
            if (closed)
            {
                return;
            }

            var payload = CopyMetadata(metadata);
            payload["event"] = eventName;
            payload["loggedAtEpochMs"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            WriteJsonLineLocked(payload);
        }
    }

    public void RecordSamples(
        string eventName,
        string channel,
        ReadOnlySpan<float> samples,
        IReadOnlyDictionary<string, object?>? metadata = null
    )
    {
        if (samples.IsEmpty)
        {
            return;
        }

        var byteCount = samples.Length * sizeof(float);
        var rented = ArrayPool<byte>.Shared.Rent(byteCount);
        try
        {
            var payload = rented.AsSpan(0, byteCount);
            MemoryMarshalShim.CopyFloat32LittleEndian(samples, payload);
            RecordData(eventName, channel, "f32le", payload, samples.Length, metadata);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented);
        }
    }

    public void RecordBytes(
        string eventName,
        string channel,
        ReadOnlySpan<byte> payload,
        IReadOnlyDictionary<string, object?>? metadata = null
    )
    {
        RecordData(eventName, channel, "bin", payload, null, metadata);
    }

    public void Dispose()
    {
        lock (traceLock)
        {
            if (closed)
            {
                return;
            }

            closed = true;
            jsonStream.Flush();
            jsonStream.Dispose();
            foreach (var stream in channelStreams.Values)
            {
                stream.Flush();
                stream.Dispose();
            }

            channelStreams.Clear();
            channelByteOffsets.Clear();
        }
    }

    private void RecordData(
        string eventName,
        string channel,
        string fileExtension,
        ReadOnlySpan<byte> payloadBytes,
        int? sampleCount,
        IReadOnlyDictionary<string, object?>? metadata
    )
    {
        if (payloadBytes.IsEmpty)
        {
            return;
        }

        lock (traceLock)
        {
            if (closed)
            {
                return;
            }

            var appendResult = AppendDataLocked(channel, fileExtension, payloadBytes);
            var payload = CopyMetadata(metadata);
            payload["event"] = eventName;
            payload["loggedAtEpochMs"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            payload["traceChannel"] = channel;
            payload["traceFilePath"] = appendResult.FilePath;
            payload["traceByteOffset"] = appendResult.ByteOffset;

            if (sampleCount != null)
            {
                payload["traceSampleOffset"] = appendResult.ByteOffset / sizeof(float);
                payload["traceSampleCount"] = sampleCount.Value;
            }

            WriteJsonLineLocked(payload);
        }
    }

    private (string FilePath, long ByteOffset) AppendDataLocked(
        string channel,
        string fileExtension,
        ReadOnlySpan<byte> payload
    )
    {
        var channelKey = $"{channel}.{fileExtension}";
        var filePath = Path.Combine(directoryPath, channelKey);
        if (!channelStreams.TryGetValue(channelKey, out var stream))
        {
            stream = new FileStream(filePath, FileMode.Create, FileAccess.Write, FileShare.Read);
            channelStreams[channelKey] = stream;
            channelByteOffsets[channelKey] = 0;
        }

        var byteOffset = channelByteOffsets[channelKey];
        stream.Write(payload);
        channelByteOffsets[channelKey] = byteOffset + payload.Length;
        return (filePath, byteOffset);
    }

    private void WriteJsonLineLocked(IReadOnlyDictionary<string, object?> payload)
    {
        JsonSerializer.Serialize(jsonStream, payload);
        jsonStream.WriteByte(0x0A);
    }

    private static Dictionary<string, object?> CopyMetadata(
        IReadOnlyDictionary<string, object?>? metadata
    )
    {
        var payload = new Dictionary<string, object?>();
        if (metadata == null)
        {
            return payload;
        }

        foreach (var (key, value) in metadata)
        {
            if (value != null)
            {
                payload[key] = value;
            }
        }

        return payload;
    }
}

internal static class MemoryMarshalShim
{
    public static void CopyFloat32LittleEndian(ReadOnlySpan<float> source, Span<byte> destination)
    {
        var bytes = MemoryMarshal.AsBytes(source);
        bytes.CopyTo(destination);
    }
}
