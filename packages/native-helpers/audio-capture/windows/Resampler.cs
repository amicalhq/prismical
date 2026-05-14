namespace AudioCapture.Windows;

internal static class Resampler
{
    public static float[] Resample(float[] input, int inputSampleRate, int outputSampleRate)
    {
        if (input.Length == 0 || inputSampleRate <= 0)
        {
            return [];
        }

        if (inputSampleRate == outputSampleRate)
        {
            return input;
        }

        var outputLength = Math.Max(
            1,
            (int)Math.Round(input.Length * (double)outputSampleRate / inputSampleRate)
        );
        var output = new float[outputLength];
        var ratio = (double)inputSampleRate / outputSampleRate;

        for (var index = 0; index < output.Length; index += 1)
        {
            var sourcePosition = index * ratio;
            var leftIndex = Math.Min((int)Math.Floor(sourcePosition), input.Length - 1);
            var rightIndex = Math.Min(leftIndex + 1, input.Length - 1);
            var fraction = (float)(sourcePosition - leftIndex);
            output[index] = input[leftIndex] + ((input[rightIndex] - input[leftIndex]) * fraction);
        }

        return output;
    }
}
