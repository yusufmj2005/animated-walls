using System.Diagnostics;
using System.Runtime.InteropServices;
using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Desktop;
using AnimatedWalls.Engine.Diagnostics;
using SharpGen.Runtime;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.MediaFoundation;
using Vortice.Mathematics;
using Rect = AnimatedWalls.Engine.Core.Rect;

namespace AnimatedWalls.Engine.Rendering;

/// <summary>Why a surface stopped itself.</summary>
public enum SurfaceFailure
{
    PlaybackFailed,
    NoHardwareDecode,
}

public sealed record SurfaceOptions(
    DisplayInfo Display,
    string MediaPath,
    GpuAdapter Adapter,
    int FrameRateLimit,
    string Quality,
    TimeSpan? ReleaseAfter = null);

/// <summary>
/// Plays one video behind the desktop icons on one display, on a thread of its own.
///
/// While suspended it presents nothing and decodes nothing: the Media Engine is paused, the last
/// frame stays on screen from the swap chain, and the thread sleeps until woken. After a sustained
/// suspension the decoder itself is released, and it is recreated at the same position on resume.
/// </summary>
public sealed class WallpaperSurface : IDisposable
{
    private const string LogSource = "engine.rendering";
    private const int HardwareCheckAfterFrames = 90;
    private const int HardwareCheckAttempts = 2;
    private static readonly TimeSpan HardwareCheckWindow = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan DefaultReleaseAfter = TimeSpan.FromSeconds(30);

    // CLSID_MFMediaEngineClassFactory and IID_IMFMediaEngineClassFactory from mfmediaengine.h.
    private static readonly Guid MediaEngineFactoryClsid = new("b44392da-499b-446b-a4cb-005fead0e6d5");
    private static readonly Guid MediaEngineFactoryIid = new("4D645ACE-26AA-4688-9BE1-DF3516990B93");
    private static readonly Guid MajorTypeKey = new("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    private static readonly Guid SubtypeKey = new("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    private static readonly Guid VideoMajorType = new("73646976-0000-0010-8000-00aa00389b71");

    private readonly SurfaceOptions _options;
    private readonly StructuredLogger _logger;
    private readonly EngineCounters _counters;
    private readonly Action<SurfaceFailure, string> _onFailure;
    private readonly TimeSpan _releaseAfter;
    private readonly AutoResetEvent _wake = new(false);
    private readonly Thread _thread;

    private volatile bool _playing;
    private volatile bool _stopping;
    private volatile int _frameRateLimit;
    private volatile bool _mediaReady;
    private volatile string? _mediaError;
    private volatile bool _failed;

    private DesktopHostWindow? _window;
    private ID3D11Device? _device;
    private ID3D11DeviceContext? _context;
    private IDXGISwapChain1? _swapChain;
    private ID3D11Texture2D? _backBuffer;
    private IMFDXGIDeviceManager? _deviceManager;
    private IDXGIOutput? _output;
    private IMFMediaEngine? _media;
    private bool _mediaPaused = true;
    private double? _resumePosition;
    private long _suspendedAtTicks;
    private long _lastPresentTicks;
    private long _framesDecoded;
    private int _hardwareCheckAttempt;
    private bool _hardwareCheckRunning;
    private bool _hardwareVerified;

    /// <summary>The Media Engine exists. False after a sustained suspension has released it.</summary>
    public bool IsMediaLoaded => Volatile.Read(ref _mediaLoadedFlag);
    private bool _mediaLoadedFlag;

    /// <summary>The GPU's video engine was measured working while this surface decoded.</summary>
    public bool IsHardwareDecodeVerified => Volatile.Read(ref _hardwareVerified);

    public SurfaceOptions Options => _options;

    public WallpaperSurface(SurfaceOptions options, EngineCounters counters, StructuredLogger logger, Action<SurfaceFailure, string> onFailure)
    {
        _options = options;
        _counters = counters;
        _logger = logger;
        _onFailure = onFailure;
        _frameRateLimit = options.FrameRateLimit;
        _releaseAfter = options.ReleaseAfter ?? DefaultReleaseAfter;
        _thread = new Thread(Run) { IsBackground = true, Name = $"WallpaperSurface {options.Display.DeviceName}" };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
    }

    public void SetPlaying(bool playing)
    {
        if (_playing == playing) return;
        _playing = playing;
        _wake.Set();
    }

    public void SetFrameRateLimit(int limit) => _frameRateLimit = limit;

    private void Run()
    {
        try
        {
            CreateOutput();
            Loop();
        }
        catch (Exception exception) when (exception is SharpGenException or InvalidOperationException or COMException)
        {
            Fail(SurfaceFailure.PlaybackFailed, exception.Message, exception);
        }
        finally
        {
            ReleaseEverything();
        }
    }

    private void CreateOutput()
    {
        var bounds = _options.Display.Bounds;
        _window = new DesktopHostWindow(bounds);

        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory2>();
        using var adapter = FindAdapter(factory);
        _output = FindOutput(adapter, _options.Display.DeviceName);

        // Hardware or failure: an explicit adapter with DriverType.Unknown can never become WARP.
        D3D11.D3D11CreateDevice(
            adapter,
            DriverType.Unknown,
            DeviceCreationFlags.VideoSupport | DeviceCreationFlags.BgraSupport,
            [FeatureLevel.Level_12_1, FeatureLevel.Level_12_0, FeatureLevel.Level_11_1, FeatureLevel.Level_11_0],
            out _device,
            out _,
            out _context).CheckError();

        // Media Foundation uses this device from its own threads.
        using (var multithread = _device!.QueryInterface<ID3D11Multithread>())
        {
            multithread.SetMultithreadProtected(true);
        }

        _deviceManager = MediaFactory.MFCreateDXGIDeviceManager();
        _deviceManager.ResetDevice(_device).CheckError();

        // "Balanced" trades sharpness for GPU time by drawing at 75% and letting DWM scale it.
        var scale = _options.Quality == "balanced" ? 0.75 : 1.0;
        var description = new SwapChainDescription1
        {
            Width = (uint)Math.Max(1, (int)(bounds.Width * scale)),
            Height = (uint)Math.Max(1, (int)(bounds.Height * scale)),
            Format = Format.B8G8R8A8_UNorm,
            SampleDescription = new SampleDescription(1, 0),
            BufferUsage = Usage.RenderTargetOutput,
            BufferCount = 2,
            SwapEffect = SwapEffect.FlipDiscard,
            Scaling = Scaling.Stretch,
            AlphaMode = AlphaMode.Ignore,
        };
        _swapChain = factory.CreateSwapChainForHwnd(_device, _window.Handle, description);
        _backBuffer = _swapChain.GetBuffer<ID3D11Texture2D>(0);

        // Black until the first video frame, rather than whatever the buffer happens to hold.
        using (var view = _device.CreateRenderTargetView(_backBuffer))
        {
            _context!.ClearRenderTargetView(view, new Color4(0f, 0f, 0f, 1f));
        }
        _swapChain.Present(0, PresentFlags.None).CheckError();

        _logger.Info(LogSource, "surface.created", new Dictionary<string, object?>
        {
            ["display"] = _options.Display.FriendlyName,
            ["adapter"] = _options.Adapter.Name,
            ["size"] = $"{description.Width}x{description.Height}",
        });
    }

    private void Loop()
    {
        _suspendedAtTicks = Stopwatch.GetTimestamp();

        while (!_stopping && !_failed)
        {
            Pump();

            if (_window is not { IsAlive: true })
            {
                // Explorer went away. The renderer rebuilds this surface when it is back.
                _logger.Info(LogSource, "surface.host-lost", new Dictionary<string, object?> { ["display"] = _options.Display.FriendlyName });
                return;
            }

            if (!_playing)
            {
                Suspend();
                continue;
            }

            if (_media is null) LoadMedia();

            if (_mediaError is { } error)
            {
                Fail(SurfaceFailure.PlaybackFailed, error);
                return;
            }

            if (!_mediaReady)
            {
                WaitForWork(5);
                continue;
            }

            Resume();
            WaitForNextFrameTime();
            if (_media!.OnVideoStreamTick(out _))
            {
                _framesDecoded++;
                _counters.FrameDecoded();
                PresentIfDue();
                CheckHardwareDecode();
            }
        }
    }

    private void Suspend()
    {
        if (_media is not null && !_mediaPaused)
        {
            _media.Pause().CheckError();
            _mediaPaused = true;
            _suspendedAtTicks = Stopwatch.GetTimestamp();
            _logger.Debug(LogSource, "surface.suspended", new Dictionary<string, object?> { ["display"] = _options.Display.FriendlyName });
        }

        if (_media is null)
        {
            WaitForWork(User32.INFINITE);
            return;
        }

        var remaining = _releaseAfter - Stopwatch.GetElapsedTime(_suspendedAtTicks);
        if (remaining <= TimeSpan.Zero)
        {
            ReleaseMedia(rememberPosition: true);
            _logger.Info(LogSource, "surface.decoder-released", new Dictionary<string, object?> { ["display"] = _options.Display.FriendlyName });
            return;
        }
        WaitForWork((uint)Math.Ceiling(remaining.TotalMilliseconds));
    }

    private void Resume()
    {
        if (!_mediaPaused) return;

        if (_resumePosition is { } position)
        {
            _media!.CurrentTime = position;
            _resumePosition = null;
        }
        _media!.Play().CheckError();
        _mediaPaused = false;
        _logger.Debug(LogSource, "surface.playing", new Dictionary<string, object?> { ["display"] = _options.Display.FriendlyName });
    }

    private unsafe void LoadMedia()
    {
        if (!File.Exists(_options.MediaPath))
        {
            _mediaError = $"The wallpaper file is missing: {_options.MediaPath}";
            return;
        }

        _mediaReady = false;

        var clsid = MediaEngineFactoryClsid;
        var iid = MediaEngineFactoryIid;
        Ole32.CoCreateInstance(clsid, 0, Ole32.CLSCTX_INPROC_SERVER, iid, out var factoryPointer).CheckError();
        using var factory = new IMFMediaEngineClassFactory(factoryPointer);

        using (var attributes = MediaFactory.MFCreateAttributes(2))
        {
            attributes.Set(MediaEngineAttributeKeys.DxgiManager.Guid, _deviceManager!);
            attributes.Set(MediaEngineAttributeKeys.VideoOutputFormat.Guid, (uint)Format.B8G8R8A8_UNorm);
            _media = factory.CreateInstance(MediaEngineCreateFlags.None, attributes, OnMediaEvent);
        }

        _media.Muted = true;
        _media.Loop = true;
        _media.AutoPlay = false;
        _media.SetSource(_options.MediaPath).CheckError();
        _media.Load();
        _mediaPaused = true;
        Volatile.Write(ref _mediaLoadedFlag, true);
    }

    /// <summary>Runs on a Media Foundation thread, so it only sets flags and wakes the loop.</summary>
    private void OnMediaEvent(MediaEngineEvent mediaEvent, nuint param1, int param2)
    {
        switch (mediaEvent)
        {
            case MediaEngineEvent.CanPlay:
                _mediaReady = true;
                _wake.Set();
                break;
            case MediaEngineEvent.Error:
                _mediaError = $"The video could not be played (Media Foundation error {(int)param1}, 0x{param2:X8}).";
                _wake.Set();
                break;
        }
    }

    private void PresentIfDue()
    {
        var limit = _frameRateLimit;
        if (limit > 0 && _lastPresentTicks != 0)
        {
            // A small allowance, so 60 fps on a 60 Hz display does not skip every other vblank.
            var interval = TimeSpan.FromSeconds(1.0 / limit) - TimeSpan.FromMilliseconds(2);
            if (Stopwatch.GetElapsedTime(_lastPresentTicks) < interval) return;
        }

        var (sourceRect, destination) = CoverRects();
        _media!.TransferVideoFrame(_backBuffer!, sourceRect, destination);
        _swapChain!.Present(0, PresentFlags.None).CheckError();
        _lastPresentTicks = Stopwatch.GetTimestamp();
        _counters.FramePresented();
    }

    /// <summary>Fills the display, cropping the video's edges rather than leaving black bars.</summary>
    private (VideoNormalizedRect Source, RectI Destination) CoverRects()
    {
        _media!.GetNativeVideoSize(out int videoWidth, out int videoHeight);
        var description = _backBuffer!.Description;
        var width = (int)description.Width;
        var height = (int)description.Height;

        var left = 0f;
        var top = 0f;
        var right = 1f;
        var bottom = 1f;
        if (videoWidth > 0 && videoHeight > 0)
        {
            var videoAspect = (double)videoWidth / videoHeight;
            var targetAspect = (double)width / height;
            if (videoAspect > targetAspect)
            {
                var visible = (float)(targetAspect / videoAspect);
                left = (1f - visible) / 2f;
                right = left + visible;
            }
            else if (videoAspect < targetAspect)
            {
                var visible = (float)(videoAspect / targetAspect);
                top = (1f - visible) / 2f;
                bottom = top + visible;
            }
        }
        return (new VideoNormalizedRect { Left = left, Top = top, Right = right, Bottom = bottom }, new RectI(0, 0, width, height));
    }

    private void CheckHardwareDecode()
    {
        if (_hardwareVerified || _hardwareCheckRunning) return;
        if (_framesDecoded < HardwareCheckAfterFrames * (_hardwareCheckAttempt + 1)) return;

        _hardwareCheckRunning = true;
        CheckCodecAgainstHardware();

        var framesBefore = Interlocked.Read(ref _framesDecoded);
        // Sampling blocks for a second, and the render loop must keep going to be measured at all.
        _ = Task.Run(() =>
        {
            var usage = GpuUsageSampler.Sample(Environment.ProcessId, HardwareCheckWindow);
            var frames = Interlocked.Read(ref _framesDecoded) - framesBefore;
            OnHardwareSample(HardwareDecodeCheck.Evaluate(usage, frames), usage, frames);
        });
    }

    private void OnHardwareSample(HardwareDecodeCheck.Outcome outcome, GpuProcessUsage usage, long frames)
    {
        var details = new Dictionary<string, object?>
        {
            ["display"] = _options.Display.FriendlyName,
            ["outcome"] = outcome.ToString(),
            ["videoDecodePercent"] = usage.VideoDecodePercent,
            ["engine3DPercent"] = usage.Engine3DPercent,
            ["framesDuringSample"] = frames,
            ["error"] = usage.Error,
        };

        switch (outcome)
        {
            case HardwareDecodeCheck.Outcome.Hardware:
                _hardwareVerified = true;
                _logger.Info(LogSource, "decode.hardware-verified", details);
                break;

            case HardwareDecodeCheck.Outcome.SoftwareSuspected when _hardwareCheckAttempt + 1 >= HardwareCheckAttempts:
                _logger.Error(LogSource, "decode.software-detected", details);
                Fail(SurfaceFailure.NoHardwareDecode, "This video is not being decoded on the GPU, so it was stopped rather than using software decoding.");
                break;

            default:
                _logger.Warn(LogSource, "decode.check-inconclusive", details);
                break;
        }

        _hardwareCheckAttempt++;
        _hardwareCheckRunning = false;
    }

    /// <summary>Catches a codec the GPU plainly lacks. Measuring still covers everything else.</summary>
    private void CheckCodecAgainstHardware()
    {
        if (_hardwareCheckAttempt > 0) return;
        var codec = ReadVideoCodec();
        _logger.Info(LogSource, "surface.video", new Dictionary<string, object?>
        {
            ["display"] = _options.Display.FriendlyName,
            ["codec"] = codec,
            ["hardwareCodecs"] = _options.Adapter.HardwareDecodeCodecs.ToArray(),
        });
        if (codec is not null && !_options.Adapter.HardwareDecodeCodecs.Contains(codec))
        {
            Fail(SurfaceFailure.NoHardwareDecode, $"{_options.Adapter.Name} cannot decode {codec.ToUpperInvariant()} in hardware, so this video was stopped rather than using software decoding.");
        }
    }

    private string? ReadVideoCodec()
    {
        try
        {
            using var extended = _media!.QueryInterface<IMFMediaEngineEx>();
            for (var stream = 0; stream < extended.NumberOfStreams; stream++)
            {
                var major = extended.GetStreamAttribute(stream, MajorTypeKey);
                if (major.Value is not Guid majorType || majorType != VideoMajorType) continue;
                var subtype = extended.GetStreamAttribute(stream, SubtypeKey);
                return subtype.Value is Guid value ? HardwareDecodeCheck.CodecFromSubtype(value) : null;
            }
        }
        catch (SharpGenException exception)
        {
            _logger.Warn(LogSource, "surface.codec-unreadable", new Dictionary<string, object?> { ["message"] = exception.Message });
        }
        return null;
    }

    private void WaitForNextFrameTime()
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            _output?.WaitForVBlank();
        }
        catch (SharpGenException exception)
        {
            // A display that has just gone away. Change notifications handle the rest.
            _logger.Debug(LogSource, "surface.vblank-failed", new Dictionary<string, object?> { ["message"] = exception.Message });
        }

        // No output, or a display reporting no vblanks. Never spin instead.
        if (Stopwatch.GetElapsedTime(started) < TimeSpan.FromMilliseconds(1))
        {
            WaitForWork(4);
        }
    }

    /// <summary>Sleeps until woken or timed out, while still answering window messages.</summary>
    private void WaitForWork(uint timeoutMs)
    {
        var handle = _wake.SafeWaitHandle.DangerousGetHandle();
        User32.MsgWaitForMultipleObjectsEx(1, handle, timeoutMs, User32.QS_ALLINPUT, User32.MWMO_INPUTAVAILABLE);
        Pump();
    }

    private static void Pump()
    {
        while (User32.PeekMessage(out var message, 0, 0, 0, User32.PM_REMOVE))
        {
            User32.TranslateMessage(message);
            User32.DispatchMessage(message);
        }
    }

    private void Fail(SurfaceFailure failure, string message, Exception? exception = null)
    {
        if (_failed) return;
        _failed = true;
        _wake.Set();
        if (exception is not null) _logger.Error(LogSource, "surface.failed", exception);
        _logger.Error(LogSource, "surface.failed", new Dictionary<string, object?>
        {
            ["display"] = _options.Display.FriendlyName,
            ["failure"] = failure.ToString(),
            ["message"] = message,
        });
        _onFailure(failure, message);
    }

    private void ReleaseMedia(bool rememberPosition)
    {
        if (_media is null) return;
        if (rememberPosition) _resumePosition = _media.CurrentTime;
        var result = _media.Shutdown();
        if (result.Failure) _logger.Warn(LogSource, "surface.media-shutdown-failed", new Dictionary<string, object?> { ["code"] = result.Code });
        _media.Dispose();
        _media = null;
        _mediaReady = false;
        _mediaPaused = true;
        Volatile.Write(ref _mediaLoadedFlag, false);
    }

    private void ReleaseEverything()
    {
        ReleaseMedia(rememberPosition: false);
        _output?.Dispose();
        _backBuffer?.Dispose();
        _swapChain?.Dispose();
        _deviceManager?.Dispose();
        _context?.Dispose();
        _device?.Dispose();
        _window?.Dispose();
        _logger.Info(LogSource, "surface.removed", new Dictionary<string, object?> { ["display"] = _options.Display.FriendlyName });
    }

    private IDXGIAdapter1 FindAdapter(IDXGIFactory2 factory)
    {
        for (uint index = 0; factory.EnumAdapters1(index, out var adapter).Success; index++)
        {
            var luid = adapter.Description1.Luid;
            if ($"{luid.HighPart:X8}{luid.LowPart:X8}" == _options.Adapter.Luid) return adapter;
            adapter.Dispose();
        }
        throw new InvalidOperationException($"{_options.Adapter.Name} is no longer available.");
    }

    private static IDXGIOutput? FindOutput(IDXGIAdapter1 adapter, string deviceName)
    {
        for (uint index = 0; adapter.EnumOutputs(index, out var output).Success; index++)
        {
            if (string.Equals(output.Description.DeviceName.TrimEnd('\0'), deviceName, StringComparison.OrdinalIgnoreCase)) return output;
            output.Dispose();
        }
        return null;
    }

    public void Dispose()
    {
        _stopping = true;
        _wake.Set();
        if (!_thread.Join(TimeSpan.FromSeconds(5)))
        {
            _logger.Warn(LogSource, "surface.stop-timeout", new Dictionary<string, object?> { ["display"] = _options.Display.FriendlyName });
            return;
        }
        _wake.Dispose();
    }
}
