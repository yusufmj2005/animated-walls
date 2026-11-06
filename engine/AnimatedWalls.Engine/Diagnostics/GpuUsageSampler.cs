using System.Runtime.InteropServices;
using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Diagnostics;

/// <summary>
/// Measures GPU engine use for one process through the "GPU Engine" performance
/// counters, the same source Task Manager uses. Scoping to a PID is what makes the
/// numbers honest: the Windows compositor keeps using the GPU while wallpapers are
/// suspended, and that work is not ours to claim or to deny.
/// </summary>
public static unsafe class GpuUsageSampler
{
    [StructLayout(LayoutKind.Sequential)]
    private struct CounterValueItem
    {
        public char* Name;
        public uint Status;
        public double Value;
    }

    public static GpuProcessUsage Sample(int processId, TimeSpan window)
    {
        var path = $@"\GPU Engine(pid_{processId}_*)\Utilization Percentage";

        var status = Pdh.PdhOpenQuery(null, 0, out var query);
        if (status != 0) return Failed("PdhOpenQuery", status);
        try
        {
            status = Pdh.PdhAddEnglishCounter(query, path, 0, out var counter);
            if (status == Pdh.PDH_CSTATUS_NO_INSTANCE)
            {
                // No instance means this process has not touched the GPU at all.
                return new GpuProcessUsage(true, 0, 0, null);
            }
            if (status != 0) return Failed("PdhAddEnglishCounter", status);

            // Utilisation is a rate, so it needs two samples with time in between.
            status = Pdh.PdhCollectQueryData(query);
            if (status != 0 && status != Pdh.PDH_NO_DATA) return Failed("PdhCollectQueryData", status);

            Thread.Sleep(window);

            status = Pdh.PdhCollectQueryData(query);
            if (status != 0 && status != Pdh.PDH_NO_DATA) return Failed("PdhCollectQueryData", status);

            return ReadValues(counter);
        }
        finally
        {
            var closeStatus = Pdh.PdhCloseQuery(query);
            if (closeStatus != 0)
            {
                Console.Error.WriteLine($"[gpu-usage] PdhCloseQuery failed: 0x{closeStatus:X8}");
            }
        }
    }

    private static GpuProcessUsage ReadValues(nint counter)
    {
        const uint format = Pdh.PDH_FMT_DOUBLE | Pdh.PDH_FMT_NOCAP100;

        uint size = 0;
        var status = Pdh.PdhGetFormattedCounterArray(counter, format, ref size, out _, null);
        if (status == Pdh.PDH_NO_DATA || status == Pdh.PDH_CSTATUS_NO_INSTANCE || status == Pdh.PDH_CSTATUS_INVALID_DATA)
        {
            return new GpuProcessUsage(true, 0, 0, null);
        }
        if (status != Pdh.PDH_MORE_DATA) return Failed("PdhGetFormattedCounterArray", status);

        var buffer = new byte[size];
        fixed (byte* pointer = buffer)
        {
            status = Pdh.PdhGetFormattedCounterArray(counter, format, ref size, out var count, pointer);
            if (status != 0) return Failed("PdhGetFormattedCounterArray", status);

            double engine3D = 0;
            double decode = 0;
            var items = (CounterValueItem*)pointer;
            for (var index = 0; index < count; index++)
            {
                // Status 0 and 1 are PDH's valid-data codes. A process exiting mid-sample leaves
                // instances with an error status, and their value means nothing.
                if (items[index].Status > 1) continue;
                var name = new string(items[index].Name);
                var value = items[index].Value;
                if (name.EndsWith("engtype_3D", StringComparison.OrdinalIgnoreCase)) engine3D += value;
                // NVIDIA and Intel call it VideoDecode, while AMD's shared block is VideoCodec.
                else if (name.EndsWith("engtype_VideoDecode", StringComparison.OrdinalIgnoreCase)
                    || name.EndsWith("engtype_VideoCodec", StringComparison.OrdinalIgnoreCase)) decode += value;
            }
            return new GpuProcessUsage(true, Math.Round(engine3D, 2), Math.Round(decode, 2), null);
        }
    }

    private static GpuProcessUsage Failed(string call, int status) =>
        new(false, 0, 0, $"{call} failed with 0x{status:X8}");
}
