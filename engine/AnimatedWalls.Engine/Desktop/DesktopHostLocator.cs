using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Desktop;

/// <summary>Where a wallpaper window can be parented so it draws behind the desktop icons.</summary>
public enum DesktopLayout
{
    Unavailable,
    /// <summary>
    /// Classic layout (Windows 10, Windows 11 before 24H2): the icons live in one
    /// top-level WorkerW, and a second, empty WorkerW behind it hosts the wallpaper.
    /// </summary>
    WorkerWSibling,
    /// <summary>
    /// Windows 11 24H2 and later: Progman owns SHELLDLL_DefView directly as a layered
    /// child, Progman has WS_EX_NOREDIRECTIONBITMAP, and the spawned WorkerW is a child
    /// of Progman rather than a top-level sibling.
    /// </summary>
    ProgmanChild,
}

public readonly record struct DesktopHostTarget(DesktopLayout Layout, nint Progman, nint DefView, nint WorkerW)
{
    /// <summary>Window to parent the wallpaper to.</summary>
    public nint Parent => Layout == DesktopLayout.ProgmanChild ? Progman : WorkerW;
}

/// <summary>
/// Finds the shell windows behind the desktop icons. These are undocumented Explorer
/// internals, so layouts are detected from what is really there rather than from the
/// Windows version, and an unrecognised shape reports as unavailable.
/// </summary>
public static unsafe class DesktopHostLocator
{
    /// <summary>
    /// Undocumented message that tells Progman to create the WorkerW behind the icons.
    /// It has been stable since Windows 8, and it is what every wallpaper host relies on.
    /// </summary>
    private const uint WM_SPAWN_WORKER = 0x052C;

    private const uint SpawnTimeoutMs = 1000;

    /// <summary>Reads the current layout without changing anything.</summary>
    public static DesktopHostProbe Probe()
    {
        var progman = User32.FindWindow("Progman", null);
        if (progman == 0)
        {
            return new DesktopHostProbe("unavailable", false, null, false, false, false, "Progman was not found. Explorer may not be running, or a replacement shell is in use.");
        }

        var (defView, parent) = FindDefView(progman);
        var progmanEx = (uint)(long)User32.GetWindowLongPtr(progman, User32.GWL_EXSTYLE);
        var noRedirection = (progmanEx & User32.WS_EX_NOREDIRECTIONBITMAP) != 0;
        var defViewLayered = defView != 0 && ((uint)(long)User32.GetWindowLongPtr(defView, User32.GWL_EXSTYLE) & User32.WS_EX_LAYERED) != 0;
        var layout = ClassifyLayout(defView != 0, parent == progman);
        var hasHost = layout == DesktopLayout.ProgmanChild
            ? User32.FindWindowEx(progman, 0, "WorkerW", null) != 0
            : layout == DesktopLayout.WorkerWSibling && FindEmptyWorkerW() != 0;

        var layoutName = layout switch
        {
            DesktopLayout.ProgmanChild => "progman-child",
            DesktopLayout.WorkerWSibling => "workerw-sibling",
            _ => "unavailable",
        };
        var notes = layout switch
        {
            DesktopLayout.ProgmanChild => "Icons are hosted directly by Progman (Windows 11 24H2 or later layout).",
            DesktopLayout.WorkerWSibling => "Icons are hosted by a WorkerW (classic layout).",
            _ => "The desktop icon window was not found.",
        };

        return new DesktopHostProbe(layoutName, true, parent != 0 ? User32.ClassNameOf(parent) : null, noRedirection, defViewLayered, hasHost, notes);
    }

    internal static DesktopLayout ClassifyLayout(bool defViewFound, bool defViewIsChildOfProgman)
    {
        if (!defViewFound) return DesktopLayout.Unavailable;
        return defViewIsChildOfProgman ? DesktopLayout.ProgmanChild : DesktopLayout.WorkerWSibling;
    }

    /// <summary>Asks Explorer for its wallpaper host window, then locates it.</summary>
    public static DesktopHostTarget Locate()
    {
        var progman = User32.FindWindow("Progman", null);
        if (progman == 0) return new DesktopHostTarget(DesktopLayout.Unavailable, 0, 0, 0);

        // (0xD, 1) is the form that also works on current Windows 11; (0, 0) is the
        // classic form and is kept for older builds that ignore the newer parameters.
        User32.SendMessageTimeout(progman, WM_SPAWN_WORKER, 0xD, 1, User32.SMTO_NORMAL, SpawnTimeoutMs, out _);
        User32.SendMessageTimeout(progman, WM_SPAWN_WORKER, 0, 0, User32.SMTO_NORMAL, SpawnTimeoutMs, out _);

        var (defView, parent) = FindDefView(progman);
        var layout = ClassifyLayout(defView != 0, parent == progman);
        var worker = layout switch
        {
            DesktopLayout.ProgmanChild => User32.FindWindowEx(progman, 0, "WorkerW", null),
            DesktopLayout.WorkerWSibling => FindEmptyWorkerW(),
            _ => 0,
        };
        return new DesktopHostTarget(layout, progman, defView, worker);
    }

    private static (nint DefView, nint Parent) FindDefView(nint progman)
    {
        var direct = User32.FindWindowEx(progman, 0, "SHELLDLL_DefView", null);
        if (direct != 0) return (direct, progman);

        var worker = (nint)0;
        while ((worker = User32.FindWindowEx(0, worker, "WorkerW", null)) != 0)
        {
            var view = User32.FindWindowEx(worker, 0, "SHELLDLL_DefView", null);
            if (view != 0) return (view, worker);
        }
        return (0, 0);
    }

    /// <summary>In the classic layout, the host is the WorkerW after the one holding the icons.</summary>
    private static nint FindEmptyWorkerW()
    {
        var worker = (nint)0;
        while ((worker = User32.FindWindowEx(0, worker, "WorkerW", null)) != 0)
        {
            if (User32.FindWindowEx(worker, 0, "SHELLDLL_DefView", null) != 0)
            {
                return User32.FindWindowEx(0, worker, "WorkerW", null);
            }
        }
        return 0;
    }
}
