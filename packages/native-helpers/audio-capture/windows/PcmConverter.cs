using System.Buffers.Binary;
using System.Runtime.InteropServices;
using NAudio.Wave;

namespace AudioCapture.Windows;

internal static class PcmConverter
{
    private static readonly Guid PcmSubFormat = new("00000001-0000-0010-8000-00aa00389b71");
    private static readonly Guid FloatSubFormat = new("00000003-0000-0010-8000-00aa00389b71");

    public static float[] ToMonoFloat(ReadOnlySpan<byte> bytes, WaveFormat waveFormat)
    {
        var sampleEncoding = ResolveSampleEncoding(waveFormat);
        var channels = Math.Max(1, waveFormat.Channels);
        var blockAlign = Math.Max(1, waveFormat.BlockAlign);
        var bytesPerSample = Math.Max(1, waveFormat.BitsPerSample / 8);
        var frameCount = bytes.Length / blockAlign;
        var samples = new float[frameCount];

        for (var frameIndex = 0; frameIndex < frameCount; frameIndex += 1)
        {
            var frameOffset = frameIndex * blockAlign;
            var sum = 0.0f;

            for (var channel = 0; channel < channels; channel += 1)
            {
                var sampleOffset = frameOffset + (channel * bytesPerSample);
                sum += DecodeSample(
                    bytes.Slice(sampleOffset, bytesPerSample),
                    sampleEncoding,
                    waveFormat.BitsPerSample
                );
            }

            samples[frameIndex] = sum / channels;
        }

        return samples;
    }

    private static SampleEncoding ResolveSampleEncoding(WaveFormat waveFormat)
    {
        if (waveFormat.Encoding == WaveFormatEncoding.Pcm)
        {
            return SampleEncoding.Pcm;
        }

        if (waveFormat.Encoding == WaveFormatEncoding.IeeeFloat)
        {
            return SampleEncoding.Float;
        }

        if (waveFormat is WaveFormatExtensible extensible)
        {
            if (extensible.SubFormat == PcmSubFormat)
            {
                return SampleEncoding.Pcm;
            }

            if (extensible.SubFormat == FloatSubFormat)
            {
                return SampleEncoding.Float;
            }
        }

        throw new NotSupportedException($"Unsupported capture format: {waveFormat}");
    }

    private static float DecodeSample(
        ReadOnlySpan<byte> bytes,
        SampleEncoding encoding,
        int bitsPerSample
    )
    {
        if (encoding == SampleEncoding.Float)
        {
            return bitsPerSample switch
            {
                32 => MemoryMarshal.Read<float>(bytes),
                64 => (float)MemoryMarshal.Read<double>(bytes),
                _ => throw new NotSupportedException($"Unsupported float sample size: {bitsPerSample}")
            };
        }

        return bitsPerSample switch
        {
            8 => ((int)bytes[0] - 128) / 128.0f,
            16 => BinaryPrimitives.ReadInt16LittleEndian(bytes) / 32768.0f,
            24 => DecodeInt24(bytes) / 8388608.0f,
            32 => BinaryPrimitives.ReadInt32LittleEndian(bytes) / 2147483648.0f,
            _ => throw new NotSupportedException($"Unsupported PCM sample size: {bitsPerSample}")
        };
    }

    private static int DecodeInt24(ReadOnlySpan<byte> bytes)
    {
        var value = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
        if ((value & 0x800000) != 0)
        {
            value |= unchecked((int)0xff000000);
        }

        return value;
    }

    private enum SampleEncoding
    {
        Pcm,
        Float
    }
}
