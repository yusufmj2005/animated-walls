using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Visibility;
using Xunit;

namespace AnimatedWalls.Engine.Tests;

public class VisibilityCalculatorTests
{
    private static readonly DisplayInfo Primary = Display("primary", 0, 0, 1920, 1080);
    private static readonly DisplayInfo Secondary = Display("secondary", 1920, 0, 2560, 1440);

    private static DisplayInfo Display(string id, int x, int y, int width, int height) =>
        new(id, $@"\\.\{id}", id, new Rect(x, y, width, height), new Rect(x, y, width, height - 48), 60, 96, 100, 32, x == 0);

    private static Occluder Window(string className, int x, int y, int width, int height) => new(new Rect(x, y, width, height), className);

    private static readonly Occluder Taskbar = Window("Shell_TrayWnd", 0, 1032, 1920, 48);

    [Fact]
    public void Desktop_with_no_windows_is_visible()
    {
        var result = VisibilityCalculator.Evaluate(Primary, []);
        Assert.Equal(VisibilityStates.Visible, result.State);
        Assert.Equal(1.0, result.VisibleFraction);
        Assert.Equal(Primary.Bounds, Assert.Single(result.VisibleRects));
    }

    [Fact]
    public void Maximised_browser_and_taskbar_cover_the_display()
    {
        var result = VisibilityCalculator.Evaluate(Primary, [Window("Chrome_WidgetWin_1", 0, 0, 1920, 1032), Taskbar]);
        Assert.Equal(VisibilityStates.Covered, result.State);
        Assert.Equal(0, result.VisibleFraction);
        Assert.Empty(result.VisibleRects);
        Assert.Equal("Chrome_WidgetWin_1", result.TopOccluderClass);
    }

    [Fact]
    public void Notepad_resized_to_fill_the_screen_covers_it_without_being_maximised()
    {
        // The reason detection cannot rely on fullscreen or maximised state.
        var result = VisibilityCalculator.Evaluate(Primary, [Window("Notepad", 0, 0, 1920, 1080)]);
        Assert.Equal(VisibilityStates.Covered, result.State);
    }

    [Fact]
    public void Two_snapped_windows_cover_the_display_together()
    {
        var result = VisibilityCalculator.Evaluate(Primary, [Window("A", 0, 0, 960, 1032), Window("B", 960, 0, 960, 1032), Taskbar]);
        Assert.Equal(VisibilityStates.Covered, result.State);
    }

    [Fact]
    public void Partly_covered_display_reports_the_visible_regions()
    {
        var result = VisibilityCalculator.Evaluate(Primary, [Window("Notepad", 0, 0, 960, 1080)]);
        Assert.Equal(VisibilityStates.Partial, result.State);
        Assert.Equal(0.5, result.VisibleFraction);
        Assert.Equal(new Rect(960, 0, 960, 1080), Assert.Single(result.VisibleRects));
    }

    [Fact]
    public void A_window_in_the_middle_leaves_four_visible_regions_summing_correctly()
    {
        var result = VisibilityCalculator.Evaluate(Primary, [Window("Notepad", 480, 270, 960, 540)]);
        Assert.Equal(VisibilityStates.Partial, result.State);
        Assert.Equal(4, result.VisibleRects.Count);
        Assert.Equal(Primary.Bounds.Area - 960L * 540, result.VisibleRects.Sum(rect => rect.Area));
    }

    [Fact]
    public void Auto_hidden_taskbar_sliver_does_not_keep_the_wallpaper_rendering()
    {
        var result = VisibilityCalculator.Evaluate(Primary, [Window("Browser", 0, 0, 1920, 1078)]);
        Assert.Equal(VisibilityStates.Covered, result.State);
    }

    [Fact]
    public void Monitors_are_evaluated_independently()
    {
        Occluder[] windows = [Window("Game", 0, 0, 1920, 1080)];
        Assert.Equal(VisibilityStates.Covered, VisibilityCalculator.Evaluate(Primary, windows).State);
        var second = VisibilityCalculator.Evaluate(Secondary, windows);
        Assert.Equal(VisibilityStates.Visible, second.State);
        Assert.Null(second.TopOccluderClass);
    }

    [Fact]
    public void A_window_spanning_two_monitors_affects_both()
    {
        Occluder[] windows = [Window("Span", 960, 0, 1920, 1080)];
        Assert.Equal(0.5, VisibilityCalculator.Evaluate(Primary, windows).VisibleFraction);
        Assert.Equal(VisibilityStates.Partial, VisibilityCalculator.Evaluate(Secondary, windows).State);
    }

    [Fact]
    public void Monitors_left_of_the_primary_with_negative_coordinates_work()
    {
        var left = Display("left", -1920, 0, 1920, 1080);
        Assert.Equal(VisibilityStates.Covered, VisibilityCalculator.Evaluate(left, [Window("W", -1920, 0, 1920, 1080)]).State);
        Assert.Equal(VisibilityStates.Visible, VisibilityCalculator.Evaluate(left, [Window("W", 0, 0, 1920, 1080)]).State);
    }

    [Fact]
    public void Removing_the_covering_window_makes_the_display_visible_again()
    {
        Assert.Equal(VisibilityStates.Covered, VisibilityCalculator.Evaluate(Primary, [Window("W", 0, 0, 1920, 1080)]).State);
        Assert.Equal(VisibilityStates.Visible, VisibilityCalculator.Evaluate(Primary, []).State);
    }
}

public class RegionTests
{
    [Fact]
    public void Subtracting_a_rectangle_that_misses_changes_nothing()
    {
        var result = Region.Subtract([new Rect(0, 0, 10, 10)], new Rect(20, 20, 5, 5));
        Assert.Equal(new Rect(0, 0, 10, 10), Assert.Single(result));
    }

    [Fact]
    public void Subtracting_everything_leaves_nothing()
    {
        Assert.Empty(Region.Subtract([new Rect(0, 0, 10, 10)], new Rect(-5, -5, 100, 100)));
    }

    [Theory]
    [InlineData(0, 0, 5, 5, 75)]
    [InlineData(5, 5, 10, 10, 75)]
    [InlineData(2, 2, 6, 6, 64)]
    [InlineData(0, 0, 10, 5, 50)]
    public void The_remaining_area_is_exact(int x, int y, int width, int height, long expected)
    {
        var result = Region.Subtract([new Rect(0, 0, 10, 10)], new Rect(x, y, width, height));
        Assert.Equal(expected, Region.AreaOf(result));
    }

    [Fact]
    public void Results_never_overlap()
    {
        IReadOnlyList<Rect> region = [new Rect(0, 0, 100, 100)];
        region = Region.Subtract(region, new Rect(10, 10, 30, 30));
        region = Region.Subtract(region, new Rect(25, 25, 50, 50));
        for (var a = 0; a < region.Count; a++)
        {
            for (var b = a + 1; b < region.Count; b++)
            {
                Assert.True(region[a].Intersect(region[b]).IsEmpty);
            }
        }
    }
}

public class WindowClassifierTests
{
    private static readonly Rect Full = new(0, 0, 1920, 1080);

    private static WindowProperties Window(
        string className = "Chrome_WidgetWin_1",
        bool visible = true,
        bool minimized = false,
        bool cloaked = false,
        uint exStyle = 0,
        bool hasLayered = false,
        byte alpha = 255,
        uint layeredFlags = 0,
        bool complexRegion = false,
        bool hostsIcons = false,
        Rect? bounds = null) =>
        new(className, bounds ?? Full, visible, minimized, cloaked, exStyle, hasLayered, alpha, layeredFlags, complexRegion, hostsIcons);

    [Fact] public void An_ordinary_window_occludes() => Assert.True(WindowClassifier.IsOccluder(Window()));
    [Fact] public void A_hidden_window_does_not_occlude() => Assert.False(WindowClassifier.IsOccluder(Window(visible: false)));
    [Fact] public void A_minimised_window_does_not_occlude() => Assert.False(WindowClassifier.IsOccluder(Window(minimized: true)));
    [Fact] public void A_window_on_another_virtual_desktop_does_not_occlude() => Assert.False(WindowClassifier.IsOccluder(Window(cloaked: true)));
    [Fact] public void A_zero_size_window_does_not_occlude() => Assert.False(WindowClassifier.IsOccluder(Window(bounds: new Rect(0, 0, 0, 0))));

    [Fact]
    public void A_click_through_overlay_does_not_occlude() =>
        Assert.False(WindowClassifier.IsOccluder(Window(exStyle: User32.WS_EX_TRANSPARENT | User32.WS_EX_LAYERED | User32.WS_EX_TOPMOST)));

    [Fact]
    public void A_browser_without_a_redirection_surface_still_occludes() =>
        Assert.True(WindowClassifier.IsOccluder(Window(exStyle: User32.WS_EX_NOREDIRECTIONBITMAP)));

    [Fact]
    public void A_translucent_layered_window_does_not_occlude() =>
        Assert.False(WindowClassifier.IsOccluder(Window(exStyle: User32.WS_EX_LAYERED, hasLayered: true, alpha: 200, layeredFlags: User32.LWA_ALPHA)));

    [Fact]
    public void A_fully_opaque_layered_window_occludes() =>
        Assert.True(WindowClassifier.IsOccluder(Window(exStyle: User32.WS_EX_LAYERED, hasLayered: true, alpha: 255, layeredFlags: User32.LWA_ALPHA)));

    [Fact]
    public void A_per_pixel_alpha_window_does_not_occlude() =>
        Assert.False(WindowClassifier.IsOccluder(Window(exStyle: User32.WS_EX_LAYERED, hasLayered: false)));

    [Fact]
    public void A_colour_keyed_window_does_not_occlude() =>
        Assert.False(WindowClassifier.IsOccluder(Window(exStyle: User32.WS_EX_LAYERED, hasLayered: true, layeredFlags: User32.LWA_COLORKEY)));

    [Fact] public void A_shaped_window_does_not_occlude() => Assert.False(WindowClassifier.IsOccluder(Window(complexRegion: true)));

    [Theory]
    [InlineData("Windows.UI.Core.CoreWindow")]
    [InlineData("XamlExplorerHostIslandWindow")]
    [InlineData("#32768")]
    public void Shell_flyouts_do_not_occlude(string className) => Assert.False(WindowClassifier.IsOccluder(Window(className)));

    [Fact] public void The_taskbar_occludes() => Assert.True(WindowClassifier.IsOccluder(Window("Shell_TrayWnd")));

    [Fact] public void Progman_ends_the_walk() => Assert.True(WindowClassifier.IsDesktopLayer(Window("Progman")));

    [Fact]
    public void The_WorkerW_holding_the_icons_ends_the_walk() =>
        Assert.True(WindowClassifier.IsDesktopLayer(Window("WorkerW", hostsIcons: true)));

    [Fact]
    public void A_hidden_WorkerW_does_not_end_the_walk()
    {
        // Found on Windows 11 build 26300: 16 hidden WorkerW windows sit above Progman,
        // with real application windows between them.
        Assert.False(WindowClassifier.IsDesktopLayer(Window("WorkerW", visible: false)));
    }

    [Fact]
    public void A_visible_WorkerW_without_icons_does_not_end_the_walk() =>
        Assert.False(WindowClassifier.IsDesktopLayer(Window("WorkerW")));
}
