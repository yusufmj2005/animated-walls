using System.Runtime.InteropServices;

namespace AnimatedWalls.Engine.Core;

[StructLayout(LayoutKind.Sequential)]
internal struct NativeRect
{
    public int Left, Top, Right, Bottom;
    public readonly Rect ToRect() => Rect.FromEdges(Left, Top, Right, Bottom);
}

[StructLayout(LayoutKind.Sequential)]
internal struct NativePoint
{
    public int X, Y;
}

[StructLayout(LayoutKind.Sequential)]
internal struct NativeMessage
{
    public nint Hwnd;
    public uint Message;
    public nint WParam;
    public nint LParam;
    public uint Time;
    public NativePoint Point;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct WindowClassEx
{
    public uint Size;
    public uint Style;
    public delegate* unmanaged<nint, uint, nint, nint, nint> WndProc;
    public int ClassExtra;
    public int WindowExtra;
    public nint Instance;
    public nint Icon;
    public nint Cursor;
    public nint Background;
    public char* MenuName;
    public char* ClassName;
    public nint IconSmall;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct MonitorInfoEx
{
    public uint Size;
    public NativeRect Monitor;
    public NativeRect Work;
    public uint Flags;
    public fixed char Device[32];
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct DevMode
{
    public fixed char DeviceName[32];
    public ushort SpecVersion, DriverVersion, Size, DriverExtra;
    public uint Fields;
    public int PositionX, PositionY;
    public uint DisplayOrientation, DisplayFixedOutput;
    public short Color, Duplex, YResolution, TTOption, Collate;
    public fixed char FormName[32];
    public ushort LogPixels;
    public uint BitsPerPel, PelsWidth, PelsHeight, DisplayFlags, DisplayFrequency;
    public uint IcmMethod, IcmIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
}

[StructLayout(LayoutKind.Sequential)]
internal struct SystemPowerStatus
{
    public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag;
    public uint BatteryLifeTime, BatteryFullLifeTime;
}

[StructLayout(LayoutKind.Sequential)]
internal struct Luid
{
    public uint LowPart;
    public int HighPart;
}

// QueryDisplayConfig structures. Layouts follow wingdi.h; the mode array is opaque
// because this code only needs the paths to identify each monitor.
[StructLayout(LayoutKind.Sequential, Size = 72)]
internal struct DisplayConfigPathInfo
{
    public Luid SourceAdapterId;
    public uint SourceId;
    public uint SourceModeInfoIdx;
    public uint SourceStatusFlags;
    public Luid TargetAdapterId;
    public uint TargetId;
}

[StructLayout(LayoutKind.Sequential, Size = 64)]
internal struct DisplayConfigModeInfo
{
    public uint InfoType;
}

[StructLayout(LayoutKind.Sequential)]
internal struct DisplayConfigDeviceInfoHeader
{
    public uint Type;
    public uint Size;
    public Luid AdapterId;
    public uint Id;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct DisplayConfigSourceDeviceName
{
    public DisplayConfigDeviceInfoHeader Header;
    public fixed char ViewGdiDeviceName[32];
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct DisplayConfigTargetDeviceName
{
    public DisplayConfigDeviceInfoHeader Header;
    public uint Flags;
    public uint OutputTechnology;
    public ushort EdidManufactureId;
    public ushort EdidProductCodeId;
    public uint ConnectorInstance;
    public fixed char MonitorFriendlyDeviceName[64];
    public fixed char MonitorDevicePath[128];
}

[StructLayout(LayoutKind.Sequential)]
internal struct PowerBroadcastSetting
{
    public Guid PowerSetting;
    public uint DataLength;
    public byte Data;
}

internal static unsafe partial class User32
{
    private const string Dll = "user32.dll";

    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const uint WS_POPUP = 0x80000000;
    public const uint WS_CHILD = 0x40000000;
    public const uint WS_VISIBLE = 0x10000000;
    public const uint WS_CLIPSIBLINGS = 0x04000000;
    public const uint WS_EX_TRANSPARENT = 0x00000020;
    public const uint WS_EX_TOOLWINDOW = 0x00000080;
    public const uint WS_EX_LAYERED = 0x00080000;
    public const uint WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
    public const uint WS_EX_NOACTIVATE = 0x08000000;
    public const uint WS_EX_TOPMOST = 0x00000008;
    public const uint LWA_COLORKEY = 0x1;
    public const uint LWA_ALPHA = 0x2;
    public const uint GA_ROOT = 2;
    public const uint SMTO_NORMAL = 0;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint RDW_INVALIDATE = 0x0001;
    public const uint RDW_ERASE = 0x0004;
    public const uint RDW_ALLCHILDREN = 0x0080;
    public const uint RDW_UPDATENOW = 0x0100;
    public const uint WINEVENT_OUTOFCONTEXT = 0;
    public const uint WINEVENT_SKIPOWNPROCESS = 2;
    public const uint MONITORINFOF_PRIMARY = 1;
    public const uint MONITOR_DEFAULTTONULL = 0;
    public const int ENUM_CURRENT_SETTINGS = -1;
    public const uint PM_REMOVE = 1;

    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool EnumWindows(delegate* unmanaged<nint, nint, int> callback, nint state);

    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool EnumChildWindows(nint parent, delegate* unmanaged<nint, nint, int> callback, nint state);

    [LibraryImport(Dll, EntryPoint = "GetClassNameW")]
    public static partial int GetClassName(nint hwnd, char* buffer, int capacity);

    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool IsWindow(nint hwnd);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool IsWindowVisible(nint hwnd);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool IsIconic(nint hwnd);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool GetWindowRect(nint hwnd, out NativeRect rect);
    [LibraryImport(Dll, EntryPoint = "GetWindowLongPtrW")] public static partial nint GetWindowLongPtr(nint hwnd, int index);
    [LibraryImport(Dll, EntryPoint = "SetWindowLongPtrW")] public static partial nint SetWindowLongPtr(nint hwnd, int index, nint value);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool GetLayeredWindowAttributes(nint hwnd, out uint key, out byte alpha, out uint flags);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool SetLayeredWindowAttributes(nint hwnd, uint key, byte alpha, uint flags);
    [LibraryImport(Dll)] public static partial int GetWindowRgn(nint hwnd, nint region);
    [LibraryImport(Dll)] public static partial nint GetAncestor(nint hwnd, uint flags);
    [LibraryImport(Dll)] public static partial nint GetParent(nint hwnd);
    [LibraryImport(Dll)] public static partial uint GetWindowThreadProcessId(nint hwnd, out uint processId);
    [LibraryImport(Dll)] public static partial nint GetForegroundWindow();
    [LibraryImport(Dll, EntryPoint = "FindWindowW", StringMarshalling = StringMarshalling.Utf16)] public static partial nint FindWindow(string? className, string? windowName);
    [LibraryImport(Dll, EntryPoint = "FindWindowExW", StringMarshalling = StringMarshalling.Utf16)] public static partial nint FindWindowEx(nint parent, nint childAfter, string? className, string? windowName);
    [LibraryImport(Dll, EntryPoint = "SendMessageTimeoutW")] public static partial nint SendMessageTimeout(nint hwnd, uint message, nint wParam, nint lParam, uint flags, uint timeoutMs, out nint result);
    [LibraryImport(Dll)] public static partial nint SetParent(nint child, nint parent);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool SetWindowPos(nint hwnd, nint insertAfter, int x, int y, int width, int height, uint flags);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool ShowWindow(nint hwnd, int command);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool ScreenToClient(nint hwnd, ref NativePoint point);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool RedrawWindow(nint hwnd, nint rect, nint region, uint flags);

    [LibraryImport(Dll)]
    public static partial nint SetWinEventHook(uint eventMin, uint eventMax, nint module, delegate* unmanaged<nint, uint, nint, int, int, uint, uint, void> callback, uint processId, uint threadId, uint flags);

    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool UnhookWinEvent(nint hook);

    [LibraryImport(Dll, EntryPoint = "RegisterClassExW")] public static partial ushort RegisterClassEx(WindowClassEx* windowClass);
    [LibraryImport(Dll, EntryPoint = "CreateWindowExW", StringMarshalling = StringMarshalling.Utf16)]
    public static partial nint CreateWindowEx(uint exStyle, string className, string? windowName, uint style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint param);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool DestroyWindow(nint hwnd);
    [LibraryImport(Dll, EntryPoint = "DefWindowProcW")] public static partial nint DefWindowProc(nint hwnd, uint message, nint wParam, nint lParam);
    [LibraryImport(Dll, EntryPoint = "GetMessageW")] public static partial int GetMessage(out NativeMessage message, nint hwnd, uint min, uint max);
    [LibraryImport(Dll, EntryPoint = "PeekMessageW")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool PeekMessage(out NativeMessage message, nint hwnd, uint min, uint max, uint remove);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool TranslateMessage(in NativeMessage message);
    [LibraryImport(Dll, EntryPoint = "DispatchMessageW")] public static partial nint DispatchMessage(in NativeMessage message);
    [LibraryImport(Dll, EntryPoint = "PostMessageW")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool PostMessage(nint hwnd, uint message, nint wParam, nint lParam);
    [LibraryImport(Dll)] public static partial void PostQuitMessage(int exitCode);
    [LibraryImport(Dll)] public static partial nuint SetTimer(nint hwnd, nuint id, uint elapseMs, nint callback);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool KillTimer(nint hwnd, nuint id);
    [LibraryImport(Dll, EntryPoint = "RegisterWindowMessageW", StringMarshalling = StringMarshalling.Utf16)] public static partial uint RegisterWindowMessage(string name);
    [LibraryImport(Dll)] public static partial nint RegisterPowerSettingNotification(nint recipient, in Guid setting, uint flags);
    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool UnregisterPowerSettingNotification(nint handle);

    [LibraryImport(Dll)] [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool EnumDisplayMonitors(nint hdc, nint clip, delegate* unmanaged<nint, nint, NativeRect*, nint, int> callback, nint state);
    [LibraryImport(Dll, EntryPoint = "GetMonitorInfoW")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool GetMonitorInfo(nint monitor, MonitorInfoEx* info);
    [LibraryImport(Dll)] public static partial nint MonitorFromWindow(nint hwnd, uint flags);
    [LibraryImport(Dll, EntryPoint = "EnumDisplaySettingsW", StringMarshalling = StringMarshalling.Utf16)] [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool EnumDisplaySettings(string device, int mode, DevMode* devMode);
    [LibraryImport(Dll)] public static partial int GetDisplayConfigBufferSizes(uint flags, out uint pathCount, out uint modeCount);
    [LibraryImport(Dll)] public static partial int QueryDisplayConfig(uint flags, ref uint pathCount, DisplayConfigPathInfo* paths, ref uint modeCount, DisplayConfigModeInfo* modes, nint topology);
    [LibraryImport(Dll)] public static partial int DisplayConfigGetDeviceInfo(void* packet);

    public const uint INFINITE = 0xFFFFFFFF;
    public const uint QS_ALLINPUT = 0x04FF;
    public const uint MWMO_INPUTAVAILABLE = 0x0004;

    [LibraryImport(Dll)]
    public static partial uint MsgWaitForMultipleObjectsEx(uint count, in nint handle, uint timeoutMs, uint wakeMask, uint flags);

    public const uint SPI_GETSCREENSAVERRUNNING = 0x0072;

    [LibraryImport(Dll, EntryPoint = "SystemParametersInfoW")] [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool SystemParametersInfo(uint action, uint param, out int value, uint flags);

    [LibraryImport(Dll)] public static partial nint GetDC(nint hwnd);
    [LibraryImport(Dll)] public static partial int ReleaseDC(nint hwnd, nint hdc);

    public static string ClassNameOf(nint hwnd)
    {
        var buffer = stackalloc char[256];
        var length = GetClassName(hwnd, buffer, 256);
        return length > 0 ? new string(buffer, 0, length) : string.Empty;
    }
}

internal static partial class Gdi32
{
    [LibraryImport("gdi32.dll")] public static partial nint CreateRectRgn(int left, int top, int right, int bottom);
    [LibraryImport("gdi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool DeleteObject(nint handle);
    [LibraryImport("gdi32.dll")] public static partial uint GetPixel(nint hdc, int x, int y);
}

// dwmapi.h declares this inside pshpack1, so the packing is part of the contract.
[StructLayout(LayoutKind.Sequential, Pack = 1)]
internal struct DwmThumbnailProperties
{
    public uint Flags;
    public NativeRect Destination;
    public NativeRect Source;
    public byte Opacity;
    public int Visible;
    public int SourceClientAreaOnly;
}

internal static partial class Dwmapi
{
    public const uint DWM_TNP_RECTDESTINATION = 0x1;
    public const uint DWM_TNP_RECTSOURCE = 0x2;
    public const uint DWM_TNP_OPACITY = 0x4;
    public const uint DWM_TNP_VISIBLE = 0x8;

    [LibraryImport("dwmapi.dll")] public static partial int DwmRegisterThumbnail(nint destination, nint source, out nint thumbnail);
    [LibraryImport("dwmapi.dll")] public static partial int DwmUnregisterThumbnail(nint thumbnail);
    [LibraryImport("dwmapi.dll")] public static partial int DwmUpdateThumbnailProperties(nint thumbnail, in DwmThumbnailProperties properties);
    [LibraryImport("dwmapi.dll")] public static partial int DwmFlush();

    public const uint DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const uint DWMWA_CLOAKED = 14;

    [LibraryImport("dwmapi.dll")] public static partial int DwmGetWindowAttribute(nint hwnd, uint attribute, out NativeRect value, uint size);
    [LibraryImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] public static partial int DwmGetWindowAttributeInt(nint hwnd, uint attribute, out int value, uint size);
}

internal static partial class Shcore
{
    [LibraryImport("shcore.dll")] public static partial int GetDpiForMonitor(nint monitor, int dpiType, out uint dpiX, out uint dpiY);
}

internal static partial class Shell32
{
    public const int QUNS_RUNNING_D3D_FULL_SCREEN = 3;

    [LibraryImport("shell32.dll")] public static partial int SHQueryUserNotificationState(out int state);
}

internal static partial class Wtsapi32
{
    public const uint NOTIFY_FOR_THIS_SESSION = 0;
    public const uint WTS_CURRENT_SESSION = 0xFFFFFFFF;
    public const int WTSSessionInfoEx = 25;
    public const int WTS_SESSIONSTATE_LOCK = 0;
    public const int WTSDisconnected = 4;

    [LibraryImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW")] [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool WTSQuerySessionInformation(nint server, uint sessionId, int infoClass, out nint buffer, out uint bytes);
    [LibraryImport("wtsapi32.dll")] public static partial void WTSFreeMemory(nint memory);

    [LibraryImport("wtsapi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool WTSRegisterSessionNotification(nint hwnd, uint flags);
    [LibraryImport("wtsapi32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool WTSUnRegisterSessionNotification(nint hwnd);
}

internal static partial class Kernel32
{
    public const int ATTACH_PARENT_PROCESS = -1;

    [LibraryImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool AttachConsole(int processId);
    [LibraryImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static partial bool GetSystemPowerStatus(out SystemPowerStatus status);
    [LibraryImport("kernel32.dll", EntryPoint = "GetModuleHandleW", StringMarshalling = StringMarshalling.Utf16)] public static partial nint GetModuleHandle(string? name);
}

internal static partial class Ole32
{
    public const uint CLSCTX_INPROC_SERVER = 1;

    [LibraryImport("ole32.dll")]
    private static partial int CoCreateInstance(in Guid clsid, nint outer, uint context, in Guid iid, out nint instance);

    public static SharpGen.Runtime.Result CoCreateInstance(Guid clsid, int outer, uint context, Guid iid, out nint instance) =>
        CoCreateInstance(in clsid, outer, context, in iid, out instance);
}

internal static unsafe partial class Pdh
{
    public const uint PDH_FMT_DOUBLE = 0x00000200;
    public const uint PDH_FMT_NOCAP100 = 0x00008000;
    public const int PDH_MORE_DATA = unchecked((int)0x800007D2);
    public const int PDH_NO_DATA = unchecked((int)0x800007D5);
    public const int PDH_CSTATUS_NO_INSTANCE = unchecked((int)0x800007D1);
    public const int PDH_CSTATUS_INVALID_DATA = unchecked((int)0xC0000BC6);

    [LibraryImport("pdh.dll", EntryPoint = "PdhOpenQueryW", StringMarshalling = StringMarshalling.Utf16)] public static partial int PdhOpenQuery(string? dataSource, nint userData, out nint query);
    [LibraryImport("pdh.dll", EntryPoint = "PdhAddEnglishCounterW", StringMarshalling = StringMarshalling.Utf16)] public static partial int PdhAddEnglishCounter(nint query, string path, nint userData, out nint counter);
    [LibraryImport("pdh.dll")] public static partial int PdhCollectQueryData(nint query);
    [LibraryImport("pdh.dll", EntryPoint = "PdhGetFormattedCounterArrayW")] public static partial int PdhGetFormattedCounterArray(nint counter, uint format, ref uint bufferSize, out uint itemCount, void* buffer);
    [LibraryImport("pdh.dll")] public static partial int PdhCloseQuery(nint query);
}
