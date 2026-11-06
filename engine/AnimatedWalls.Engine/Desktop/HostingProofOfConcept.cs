using System.Diagnostics;
using System.Runtime.InteropServices;
using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Diagnostics;
using AnimatedWalls.Engine.Displays;
using AnimatedWalls.Engine.Rendering;
using AnimatedWalls.Engine.Visibility;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using Rect = AnimatedWalls.Engine.Core.Rect;

namespace AnimatedWalls.Engine.Desktop;

/// <summary>
/// Technical proof of concept for desktop hosting. It parents a Direct3D 11 window
/// behind the desktop icons on the primary display, presents frames from the hardware
/// adapter, and then measures three things: whether the expected colour reached the
/// screen, how much GPU this process used while presenting, and how much after stopping.
///
/// This is not the wallpaper renderer. It clears to solid colours, and it runs only
/// when asked for with --hosting-poc. Everything it creates dies with the process.
/// </summary>
public static unsafe class HostingProofOfConcept
{
    public sealed record PocOptions(int Seconds, string Variant);

    public sealed record VariantResult(
        string Variant,
        bool WindowCreated,
        bool Reparented,
        bool ChildOfExpectedParent,
        bool BelowDesktopIcons,
        string? SwapEffect,
        string? Error,
        long FramesPresented,
        GpuProcessUsage? GpuWhilePresenting,
        GpuProcessUsage? GpuAfterStopping,
        string PixelCheck,
        string? PixelBefore,
        string? PixelDuring,
        string? PixelAfter);

    public sealed record PocReport(
        string Layout,
        string? ParentClass,
        string? Adapter,
        string? AdapterRejected,
        string DisplayGeometry,
        string? SamplePoint,
        IReadOnlyList<VariantResult> Variants,
        string Conclusion);

    // A colour unlikely to appear in a real wallpaper, so a match means our frames.
    private static readonly Color4 ProbeColor = new(0.85f, 0.10f, 0.65f, 1f);
    private const byte ProbeR = 217, ProbeG = 26, ProbeB = 166;
    private const int ColorTolerance = 6;

    private const string WindowClassName = "AnimatedWallsHostingPoc";
    private static int _classRegistered;

    public static PocReport Run(PocOptions options, StructuredLogger logger)
    {
        var gpu = GpuCapabilityDetector.Detect();
        logger.Info("engine.desktop", "hosting-poc.start", new Dictionary<string, object?>
        {
            ["gpu"] = gpu.SelectedAdapter?.Name,
            ["variant"] = options.Variant,
        });

        var display = DisplayEnumerator.Enumerate().First(item => item.IsPrimary);
        var geometry = $"{display.Bounds.Width}x{display.Bounds.Height} at ({display.Bounds.X},{display.Bounds.Y})";

        var target = DesktopHostLocator.Locate();
        var parentClass = target.Parent != 0 ? User32.ClassNameOf(target.Parent) : null;
        if (target.Layout == DesktopLayout.Unavailable || target.Parent == 0)
        {
            return new PocReport(target.Layout.ToString(), parentClass, gpu.SelectedAdapter?.Name, null, geometry, null, [],
                "No hosting window could be located, so nothing was rendered.");
        }

        if (gpu.SelectedAdapter is null)
        {
            return new PocReport(target.Layout.ToString(), parentClass, null, string.Join(" ", gpu.UnsupportedReasons), geometry, null, [],
                "No hardware adapter is available, so nothing was rendered. Software rendering is never used.");
        }

        // Sample away from the top-left, where desktop icons usually sit.
        var samplePoint = (X: display.Bounds.X + display.Bounds.Width * 3 / 4, Y: display.Bounds.Y + display.Bounds.Height / 2);

        string[] variants = options.Variant == "auto" ? ["child-flip", "layered-blt"] : [options.Variant];
        var results = new List<VariantResult>();
        using var reader = new DesktopPixelReader(target.Progman, samplePoint);
        foreach (var variant in variants)
        {
            var result = RunVariant(variant, target, display, gpu.SelectedAdapter, reader, options.Seconds, logger);
            results.Add(result);
            if (result.PixelCheck == "passed") break;
        }

        return new PocReport(
            target.Layout.ToString(),
            parentClass,
            gpu.SelectedAdapter.Name,
            null,
            geometry,
            $"{samplePoint.X},{samplePoint.Y} ({reader.Method})",
            results,
            Conclude(results));
    }

    private static string Conclude(IReadOnlyList<VariantResult> results)
    {
        var passed = results.FirstOrDefault(result => result.PixelCheck == "passed");
        if (passed is not null) return $"Hosting verified with variant '{passed.Variant}': the probe colour reached the screen behind the icons.";
        if (results.Any(result => result.PixelCheck == "skipped")) return "The window hierarchy and presenting were checked, but the desktop could not be read, so whether frames reached the screen was NOT verified.";
        return "No variant put the probe colour on screen. Hosting is NOT verified on this system.";
    }

    private static VariantResult RunVariant(
        string variant,
        DesktopHostTarget target,
        DisplayInfo display,
        GpuAdapter adapterInfo,
        DesktopPixelReader reader,
        int seconds,
        StructuredLogger logger)
    {
        var layered = variant == "layered-blt";
        var swapEffect = layered ? SwapEffect.Discard : SwapEffect.FlipDiscard;
        var pixelBefore = reader.Read();

        var window = CreateHostWindow(display.Bounds);
        if (window == 0)
        {
            return new VariantResult(variant, false, false, false, false, null, $"CreateWindowEx failed with error {Marshal.GetLastPInvokeError()}.", 0, null, null, "skipped", null, null, null);
        }

        ID3D11Device? device = null;
        ID3D11DeviceContext? context = null;
        IDXGISwapChain1? swapChain = null;
        ID3D11RenderTargetView? targetView = null;
        IDXGIFactory2? factory = null;
        IDXGIAdapter1? adapter = null;

        try
        {
            if (!DesktopHostAttachment.Attach(window, target, display.Bounds, layered, out var attachError))
            {
                return new VariantResult(variant, true, false, false, false, swapEffect.ToString(), attachError, 0, null, null, "skipped", pixelBefore, null, null);
            }

            var childOfParent = User32.GetParent(window) == target.Parent;
            var belowIcons = IsBelowIcons(window, target);

            factory = DXGI.CreateDXGIFactory1<IDXGIFactory2>();
            adapter = FindAdapter(factory, adapterInfo);
            // DriverType.Unknown with an explicit adapter: hardware or failure, never WARP.
            D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport,
                [FeatureLevel.Level_12_1, FeatureLevel.Level_12_0, FeatureLevel.Level_11_1, FeatureLevel.Level_11_0],
                out device, out _, out context).CheckError();

            var description = new SwapChainDescription1
            {
                Width = (uint)display.Bounds.Width,
                Height = (uint)display.Bounds.Height,
                Format = Format.B8G8R8A8_UNorm,
                SampleDescription = new SampleDescription(1, 0),
                BufferUsage = Usage.RenderTargetOutput,
                BufferCount = layered ? 1u : 2u,
                SwapEffect = swapEffect,
                Scaling = Scaling.Stretch,
                AlphaMode = AlphaMode.Ignore,
            };
            swapChain = factory.CreateSwapChainForHwnd(device!, window, description);
            using (var backBuffer = swapChain.GetBuffer<ID3D11Texture2D>(0))
            {
                targetView = device!.CreateRenderTargetView(backBuffer);
            }

            var frames = 0L;
            var stopwatch = Stopwatch.StartNew();

            // First phase: animate, sampling this process's GPU use on a worker thread
            // because the sampler blocks and the render loop must keep presenting.
            var totalMs = seconds * 1000;
            var presentingUsage = Task.Run(() => GpuUsageSampler.Sample(Environment.ProcessId, TimeSpan.FromMilliseconds(Math.Max(500, totalMs / 2))));
            while (stopwatch.ElapsedMilliseconds < totalMs)
            {
                PumpMessages();
                var phase = (float)(stopwatch.Elapsed.TotalSeconds % 2.0 / 2.0);
                context!.ClearRenderTargetView(targetView, new Color4(0.05f + phase * 0.2f, 0.08f, 0.25f - phase * 0.15f, 1f));
                swapChain.Present(1, PresentFlags.None).CheckError();
                frames++;
            }

            // Second phase: hold the probe colour so a screen read has a stable target.
            for (var index = 0; index < 30; index++)
            {
                PumpMessages();
                context!.ClearRenderTargetView(targetView, ProbeColor);
                swapChain.Present(1, PresentFlags.None).CheckError();
                frames++;
            }
            var pixelDuring = reader.Read();

            // Third phase: stop presenting entirely and measure this process again.
            var usage = presentingUsage.GetAwaiter().GetResult();
            var stoppedUsage = GpuUsageSampler.Sample(Environment.ProcessId, TimeSpan.FromSeconds(1));

            User32.ShowWindow(window, 0);
            User32.DestroyWindow(window);
            window = 0;
            DesktopHostAttachment.RepaintDesktop(target);
            PumpFor(TimeSpan.FromMilliseconds(400));
            var pixelAfter = reader.Read();

            return new VariantResult(variant, true, true, childOfParent, belowIcons, swapEffect.ToString(), null, frames, usage, stoppedUsage,
                JudgePixel(pixelDuring), pixelBefore, pixelDuring, pixelAfter);
        }
        catch (SharpGen.Runtime.SharpGenException exception)
        {
            logger.Error("engine.desktop", "hosting-poc.variant-failed", exception);
            return new VariantResult(variant, true, User32.GetParent(window) == target.Parent, User32.GetParent(window) == target.Parent, false,
                swapEffect.ToString(), $"{exception.GetType().Name}: {exception.Message}", 0, null, null, "skipped", pixelBefore, null, null);
        }
        finally
        {
            targetView?.Dispose();
            swapChain?.Dispose();
            context?.Dispose();
            device?.Dispose();
            adapter?.Dispose();
            factory?.Dispose();
            if (window != 0) User32.DestroyWindow(window);
            DesktopHostAttachment.RepaintDesktop(target);
        }
    }

    private static string JudgePixel(string? during)
    {
        if (during is null) return "skipped";
        var value = Convert.ToUInt32(during[1..], 16);
        var r = (int)((value >> 16) & 0xFF);
        var g = (int)((value >> 8) & 0xFF);
        var b = (int)(value & 0xFF);
        return Math.Abs(r - ProbeR) <= ColorTolerance && Math.Abs(g - ProbeG) <= ColorTolerance && Math.Abs(b - ProbeB) <= ColorTolerance
            ? "passed"
            : "failed";
    }

    private static nint CreateHostWindow(Rect bounds)
    {
        var instance = Kernel32.GetModuleHandle(null);
        if (Interlocked.Exchange(ref _classRegistered, 1) == 0)
        {
            fixed (char* name = WindowClassName)
            {
                var windowClass = new WindowClassEx
                {
                    Size = (uint)sizeof(WindowClassEx),
                    WndProc = &HostWindowProc,
                    Instance = instance,
                    ClassName = name,
                };
                User32.RegisterClassEx(&windowClass);
            }
        }

        return User32.CreateWindowEx(
            User32.WS_EX_TOOLWINDOW | User32.WS_EX_NOACTIVATE,
            WindowClassName, "Animated Walls Hosting Proof of Concept", User32.WS_POPUP,
            bounds.X, bounds.Y, bounds.Width, bounds.Height, 0, 0, instance, 0);
    }

    [UnmanagedCallersOnly]
    private static nint HostWindowProc(nint hwnd, uint message, nint wParam, nint lParam) =>
        User32.DefWindowProc(hwnd, message, wParam, lParam);

    /// <summary>GW_HWNDNEXT walk from the icon window: our window must be below it.</summary>
    private static bool IsBelowIcons(nint window, DesktopHostTarget target)
    {
        if (target.Layout != DesktopLayout.ProgmanChild) return User32.GetParent(window) == target.WorkerW;

        var child = (nint)0;
        var seenDefView = false;
        while ((child = User32.FindWindowEx(target.Progman, child, null, null)) != 0)
        {
            if (child == target.DefView) seenDefView = true;
            if (child == window) return seenDefView;
        }
        return false;
    }

    private static IDXGIAdapter1 FindAdapter(IDXGIFactory2 factory, GpuAdapter info)
    {
        for (uint index = 0; factory.EnumAdapters1(index, out var adapter).Success; index++)
        {
            var luid = adapter.Description1.Luid;
            if ($"{luid.HighPart:X8}{luid.LowPart:X8}" == info.Luid) return adapter;
            adapter.Dispose();
        }
        throw new InvalidOperationException($"Adapter {info.Name} is no longer available.");
    }

    private static void PumpMessages()
    {
        while (User32.PeekMessage(out var message, 0, 0, 0, User32.PM_REMOVE))
        {
            User32.TranslateMessage(message);
            User32.DispatchMessage(message);
        }
    }

    private static void PumpFor(TimeSpan duration)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.Elapsed < duration)
        {
            PumpMessages();
            Thread.Sleep(10);
        }
    }

    /// <summary>
    /// Reads what the desktop shows at one point, even when application windows cover it,
    /// so the check does not have to disturb what the user is doing. It asks DWM to draw a
    /// live thumbnail of Progman into a tiny topmost window, then reads that from the screen.
    /// </summary>
    internal sealed class DesktopPixelReader : IDisposable
    {
        private const int Size = 24;
        private const int Margin = 8;
        private const string ClassName = "AnimatedWallsPocProbe";
        private static int _registered;

        private readonly nint _window;
        private readonly nint _thumbnail;
        private readonly (int X, int Y) _screenPoint;

        public string Method { get; }

        public DesktopPixelReader(nint progman, (int X, int Y) samplePoint)
        {
            var instance = Kernel32.GetModuleHandle(null);
            if (Interlocked.Exchange(ref _registered, 1) == 0)
            {
                fixed (char* name = ClassName)
                {
                    var windowClass = new WindowClassEx { Size = (uint)sizeof(WindowClassEx), WndProc = &HostWindowProc, Instance = instance, ClassName = name };
                    User32.RegisterClassEx(&windowClass);
                }
            }

            _screenPoint = (Margin + Size / 2, Margin + Size / 2);
            _window = User32.CreateWindowEx(
                User32.WS_EX_TOPMOST | User32.WS_EX_TOOLWINDOW | User32.WS_EX_NOACTIVATE,
                ClassName, null, User32.WS_POPUP | User32.WS_VISIBLE,
                Margin, Margin, Size, Size, 0, 0, instance, 0);
            if (_window == 0)
            {
                Method = "unavailable: probe window could not be created";
                return;
            }

            var status = Dwmapi.DwmRegisterThumbnail(_window, progman, out _thumbnail);
            if (status != 0)
            {
                Method = $"unavailable: DwmRegisterThumbnail returned 0x{status:X8}";
                return;
            }

            var origin = new NativePoint { X = samplePoint.X, Y = samplePoint.Y };
            User32.ScreenToClient(progman, ref origin);
            var properties = new DwmThumbnailProperties
            {
                Flags = Dwmapi.DWM_TNP_RECTDESTINATION | Dwmapi.DWM_TNP_RECTSOURCE | Dwmapi.DWM_TNP_OPACITY | Dwmapi.DWM_TNP_VISIBLE,
                Destination = new NativeRect { Left = 0, Top = 0, Right = Size, Bottom = Size },
                Source = new NativeRect { Left = origin.X, Top = origin.Y, Right = origin.X + 4, Bottom = origin.Y + 4 },
                Opacity = 255,
                Visible = 1,
            };
            status = Dwmapi.DwmUpdateThumbnailProperties(_thumbnail, properties);
            Method = status == 0 ? "dwm-thumbnail" : $"unavailable: DwmUpdateThumbnailProperties returned 0x{status:X8}";
        }

        public string? Read()
        {
            if (Method != "dwm-thumbnail") return null;
            PumpMessages();
            // Two composition passes: one to pick up the source, one to draw the thumbnail.
            Dwmapi.DwmFlush();
            Dwmapi.DwmFlush();

            var dc = User32.GetDC(0);
            if (dc == 0) return null;
            try
            {
                var value = Gdi32.GetPixel(dc, _screenPoint.X, _screenPoint.Y);
                if (value == 0xFFFFFFFF) return null;
                // COLORREF is 0x00BBGGRR.
                return $"#{value & 0xFF:X2}{(value >> 8) & 0xFF:X2}{(value >> 16) & 0xFF:X2}";
            }
            finally
            {
                User32.ReleaseDC(0, dc);
            }
        }

        public void Dispose()
        {
            if (_thumbnail != 0) Dwmapi.DwmUnregisterThumbnail(_thumbnail);
            if (_window != 0) User32.DestroyWindow(_window);
        }
    }
}
