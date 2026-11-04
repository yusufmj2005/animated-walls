using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Diagnostics;
using AnimatedWalls.Engine.Playback;
using AnimatedWalls.Engine.Rendering;
using Xunit;

namespace AnimatedWalls.Engine.Tests;

/// <summary>One test per row of the product's visibility behaviour table.</summary>
public class RenderPolicyTests
{
    private static readonly SessionState Normal = new(false, DisplayPowerStates.On, false, false, false);

    private static (string Decision, string Reason) Decide(
        string visibility = VisibilityStates.Visible,
        SessionState? session = null,
        string? wallpaper = "w1",
        bool gpu = true,
        bool paused = false,
        bool pauseOnBattery = true,
        bool exclusive = false) =>
        RenderPolicy.Decide(new RenderPolicy.Inputs(wallpaper, visibility, session ?? Normal, exclusive, gpu, paused, pauseOnBattery));

    [Fact]
    public void Desktop_visible_renders() =>
        Assert.Equal((RenderDecisions.Render, RenderReasons.DesktopVisible), Decide());

    [Fact]
    public void Covered_by_a_browser_or_notepad_suspends() =>
        Assert.Equal((RenderDecisions.Suspended, RenderReasons.DesktopCovered), Decide(VisibilityStates.Covered));

    [Fact]
    public void Exclusive_fullscreen_game_suspends_its_display() =>
        Assert.Equal((RenderDecisions.Suspended, RenderReasons.ExclusiveFullscreen), Decide(exclusive: true));

    [Fact]
    public void Exclusive_fullscreen_on_another_display_leaves_this_one_rendering() =>
        Assert.Equal(RenderDecisions.Render, Decide(session: Normal with { ExclusiveFullscreen = true }, exclusive: false).Decision);

    [Fact]
    public void Partially_visible_renders() =>
        Assert.Equal((RenderDecisions.Render, RenderReasons.PartiallyVisible), Decide(VisibilityStates.Partial));

    [Fact]
    public void Locked_screen_suspends_even_if_the_desktop_looks_visible() =>
        Assert.Equal((RenderDecisions.Suspended, RenderReasons.SessionLocked), Decide(session: Normal with { Locked = true }));

    [Fact]
    public void Display_off_suspends() =>
        Assert.Equal((RenderDecisions.Suspended, RenderReasons.DisplayOff), Decide(session: Normal with { DisplayPower = DisplayPowerStates.Off }));

    [Fact]
    public void A_dimmed_display_keeps_rendering() =>
        Assert.Equal(RenderDecisions.Render, Decide(session: Normal with { DisplayPower = DisplayPowerStates.Dimmed }).Decision);

    [Fact]
    public void System_sleep_suspends() =>
        Assert.Equal((RenderDecisions.Suspended, RenderReasons.SystemSuspended), Decide(session: Normal with { SystemSuspended = true }));

    [Fact]
    public void Minimising_the_covering_app_resumes_because_visibility_returns() =>
        Assert.Equal(RenderDecisions.Render, Decide(VisibilityStates.Visible).Decision);

    [Fact]
    public void No_gpu_blocks_and_never_renders() =>
        Assert.Equal((RenderDecisions.Blocked, RenderReasons.GpuUnsupported), Decide(gpu: false));

    [Fact]
    public void No_gpu_blocks_even_when_covered_so_the_problem_stays_reported() =>
        Assert.Equal(RenderDecisions.Blocked, Decide(VisibilityStates.Covered, gpu: false).Decision);

    [Fact]
    public void No_assignment_is_idle() =>
        Assert.Equal((RenderDecisions.Idle, RenderReasons.NoWallpaperAssigned), Decide(wallpaper: null));

    [Fact]
    public void User_pause_suspends() =>
        Assert.Equal((RenderDecisions.Suspended, RenderReasons.UserPaused), Decide(paused: true));

    [Fact]
    public void Battery_suspends_when_the_setting_is_on() =>
        Assert.Equal((RenderDecisions.Suspended, RenderReasons.OnBattery), Decide(session: Normal with { OnBattery = true }));

    [Fact]
    public void Battery_renders_when_the_setting_is_off() =>
        Assert.Equal(RenderDecisions.Render, Decide(session: Normal with { OnBattery = true }, pauseOnBattery: false).Decision);
}

public class GpuPolicyTests
{
    private static GpuAdapter Adapter(string name, string? rejected, long memory = 0, string[]? outputs = null) =>
        new(name, 0x10DE, 1, "0", memory, false, "12_1", [], outputs ?? [], rejected);

    [Fact]
    public void The_software_flag_is_rejected() =>
        Assert.NotNull(GpuCapabilityDetector.RejectionReason(true, 0x10DE, "12_1", null));

    [Fact]
    public void Microsoft_basic_render_is_rejected_even_without_the_software_flag() =>
        Assert.NotNull(GpuCapabilityDetector.RejectionReason(false, 0x1414, "12_1", null));

    [Fact]
    public void A_device_creation_failure_is_rejected() =>
        Assert.NotNull(GpuCapabilityDetector.RejectionReason(false, 0x10DE, null, "E_FAIL"));

    [Fact]
    public void A_missing_feature_level_is_rejected() =>
        Assert.NotNull(GpuCapabilityDetector.RejectionReason(false, 0x10DE, null, null));

    [Fact]
    public void Real_hardware_is_accepted() =>
        Assert.Null(GpuCapabilityDetector.RejectionReason(false, 0x10DE, "12_1", null));

    [Fact]
    public void Rejected_adapters_are_never_selected() =>
        Assert.Null(GpuCapabilityDetector.SelectAdapter([Adapter("WARP", "Software rasteriser", 999)]));

    [Fact]
    public void An_adapter_driving_a_display_beats_one_with_more_memory()
    {
        var driving = Adapter("Integrated", null, 1, [@"\\.\DISPLAY1"]);
        var headless = Adapter("Discrete", null, 1000);
        Assert.Equal("Integrated", GpuCapabilityDetector.SelectAdapter([headless, driving])!.Name);
    }

    [Fact]
    public void More_memory_wins_between_equals()
    {
        var small = Adapter("Small", null, 1);
        var large = Adapter("Large", null, 1000);
        Assert.Equal("Large", GpuCapabilityDetector.SelectAdapter([small, large])!.Name);
    }
}

public class PlaybackCoordinatorTests
{
    private static readonly GpuCapabilities Supported = new("supported", null, [], [], null, "now");
    private static readonly GpuCapabilities Unsupported = new("unsupported", null, [], ["none"], null, "now");
    private static readonly DisplayInfo Display = new("d1", @"\\.\D1", "d1", new Rect(0, 0, 1920, 1080), new Rect(0, 0, 1920, 1032), 60, 96, 100, 32, true);

    private static (PlaybackCoordinator Coordinator, EngineCounters Counters, List<EngineState> Events) Create(GpuCapabilities? gpu = null)
    {
        var counters = new EngineCounters();
        var coordinator = new PlaybackCoordinator(new StructuredLogger(null, level: LogLevel.Error), counters, gpu ?? Supported);
        var events = new List<EngineState>();
        coordinator.StateChanged += events.Add;
        coordinator.UpdateDisplays([Display]);
        coordinator.SetAssignments([new DisplayAssignment("d1", "w1")]);
        return (coordinator, counters, events);
    }

    private static DisplayVisibility Vis(string state, double fraction) => new("d1", state, fraction, [], null);

    [Fact]
    public void Covering_and_uncovering_transitions_between_suspended_and_render()
    {
        var (coordinator, _, _) = Create();
        coordinator.UpdateVisibility([Vis(VisibilityStates.Visible, 1)]);
        Assert.Equal(RenderDecisions.Render, coordinator.Current.Render[0].Decision);

        coordinator.UpdateVisibility([Vis(VisibilityStates.Covered, 0)]);
        Assert.Equal(RenderDecisions.Suspended, coordinator.Current.Render[0].Decision);
        Assert.Equal(RenderReasons.DesktopCovered, coordinator.Current.Render[0].Reason);

        coordinator.UpdateVisibility([Vis(VisibilityStates.Visible, 1)]);
        Assert.Equal(RenderDecisions.Render, coordinator.Current.Render[0].Decision);
    }

    [Fact]
    public void Dragging_a_window_does_not_flood_the_client()
    {
        var (coordinator, _, events) = Create();
        coordinator.UpdateVisibility([Vis(VisibilityStates.Partial, 0.500)]);
        events.Clear();

        // Small moves within the same state, as a window drag produces.
        for (var step = 0; step < 20; step++)
        {
            coordinator.UpdateVisibility([Vis(VisibilityStates.Partial, 0.500 + step * 0.001)]);
        }
        Assert.Empty(events);
    }

    [Fact]
    public void A_transition_is_counted_once_and_repeats_are_not()
    {
        var (coordinator, counters, _) = Create();
        coordinator.UpdateVisibility([Vis(VisibilityStates.Covered, 0)]);
        var after = counters.Snapshot().RenderTransitions;
        coordinator.UpdateVisibility([Vis(VisibilityStates.Covered, 0)]);
        coordinator.UpdateVisibility([Vis(VisibilityStates.Covered, 0)]);
        Assert.Equal(after, counters.Snapshot().RenderTransitions);
    }

    [Fact]
    public void Without_gpu_support_an_assigned_display_is_blocked()
    {
        var (coordinator, _, _) = Create(Unsupported);
        Assert.Equal(RenderDecisions.Blocked, coordinator.Current.Render[0].Decision);
    }

    [Fact]
    public void Unplugging_a_display_removes_its_state()
    {
        var (coordinator, _, _) = Create();
        coordinator.UpdateDisplays([]);
        Assert.Empty(coordinator.Current.Render);
    }

    [Fact]
    public void Pausing_and_resuming_is_reported()
    {
        var (coordinator, _, _) = Create();
        Assert.Equal(RenderDecisions.Suspended, coordinator.SetPaused(true).Render[0].Decision);
        Assert.Equal(RenderDecisions.Render, coordinator.SetPaused(false).Render[0].Decision);
    }
}
