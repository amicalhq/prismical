namespace AudioCapture.Windows;

internal sealed class ReferenceEchoReducer : IEchoReducer
{
    private const int MaxDelayMs = 250;
    private const int HistoryMs = 400;
    private const int CoarseSearchStep = 96;
    private const int FineSearchStep = 8;
    private const int AnalysisStride = 6;
    private const float MinCorrelation = 0.32f;
    private const float MinReferenceRms = 0.008f;
    private const float MinScale = 0.06f;
    private const float MaxScale = 1.35f;
    private const float ResidualSuppressionCorrelation = 0.82f;
    private const float ResidualSuppressionGain = 0.82f;

    private readonly FloatHistoryBuffer history = new(
        Math.Max(
            CaptureConstants.SampleRate,
            (int)Math.Round((HistoryMs / 1000.0) * CaptureConstants.SampleRate)
        )
    );

    public bool IsReal => false;
    public string ModeDescription => "reference-reducer-v1";

    public void IngestRender(float[] samples)
    {
        if (samples.Length > 0)
        {
            history.Append(samples);
        }
    }

    public float[] ProcessCapture(float[] samples)
    {
        if (samples.Length == 0)
        {
            return samples;
        }

        var searchWindow = history.Snapshot(MaxDelaySamples + samples.Length);
        if (searchWindow.Length < samples.Length)
        {
            return samples;
        }

        var match = FindBestAlignment(samples, searchWindow);
        if (
            match == null ||
            match.Correlation < MinCorrelation ||
            match.ReferenceRms < MinReferenceRms ||
            match.Scale < MinScale
        )
        {
            return samples;
        }

        var cleaned = new float[samples.Length];
        for (var index = 0; index < samples.Length; index += 1)
        {
            cleaned[index] = samples[index] - (searchWindow[match.StartIndex + index] * match.Scale);
        }

        if (match.Correlation >= ResidualSuppressionCorrelation)
        {
            for (var index = 0; index < cleaned.Length; index += 1)
            {
                cleaned[index] *= ResidualSuppressionGain;
            }
        }

        return cleaned;
    }

    public void Reset()
    {
        history.Clear();
    }

    public void Dispose()
    {
        Reset();
    }

    private static int MaxDelaySamples =>
        Math.Max(0, (int)Math.Round((MaxDelayMs / 1000.0) * CaptureConstants.SampleRate));

    private static AlignmentMatch? FindBestAlignment(float[] capture, float[] referenceWindow)
    {
        var maxStartIndex = referenceWindow.Length - capture.Length;
        if (maxStartIndex < 0)
        {
            return null;
        }

        var coarseStart = SearchRange(
            capture,
            referenceWindow,
            0,
            maxStartIndex,
            CoarseSearchStep,
            AnalysisStride
        );
        if (coarseStart == null)
        {
            return null;
        }

        var fineLowerBound = Math.Max(0, coarseStart.StartIndex - CoarseSearchStep);
        var fineUpperBound = Math.Min(maxStartIndex, coarseStart.StartIndex + CoarseSearchStep);
        var fineStart = SearchRange(
            capture,
            referenceWindow,
            fineLowerBound,
            fineUpperBound,
            FineSearchStep,
            AnalysisStride
        );
        if (fineStart == null)
        {
            return null;
        }

        var exactLowerBound = Math.Max(0, fineStart.StartIndex - FineSearchStep);
        var exactUpperBound = Math.Min(maxStartIndex, fineStart.StartIndex + FineSearchStep);
        return SearchRange(capture, referenceWindow, exactLowerBound, exactUpperBound, 1, 1) ??
            fineStart;
    }

    private static AlignmentMatch? SearchRange(
        float[] capture,
        float[] referenceWindow,
        int lowerBound,
        int upperBound,
        int step,
        int stride
    )
    {
        AlignmentMatch? bestMatch = null;
        for (var startIndex = lowerBound; startIndex <= upperBound; startIndex += Math.Max(1, step))
        {
            var stats = CorrelationStats(capture, referenceWindow, startIndex, stride);
            if (stats == null || stats.Correlation <= 0)
            {
                continue;
            }

            if (bestMatch == null || stats.Correlation > bestMatch.Correlation)
            {
                bestMatch = new AlignmentMatch(
                    startIndex,
                    Math.Clamp(stats.Correlation, float.MinValue, float.MaxValue),
                    Math.Clamp(stats.Scale, 0, MaxScale),
                    stats.ReferenceRms
                );
            }
        }

        return bestMatch;
    }

    private static CorrelationResult? CorrelationStats(
        float[] capture,
        float[] referenceWindow,
        int startIndex,
        int stride
    )
    {
        double captureEnergy = 0;
        double referenceEnergy = 0;
        double dot = 0;
        var sampleCount = 0;

        for (var index = 0; index < capture.Length; index += Math.Max(1, stride))
        {
            var captureSample = capture[index];
            var referenceSample = referenceWindow[startIndex + index];
            dot += captureSample * referenceSample;
            captureEnergy += captureSample * captureSample;
            referenceEnergy += referenceSample * referenceSample;
            sampleCount += 1;
        }

        if (sampleCount == 0 || captureEnergy <= double.Epsilon || referenceEnergy <= double.Epsilon)
        {
            return null;
        }

        var correlation = dot / Math.Sqrt(captureEnergy * referenceEnergy);
        if (!double.IsFinite(correlation) || correlation <= 0)
        {
            return null;
        }

        return new CorrelationResult(
            (float)correlation,
            (float)(dot / referenceEnergy),
            (float)Math.Sqrt(referenceEnergy / sampleCount)
        );
    }

    private sealed record AlignmentMatch(
        int StartIndex,
        float Correlation,
        float Scale,
        float ReferenceRms
    );

    private sealed record CorrelationResult(float Correlation, float Scale, float ReferenceRms);
}

internal sealed class FloatHistoryBuffer
{
    private readonly float[] buffer;
    private int writeIndex;
    private int filled;

    public FloatHistoryBuffer(int capacity)
    {
        buffer = new float[capacity];
    }

    public void Append(float[] samples)
    {
        for (var index = 0; index < samples.Length; index += 1)
        {
            buffer[writeIndex] = samples[index];
            writeIndex = (writeIndex + 1) % buffer.Length;
            filled = Math.Min(filled + 1, buffer.Length);
        }
    }

    public void Clear()
    {
        writeIndex = 0;
        filled = 0;
        Array.Clear(buffer);
    }

    public float[] Snapshot(int maxSamples)
    {
        var sampleCount = Math.Min(maxSamples, filled);
        var output = new float[sampleCount];
        if (sampleCount == 0)
        {
            return output;
        }

        var startIndex = (writeIndex - sampleCount + buffer.Length) % buffer.Length;
        if (startIndex + sampleCount <= buffer.Length)
        {
            Array.Copy(buffer, startIndex, output, 0, sampleCount);
            return output;
        }

        var firstChunkLength = buffer.Length - startIndex;
        Array.Copy(buffer, startIndex, output, 0, firstChunkLength);
        Array.Copy(buffer, 0, output, firstChunkLength, sampleCount - firstChunkLength);
        return output;
    }
}
