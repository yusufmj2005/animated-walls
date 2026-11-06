using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Rendering;

/// <summary>
/// Decides from measurements whether a playing video is really being decoded on the GPU. Windows
/// picks the decoder, and for a stream the hardware cannot handle it may quietly use a software
/// one. Asking the decoder would only say what it intends, so this measures what happened.
/// </summary>
public static class HardwareDecodeCheck
{
    public enum Outcome
    {
        /// <summary>The GPU's video engine was busy while frames were being decoded.</summary>
        Hardware,
        /// <summary>Frames were decoded while the GPU's video engine sat idle.</summary>
        SoftwareSuspected,
        /// <summary>The measurement cannot say either way.</summary>
        Inconclusive,
    }

    /// <summary>Few frames in a sample say nothing, as a short gap in decoding could explain them.</summary>
    public const long MinimumFrames = 10;

    public static Outcome Evaluate(GpuProcessUsage usage, long framesDecodedDuringSample)
    {
        // Machines where the counters are off must not lose playback over it.
        if (!usage.Available) return Outcome.Inconclusive;
        if (framesDecodedDuringSample < MinimumFrames) return Outcome.Inconclusive;
        return usage.VideoDecodePercent > 0 ? Outcome.Hardware : Outcome.SoftwareSuspected;
    }

    /// <summary>
    /// The decoder's codec from the first four bytes of its media subtype GUID, which is a FOURCC.
    /// Returns null for a format this does not recognise.
    /// </summary>
    public static string? CodecFromSubtype(Guid subtype)
    {
        Span<byte> bytes = stackalloc byte[16];
        subtype.TryWriteBytes(bytes);
        var fourCc = System.Text.Encoding.ASCII.GetString(bytes[..4]);
        return fourCc.ToUpperInvariant() switch
        {
            "H264" or "AVC1" => "h264",
            "HEVC" or "H265" or "HVC1" => "hevc",
            "VP80" => "vp8",
            "VP90" => "vp9",
            "AV01" => "av1",
            _ => null,
        };
    }
}
