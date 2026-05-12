using System.Buffers.Binary;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AudioCapture.Windows;

internal sealed class PacketWriter
{
    private const byte PacketVersion = 1;
    private const byte PacketFormatFloat32Le = 1;
    private const int HeaderSize = 32;

    private readonly object writeLock = new();
    private readonly Stream stdout = Console.OpenStandardOutput();
    private readonly Stopwatch startedAt = Stopwatch.StartNew();
    private readonly CaptureTraceWriter? traceWriter;
    private readonly Dictionary<CaptureSource, uint> sequences = new()
    {
        [CaptureSource.MicRaw] = 0,
        [CaptureSource.System] = 0,
        [CaptureSource.MicProcessed] = 0
    };

    public PacketWriter(CaptureTraceWriter? traceWriter = null)
    {
        this.traceWriter = traceWriter;
    }

    public void Write(
        CaptureSource source,
        float[] samples,
        ulong? timestampMs = null,
        long? sampleStartIndex = null
    )
    {
        if (samples.Length == 0)
        {
            return;
        }

        var resolvedTimestampMs = timestampMs ?? (ulong)startedAt.ElapsedMilliseconds;
        var resolvedSampleStartIndex = Math.Max(0, sampleStartIndex ?? 0);
        var header = new byte[HeaderSize];
        var payload = MemoryMarshal.AsBytes(samples.AsSpan());
        var sequence = sequences[source];
        sequences[source] = sequence + 1;

        header[0] = PacketVersion;
        header[1] = (byte)source;
        header[2] = PacketFormatFloat32Le;
        header[3] = 1;
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(4), CaptureConstants.SampleRate);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(8), sequence);
        BinaryPrimitives.WriteUInt32LittleEndian(
            header.AsSpan(12),
            (uint)((samples.Length / (double)CaptureConstants.SampleRate) * 1000.0)
        );
        BinaryPrimitives.WriteUInt64LittleEndian(header.AsSpan(16), resolvedTimestampMs);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(24), (uint)payload.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(
            header.AsSpan(28),
            (uint)Math.Clamp(resolvedSampleStartIndex, 0, (long)uint.MaxValue)
        );

        lock (writeLock)
        {
            stdout.Write(header);
            stdout.Write(payload);
            stdout.Flush();
        }

        traceWriter?.RecordSamples(
            "packet_emit",
            $"packet-{TraceHelpers.CaptureSourceName(source)}",
            samples,
            new Dictionary<string, object?>
            {
                ["source"] = TraceHelpers.CaptureSourceName(source),
                ["timestampMs"] = (long)resolvedTimestampMs,
                ["sampleStartIndex"] = resolvedSampleStartIndex,
                ["durationMs"] = (int)((samples.Length / (double)CaptureConstants.SampleRate) * 1000.0),
                ["sequenceNum"] = (int)sequence,
                ["sampleRate"] = CaptureConstants.SampleRate,
                ["channels"] = 1,
                ["sampleCount"] = samples.Length
            }
        );
    }
}
