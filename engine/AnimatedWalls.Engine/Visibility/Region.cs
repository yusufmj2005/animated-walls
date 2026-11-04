using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Visibility;

/// <summary>
/// Rectangle-list region arithmetic. GDI regions would also work, but pure managed
/// arithmetic lets every occlusion scenario run as an ordinary unit test.
/// </summary>
public static class Region
{
    /// <summary>Removes <paramref name="cut"/> from a list of non-overlapping rectangles.</summary>
    public static List<Rect> Subtract(IReadOnlyList<Rect> region, Rect cut)
    {
        var result = new List<Rect>(region.Count + 3);
        foreach (var rect in region)
        {
            var overlap = rect.Intersect(cut);
            if (overlap.IsEmpty)
            {
                result.Add(rect);
                continue;
            }

            // Split what remains into up to four bands around the overlap.
            if (overlap.Y > rect.Y)
                result.Add(Rect.FromEdges(rect.X, rect.Y, rect.Right, overlap.Y));
            if (overlap.Bottom < rect.Bottom)
                result.Add(Rect.FromEdges(rect.X, overlap.Bottom, rect.Right, rect.Bottom));
            if (overlap.X > rect.X)
                result.Add(Rect.FromEdges(rect.X, overlap.Y, overlap.X, overlap.Bottom));
            if (overlap.Right < rect.Right)
                result.Add(Rect.FromEdges(overlap.Right, overlap.Y, rect.Right, overlap.Bottom));
        }
        return result;
    }

    public static long AreaOf(IEnumerable<Rect> region) => region.Sum(rect => rect.Area);
}
