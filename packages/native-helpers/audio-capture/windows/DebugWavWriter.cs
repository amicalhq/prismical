using System.Buffers.Binary;

namespace AudioCapture.Windows;

internal sealed class DebugWavWriter : IDisposable
{
    private readonly string filePath;
    private readonly uint sampleRate;
    private readonly ushort channels;
    private readonly FileStream stream;
    private uint dataSize;
    private bool finalized;

    public DebugWavWriter(string filePath, uint sampleRate, ushort channels = 1)
    {
        this.filePath = filePath;
        this.sampleRate = sampleRate;
        this.channels = channels;

        Directory.CreateDirectory(Path.GetDirectoryName(filePath) ?? ".");
        stream = new FileStream(filePath, FileMode.Create, FileAccess.ReadWrite, FileShare.Read);
        WriteHeader();
        Logger.Info($"Debug audio file initialized: {filePath}");
    }

    public void Append(float[] samples)
    {
        if (samples.Length == 0 || finalized)
        {
            return;
        }

        Span<byte> encoded = stackalloc byte[Math.Min(samples.Length, 4096) * sizeof(short)];
        var remaining = samples.AsSpan();
        while (!remaining.IsEmpty)
        {
            var batchSamples = Math.Min(remaining.Length, encoded.Length / sizeof(short));
            var batchBytes = encoded[..(batchSamples * sizeof(short))];
            for (var index = 0; index < batchSamples; index += 1)
            {
                var clamped = Math.Clamp(remaining[index], -1.0f, 1.0f);
                var intValue = (short)(clamped * short.MaxValue);
                BinaryPrimitives.WriteInt16LittleEndian(
                    batchBytes.Slice(index * sizeof(short), sizeof(short)),
                    intValue
                );
            }

            stream.Write(batchBytes);
            dataSize += (uint)batchBytes.Length;
            remaining = remaining[batchSamples..];
        }
    }

    public void AppendSilence(int sampleCount)
    {
        if (sampleCount <= 0 || finalized)
        {
            return;
        }

        var byteCount = sampleCount * channels * sizeof(short);
        var zeros = new byte[Math.Min(byteCount, 8192)];
        while (byteCount > 0)
        {
            var writeCount = Math.Min(byteCount, zeros.Length);
            stream.Write(zeros.AsSpan(0, writeCount));
            dataSize += (uint)writeCount;
            byteCount -= writeCount;
        }
    }

    public void Dispose()
    {
        FinalizeFile();
    }

    public void FinalizeFile()
    {
        if (finalized)
        {
            return;
        }

        finalized = true;
        stream.Flush();
        stream.Position = 0;
        WriteHeader();
        stream.Flush();
        stream.Dispose();

        var durationSeconds =
            dataSize / (double)(Math.Max(1u, sampleRate) * Math.Max(1, (int)channels) * sizeof(short));
        Logger.Info(
            $"Debug audio file finalized: path={filePath} dataSize={dataSize} duration={durationSeconds}"
        );
    }

    private void WriteHeader()
    {
        Span<byte> header = stackalloc byte[44];
        WriteAscii(header[..4], "RIFF");
        BinaryPrimitives.WriteUInt32LittleEndian(header[4..8], dataSize + 36);
        WriteAscii(header[8..12], "WAVE");
        WriteAscii(header[12..16], "fmt ");
        BinaryPrimitives.WriteUInt32LittleEndian(header[16..20], 16);
        BinaryPrimitives.WriteUInt16LittleEndian(header[20..22], 1);
        BinaryPrimitives.WriteUInt16LittleEndian(header[22..24], channels);
        BinaryPrimitives.WriteUInt32LittleEndian(header[24..28], sampleRate);
        BinaryPrimitives.WriteUInt32LittleEndian(
            header[28..32],
            sampleRate * channels * sizeof(short)
        );
        BinaryPrimitives.WriteUInt16LittleEndian(
            header[32..34],
            (ushort)(channels * sizeof(short))
        );
        BinaryPrimitives.WriteUInt16LittleEndian(header[34..36], 16);
        WriteAscii(header[36..40], "data");
        BinaryPrimitives.WriteUInt32LittleEndian(header[40..44], dataSize);
        stream.Write(header);
    }

    private static void WriteAscii(Span<byte> destination, string value)
    {
        for (var index = 0; index < destination.Length && index < value.Length; index += 1)
        {
            destination[index] = (byte)value[index];
        }
    }
}
