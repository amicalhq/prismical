using System.Runtime.InteropServices;

namespace AudioCapture.Windows;

internal sealed class WebRtcAec3EchoReducer : IEchoReducer
{
    private const string DllName = "prismical_webrtc_aec3";
    private IntPtr handle;
    private bool disposed;

    private WebRtcAec3EchoReducer(IntPtr handle)
    {
        this.handle = handle;
    }

    public bool IsReal => true;
    public string ModeDescription => "webrtc-aec3";

    public static bool TryCreate(out IEchoReducer reducer, out string? reason)
    {
        reducer = new ReferenceEchoReducer();
        reason = null;

        try
        {
            if (!NativeLibrary.TryLoad(DllName, typeof(WebRtcAec3EchoReducer).Assembly, null, out var libraryHandle))
            {
                reason = $"{DllName}.dll not found";
                return false;
            }

            NativeLibrary.Free(libraryHandle);

            if (NativeMethods.IsReal() != 1)
            {
                reason = $"{DllName}.dll is not backed by WebRTC AEC3";
                return false;
            }

            var nativeHandle = NativeMethods.Create(CaptureConstants.SampleRate, 1);
            if (nativeHandle == IntPtr.Zero)
            {
                reason = "prismical_aec3_create returned null";
                return false;
            }

            reducer.Dispose();
            reducer = new WebRtcAec3EchoReducer(nativeHandle);
            return true;
        }
        catch (Exception ex) when (
            ex is DllNotFoundException ||
            ex is EntryPointNotFoundException ||
            ex is BadImageFormatException
        )
        {
            reason = ex.Message;
            return false;
        }
    }

    public void IngestRender(float[] samples)
    {
        if (samples.Length == 0 || disposed)
        {
            return;
        }

        NativeMethods.IngestRenderSamples(handle, samples, samples.Length);
    }

    public float[] ProcessCapture(float[] samples)
    {
        if (samples.Length == 0 || disposed)
        {
            return samples;
        }

        var output = new float[samples.Length];
        var written = NativeMethods.ProcessCaptureSamples(
            handle,
            samples,
            samples.Length,
            output,
            output.Length
        );

        if (written <= 0)
        {
            return [];
        }

        if (written == output.Length)
        {
            return output;
        }

        return output.Take(written).ToArray();
    }

    public void Reset()
    {
        if (!disposed)
        {
            NativeMethods.Reset(handle);
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        if (handle != IntPtr.Zero)
        {
            NativeMethods.Destroy(handle);
            handle = IntPtr.Zero;
        }
    }

    private static partial class NativeMethods
    {
        [DllImport(DllName, EntryPoint = "prismical_aec3_create", CallingConvention = CallingConvention.Cdecl)]
        public static extern IntPtr Create(int sampleRateHz, int channels);

        [DllImport(DllName, EntryPoint = "prismical_aec3_destroy", CallingConvention = CallingConvention.Cdecl)]
        public static extern void Destroy(IntPtr handle);

        [DllImport(DllName, EntryPoint = "prismical_aec3_ingest_render_samples", CallingConvention = CallingConvention.Cdecl)]
        public static extern int IngestRenderSamples(
            IntPtr handle,
            [In] float[] render,
            int sampleCount
        );

        [DllImport(DllName, EntryPoint = "prismical_aec3_process_capture_samples", CallingConvention = CallingConvention.Cdecl)]
        public static extern int ProcessCaptureSamples(
            IntPtr handle,
            [In] float[] captureIn,
            int sampleCount,
            [Out] float[] captureOut,
            int outputCapacity
        );

        [DllImport(DllName, EntryPoint = "prismical_aec3_reset", CallingConvention = CallingConvention.Cdecl)]
        public static extern void Reset(IntPtr handle);

        [DllImport(DllName, EntryPoint = "prismical_aec3_is_real", CallingConvention = CallingConvention.Cdecl)]
        public static extern int IsReal();
    }
}
