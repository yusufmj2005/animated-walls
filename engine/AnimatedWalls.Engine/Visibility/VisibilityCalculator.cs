using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Visibility;

/// <summary>An opaque window, listed topmost first.</summary>
public readonly record struct Occluder(Rect Bounds, string ClassName);

/// <summary>Turns a z-ordered list of opaque windows into per-display visibility.</summary>
public static class VisibilityCalculator
{
    /// <summary>
    /// Visible area below which a display counts as covered. This absorbs slivers
    /// nobody can see: an auto-hidden taskbar leaves a 2px strip, which is 0.19% of
    /// a 1080p display, and that must not keep a wallpaper rendering.
    /// </summary>
    public const double CoveredFraction = 0.0025;

    /// <summary>Above this, the display counts as fully visible.</summary>
    public const double VisibleFraction = 1.0 - CoveredFraction;

    private const int MaxReportedRects = 16;

    public static DisplayVisibility Evaluate(DisplayInfo display, IReadOnlyList<Occluder> occluders)
    {
        IReadOnlyList<Rect> remaining = [display.Bounds];
        string? topOccluder = null;

        foreach (var occluder in occluders)
        {
            if (occluder.Bounds.Intersect(display.Bounds).IsEmpty) continue;
            topOccluder ??= occluder.ClassName;
            remaining = Region.Subtract(remaining, occluder.Bounds);
            if (remaining.Count == 0) break;
        }

        var total = display.Bounds.Area;
        var fraction = total == 0 ? 0 : (double)Region.AreaOf(remaining) / total;
        var state = fraction <= CoveredFraction ? VisibilityStates.Covered
            : fraction >= VisibleFraction ? VisibilityStates.Visible
            : VisibilityStates.Partial;

        var rects = state == VisibilityStates.Covered
            ? []
            : remaining.OrderByDescending(rect => rect.Area).Take(MaxReportedRects).ToArray();

        return new DisplayVisibility(display.Id, state, Math.Round(fraction, 4), rects, topOccluder);
    }
}
