using AnimatedWalls.Engine.Core;
using Microsoft.Win32;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace AnimatedWalls.Engine.Rendering;

/// <summary>
/// Finds hardware that can render wallpapers. Nothing here may ever select WARP or
/// another software rasteriser: when no hardware adapter qualifies, the result is
/// "unsupported" and playback is blocked, which the UI reports to the user.
/// </summary>
public static class GpuCapabilityDetector
{
    private const int MicrosoftVendorId = 0x1414;
    private const int EInvalidArg = unchecked((int)0x80070057);
    private const string WebView2ClientKey = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    private static readonly FeatureLevel[] AcceptedFeatureLevels =
    [
        FeatureLevel.Level_12_2,
        FeatureLevel.Level_12_1,
        FeatureLevel.Level_12_0,
        FeatureLevel.Level_11_1,
        FeatureLevel.Level_11_0,
    ];

    // D3D11 decoder profile GUIDs from d3d11.h. Vortice exposes the profiles of a
    // device, but these are the identifiers that say what each one decodes.
    private static readonly (Guid Profile, string Codec)[] DecoderProfiles =
    [
        (new("1b81be68-a0c7-11d3-b984-00c04f2e73c5"), "h264"),
        (new("1b81be69-a0c7-11d3-b984-00c04f2e73c5"), "h264"),
        (new("5b11d51b-2f4c-4452-bcc3-09f2a1160cc0"), "hevc"),
        (new("107af0e0-ef1a-4d19-aba8-67a163073d13"), "hevc"),
        (new("90b899ea-3a62-4705-88b3-8df04b2744e7"), "vp8"),
        (new("463707f8-a1d0-4585-876d-83aa6d60b89e"), "vp9"),
        (new("a4c749ef-6ecf-48aa-8448-50a7a1165ff7"), "vp9"),
        (new("b8be4ccb-cf53-46ba-8d59-d6b8a6da5d2a"), "av1"),
    ];

    public static GpuCapabilities Detect()
    {
        var adapters = new List<GpuAdapter>();
        var reasons = new List<string>();

        using (var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>())
        {
            for (uint index = 0; factory.EnumAdapters1(index, out var adapter).Success; index++)
            {
                using (adapter)
                {
                    adapters.Add(Inspect(adapter));
                }
            }
        }

        var selected = SelectAdapter(adapters);
        if (selected is null)
        {
            reasons.Add(adapters.Count == 0
                ? "Windows reported no graphics adapters."
                : "No hardware graphics adapter supports Direct3D 11. Animated Walls does not use software rendering, so wallpaper playback is unavailable on this configuration.");
        }

        return new GpuCapabilities(
            selected is null ? "unsupported" : "supported",
            selected,
            adapters,
            reasons,
            ReadWebView2Version(),
            DateTimeOffset.UtcNow.ToString("O"));
    }

    /// <summary>
    /// Prefers an adapter that drives a display, because presenting from it avoids a
    /// cross-adapter copy, and then the one with the most dedicated memory.
    /// </summary>
    internal static GpuAdapter? SelectAdapter(IEnumerable<GpuAdapter> adapters) =>
        adapters
            .Where(adapter => adapter.RejectedReason is null)
            .OrderByDescending(adapter => adapter.ConnectedOutputs.Count > 0)
            .ThenByDescending(adapter => adapter.DedicatedVideoMemoryBytes)
            .FirstOrDefault();

    /// <summary>Why an adapter cannot render wallpapers, or null if it can.</summary>
    internal static string? RejectionReason(bool isSoftwareFlag, int vendorId, string? featureLevel, string? deviceError)
    {
        if (isSoftwareFlag) return "Software rasteriser";
        // Vendor 0x1414 covers Microsoft Basic Render, Basic Display and virtual GPUs.
        // None of these provide real hardware acceleration for this purpose.
        if (vendorId == MicrosoftVendorId) return "Microsoft software or virtual adapter";
        if (deviceError is not null) return $"Could not create a hardware Direct3D 11 device: {deviceError}";
        if (featureLevel is null) return "Direct3D feature level 11_0 is not available";
        return null;
    }

    private static GpuAdapter Inspect(IDXGIAdapter1 adapter)
    {
        var description = adapter.Description1;
        var isSoftware = (description.Flags & AdapterFlags.Software) != 0;
        var vendorId = (int)description.VendorId;

        string? featureLevel = null;
        string? deviceError = null;
        IReadOnlyList<string> codecs = [];

        // Probing a rejected adapter would be pointless, and for WARP it would load
        // the software rasteriser into this process.
        if (!isSoftware && vendorId != MicrosoftVendorId)
        {
            try
            {
                (featureLevel, codecs) = ProbeDevice(adapter);
            }
            catch (SharpGen.Runtime.SharpGenException exception)
            {
                deviceError = exception.Message;
            }
        }

        return new GpuAdapter(
            description.Description.TrimEnd('\0'),
            vendorId,
            (int)description.DeviceId,
            $"{description.Luid.HighPart:X8}{description.Luid.LowPart:X8}",
            (long)(ulong)description.DedicatedVideoMemory,
            isSoftware,
            featureLevel,
            codecs,
            ReadOutputs(adapter),
            RejectionReason(isSoftware, vendorId, featureLevel, deviceError));
    }

    private static (string FeatureLevel, IReadOnlyList<string> Codecs) ProbeDevice(IDXGIAdapter1 adapter)
    {
        // A GPU with no video decode block must still qualify for image and web wallpapers,
        // so a failure with video support is retried without it.
        var created = TryCreateHardwareDevice(adapter, DeviceCreationFlags.VideoSupport | DeviceCreationFlags.BgraSupport, out var device, out var context, out var level);
        if (created.Failure)
        {
            created = TryCreateHardwareDevice(adapter, DeviceCreationFlags.BgraSupport, out device, out context, out level);
        }
        created.CheckError();

        using (device)
        using (context)
        {
            return (FormatFeatureLevel(level), ReadDecodeCodecs(device!));
        }
    }

    /// <summary>
    /// DriverType.Unknown with an explicit adapter pins the device to that hardware. There is
    /// deliberately no retry with DriverType.Warp.
    /// </summary>
    private static SharpGen.Runtime.Result TryCreateHardwareDevice(
        IDXGIAdapter1 adapter,
        DeviceCreationFlags flags,
        out ID3D11Device? device,
        out ID3D11DeviceContext? context,
        out FeatureLevel level)
    {
        // Windows rejects the whole request with E_INVALIDARG if it does not recognise a level
        // in the list, as older Windows 10 builds do with 12_2. That says nothing about the
        // GPU, so the newest level is dropped and the request made again.
        SharpGen.Runtime.Result result = default;
        device = null;
        context = null;
        level = default;
        for (var first = 0; first < AcceptedFeatureLevels.Length; first++)
        {
            result = D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, flags, AcceptedFeatureLevels[first..], out device, out level, out context);
            if (result.Code != EInvalidArg) return result;
        }
        return result;
    }

    private static List<string> ReadDecodeCodecs(ID3D11Device device)
    {
        var codecs = new HashSet<string>(StringComparer.Ordinal);
        using var video = device.QueryInterfaceOrNull<ID3D11VideoDevice>();
        if (video is null) return [];

        var count = video.VideoDecoderProfileCount;
        for (uint index = 0; index < count; index++)
        {
            var profile = video.GetVideoDecoderProfile(index);
            foreach (var known in DecoderProfiles)
            {
                if (known.Profile == profile) codecs.Add(known.Codec);
            }
        }
        return [.. codecs.Order(StringComparer.Ordinal)];
    }

    private static List<string> ReadOutputs(IDXGIAdapter1 adapter)
    {
        var outputs = new List<string>();
        for (uint index = 0; adapter.EnumOutputs(index, out var output).Success; index++)
        {
            using (output)
            {
                outputs.Add(output.Description.DeviceName.TrimEnd('\0'));
            }
        }
        return outputs;
    }

    private static string FormatFeatureLevel(FeatureLevel level) => level switch
    {
        FeatureLevel.Level_12_2 => "12_2",
        FeatureLevel.Level_12_1 => "12_1",
        FeatureLevel.Level_12_0 => "12_0",
        FeatureLevel.Level_11_1 => "11_1",
        FeatureLevel.Level_11_0 => "11_0",
        _ => level.ToString(),
    };

    private static string? ReadWebView2Version()
    {
        // Per Microsoft's distribution guidance: machine-wide under WOW6432Node, or per-user.
        string?[] candidates =
        [
            Registry.GetValue($@"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\{WebView2ClientKey}", "pv", null) as string,
            Registry.GetValue($@"HKEY_CURRENT_USER\Software\{WebView2ClientKey}", "pv", null) as string,
        ];
        return candidates.FirstOrDefault(version => !string.IsNullOrEmpty(version) && version != "0.0.0.0");
    }
}
