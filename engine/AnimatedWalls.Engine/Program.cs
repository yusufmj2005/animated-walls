using System.Text.Json;
using AnimatedWalls.Engine.Core;
using AnimatedWalls.Engine.Desktop;
using AnimatedWalls.Engine.Diagnostics;
using AnimatedWalls.Engine.Displays;
using AnimatedWalls.Engine.IPC;
using AnimatedWalls.Engine.Rendering;
using AnimatedWalls.Engine.Visibility;

namespace AnimatedWalls.Engine;

public static class Program
{
    private const int ExitOk = 0;
    private const int ExitUsage = 2;
    private const int ExitNoToken = 3;
    private const int ExitFailed = 1;

    private const string Usage = """
        Animated Walls Engine

        Service mode (started by the desktop app, with the session token on stdin):
          --pipe <name> [--log-dir <dir>] [--log-level debug|info|warn|error]

        Standalone commands:
          --version                 Print the engine version.
          --diagnose                Print GPU, display, visibility and hosting findings as JSON.
          --hosting-poc [--seconds <n>] [--variant auto|child-flip|layered-blt]
                                    Run the desktop hosting proof of concept and print a JSON
                                    report. It briefly draws solid colours behind your icons.
        """;

    public static async Task<int> Main(string[] args)
    {
        var options = ParseArguments(args);
        if (options is null)
        {
            AttachParentConsole();
            Console.Error.WriteLine(Usage);
            return ExitUsage;
        }

        if (options.ContainsKey("version"))
        {
            AttachParentConsole();
            Console.Out.WriteLine(EngineInfo.Version);
            return ExitOk;
        }

        if (options.ContainsKey("diagnose"))
        {
            AttachParentConsole();
            return RunDiagnose();
        }

        if (options.ContainsKey("hosting-poc"))
        {
            AttachParentConsole();
            return RunHostingPoc(options);
        }

        if (!options.TryGetValue("pipe", out var pipeName) || string.IsNullOrWhiteSpace(pipeName))
        {
            AttachParentConsole();
            Console.Error.WriteLine(Usage);
            return ExitUsage;
        }

        return await RunServiceAsync(pipeName, options).ConfigureAwait(false);
    }

    private static async Task<int> RunServiceAsync(string pipeName, Dictionary<string, string?> options)
    {
        options.TryGetValue("log-dir", out var logDirectory);
        options.TryGetValue("log-level", out var logLevelText);
        StructuredLogger.TryParseLevel(logLevelText, out var logLevel);

        using var logger = new StructuredLogger(logDirectory, level: logLevel);

        var stdin = Console.OpenStandardInput();
        var token = await ReadTokenAsync(stdin).ConfigureAwait(false);
        if (token is null)
        {
            logger.Error("engine.host", "engine.no-token");
            Console.Error.WriteLine("The session token was not provided on stdin.");
            return ExitNoToken;
        }

        try
        {
            using var host = new EngineHost(pipeName, stdin, logger);
            return await host.RunAsync(token).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            logger.Error("engine.host", "engine.fatal", exception);
            Console.Error.WriteLine($"Fatal: {exception.GetType().Name}: {exception.Message}");
            return ExitFailed;
        }
    }

    private static int RunDiagnose()
    {
        try
        {
            var gpu = GpuCapabilityDetector.Detect();
            var displays = DisplayEnumerator.Enumerate();
            var occluders = WindowSnapshotProvider.Capture();
            var report = new DiagnoseReport(
                EngineInfo.Version,
                gpu,
                displays,
                displays.Select(display => VisibilityCalculator.Evaluate(display, occluders)).ToArray(),
                WindowSnapshotProvider.Dump(),
                DesktopHostLocator.Probe());
            WriteIndented(report, ProtocolJson.Default.DiagnoseReport);
            return ExitOk;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Diagnose failed: {exception.GetType().Name}: {exception.Message}");
            return ExitFailed;
        }
    }

    private static int RunHostingPoc(Dictionary<string, string?> options)
    {
        var seconds = options.TryGetValue("seconds", out var secondsText) && int.TryParse(secondsText, out var parsed) ? Math.Clamp(parsed, 1, 60) : 4;
        var variant = options.TryGetValue("variant", out var variantText) && !string.IsNullOrEmpty(variantText) ? variantText : "auto";
        if (variant is not ("auto" or "child-flip" or "layered-blt"))
        {
            Console.Error.WriteLine(Usage);
            return ExitUsage;
        }

        using var logger = new StructuredLogger(null, level: LogLevel.Warn);
        try
        {
            var report = HostingProofOfConcept.Run(new HostingProofOfConcept.PocOptions(seconds, variant), logger);
            WriteIndented(report, ProtocolJson.Default.PocReport);
            return ExitOk;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Hosting proof of concept failed: {exception.GetType().Name}: {exception.Message}");
            return ExitFailed;
        }
    }

    private static void WriteIndented<T>(T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type)
    {
        using var document = JsonSerializer.SerializeToDocument(value, type);
        using var stream = Console.OpenStandardOutput();
        using var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true });
        document.WriteTo(writer);
        writer.Flush();
    }

    /// <summary>Reads one line byte by byte so nothing past the token is consumed from stdin.</summary>
    private static async Task<byte[]?> ReadTokenAsync(Stream stdin)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var line = new List<byte>(64);
        var single = new byte[1];
        try
        {
            while (line.Count < 256)
            {
                var read = await stdin.ReadAsync(single, timeout.Token).ConfigureAwait(false);
                if (read == 0) return null;
                if (single[0] == (byte)'\n') break;
                if (single[0] != (byte)'\r') line.Add(single[0]);
            }
        }
        catch (OperationCanceledException)
        {
            return null;
        }
        return line.Count == 0 ? null : line.ToArray();
    }

    private static Dictionary<string, string?>? ParseArguments(string[] args)
    {
        var options = new Dictionary<string, string?>(StringComparer.Ordinal);
        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            if (!arg.StartsWith("--", StringComparison.Ordinal)) return null;
            var key = arg[2..];
            if (index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                options[key] = args[++index];
            }
            else
            {
                options[key] = null;
            }
        }
        return options;
    }

    /// <summary>
    /// The engine is a WinExe so it never flashes a console. Standalone commands attach
    /// to the parent's console when run from a terminal, so their output is visible there.
    /// </summary>
    private static void AttachParentConsole()
    {
        if (!Console.IsOutputRedirected) return;
        Kernel32.AttachConsole(Kernel32.ATTACH_PARENT_PROCESS);
    }
}
