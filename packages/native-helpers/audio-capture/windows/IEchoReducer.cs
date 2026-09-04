namespace AudioCapture.Windows;

internal interface IEchoReducer : IDisposable
{
    bool IsReal { get; }
    string ModeDescription { get; }

    void IngestRender(float[] samples);
    float[] ProcessCapture(float[] samples);
    void Reset();
}
