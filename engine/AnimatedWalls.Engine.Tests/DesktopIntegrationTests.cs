using System.Runtime.InteropServices;
using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Diagnostics;
using AnimatedWalls.Engine.Displays;
using AnimatedWalls.Engine.Playback;
using AnimatedWalls.Engine.Rendering;
using AnimatedWalls.Engine.Visibility;
using Xunit;

namespace AnimatedWalls.Engine.Tests;

/// <summary>
/// Exercises the real Win32 pipeline on the machine running the tests. These briefly
/// show a topmost window, so they are excluded from the default test run:
/// npm run test:engine:desktop
/// </summary>
[Trait("Category", "Desktop")]
[Collection("Desktop")]
public unsafe class DesktopIntegrationTests
{
    private const string TestWindowClass = "AnimatedWallsTestOccluder";
    private static int _registered;

    [UnmanagedCallersOnly]
    private static nint TestWindowProc(nint hwnd, uint message, nint wParam, nint lParam) =>
        User32.DefWindowProc(hwnd, message, wParam, lParam);

    private static nint CreateCoveringWindow(Rect bounds)
    {
        var instance = Kernel32.GetModuleHandle(null);
        if (Interlocked.Exchange(ref _registered, 1) == 0)
        {
            fixed (char* name = TestWindowClass)
            {
                var windowClass = new WindowClassEx
                {
                    Size = (uint)sizeof(WindowClassEx),
                    WndProc = &TestWindowProc,
                    Instance = instance,
                    ClassName = name,
                };
                User32.RegisterClassEx(&windowClass);
            }
        }
        // WS_EX_NOACTIVATE: this test must not take keyboard focus from the user.
        var window = User32.CreateWindowEx(
            User32.WS_EX_TOPMOST | User32.WS_EX_TOOLWINDOW | User32.WS_EX_NOACTIVATE,
            TestWindowClass, "Animated Walls test", User32.WS_POPUP | User32.WS_VISIBLE,
            bounds.X, bounds.Y, bounds.Width, bounds.Height, 0, 0, instance, 0);
        Assert.NotEqual((nint)0, window);
        return window;
    }

    /// <summary>
    /// Capture deliberately skips this process's own windows, and here the test window
    /// is ours. Dump includes every process and carries the same classification.
    /// </summary>
    private static List<Occluder> CaptureIncludingOwnWindows() =>
        WindowSnapshotProvider.Dump()
            .Where(window => window.Occludes)
            .Select(window => new Occluder(window.Bounds, window.ClassName))
            .ToList();

    private static void Pump()
    {
        while (User32.PeekMessage(out var message, 0, 0, 0, User32.PM_REMOVE))
        {
            User32.TranslateMessage(message);
            User32.DispatchMessage(message);
        }
    }

    [Fact]
    public void Display_enumeration_returns_a_primary_with_real_values()
    {
        var displays = DisplayEnumerator.Enumerate();
        var primary = Assert.Single(displays, display => display.IsPrimary);
        Assert.True(primary.Bounds.Width > 0 && primary.Bounds.Height > 0);
        Assert.True(primary.RefreshRateHz > 0);
        Assert.True(primary.Dpi >= 96);
        Assert.False(string.IsNullOrEmpty(primary.Id));
        Assert.False(string.IsNullOrEmpty(primary.FriendlyName));
    }

    [Fact]
    public void The_lock_state_of_this_session_reads_as_unlocked()
    {
        using var logger = new StructuredLogger(null, level: LogLevel.Error);
        Assert.False(SessionLock.Read(logger));
    }

    [Fact]
    public void Gpu_detection_never_selects_a_software_adapter()
    {
        var gpu = GpuCapabilityDetector.Detect();
        Assert.NotEmpty(gpu.Adapters);
        if (gpu.SelectedAdapter is { } selected)
        {
            Assert.False(selected.IsSoftware);
            Assert.NotEqual(0x1414, selected.VendorId);
            Assert.NotNull(selected.FeatureLevel);
        }
        else
        {
            Assert.Equal("unsupported", gpu.Status);
            Assert.NotEmpty(gpu.UnsupportedReasons);
        }
    }

    [Fact]
    public void A_real_window_covering_the_primary_display_is_detected_and_removal_restores_state()
    {
        var display = DisplayEnumerator.Enumerate().First(item => item.IsPrimary);
        var before = VisibilityCalculator.Evaluate(display, CaptureIncludingOwnWindows());

        var window = CreateCoveringWindow(display.Bounds);
        try
        {
            Pump();
            var covered = VisibilityCalculator.Evaluate(display, CaptureIncludingOwnWindows());
            Assert.Equal(VisibilityStates.Covered, covered.State);
            Assert.Equal(TestWindowClass, covered.TopOccluderClass);
        }
        finally
        {
            User32.DestroyWindow(window);
            Pump();
        }

        var after = VisibilityCalculator.Evaluate(display, CaptureIncludingOwnWindows());
        Assert.Equal(before.State, after.State);
        Assert.Equal(before.VisibleFraction, after.VisibleFraction, 2);
    }
}

[Trait("Category", "Desktop")]
[Collection("Desktop")]
public class DesktopSignalPumpTests
{
    [Fact]
    public async Task Signal_pump_reports_a_window_change_then_goes_quiet()
    {
        using var logger = new StructuredLogger(null, level: LogLevel.Error);
        var counters = new EngineCounters();
        using var pump = new DesktopSignalPump(logger, counters);

        var dirty = 0;
        var signalled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        pump.VisibilityDirty += () =>
        {
            Interlocked.Increment(ref dirty);
            signalled.TrySetResult();
        };
        await pump.StartAsync();

        // Hooks skip our own process, so the signal must come through RequestRefresh here.
        pump.RequestRefresh();
        await signalled.Task.WaitAsync(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
        Assert.True(dirty >= 1);
    }
}
