using System.Runtime.InteropServices;
using AnimatedWalls.Engine.Core;

namespace AnimatedWalls.Engine.Desktop;

/// <summary>Places a window behind the desktop icons. Shared by the renderer and the proof of concept.</summary>
internal static class DesktopHostAttachment
{
    public static bool Attach(nint window, DesktopHostTarget target, Rect bounds, bool layered, out string? error)
    {
        error = null;

        // Becoming a real child must happen before SetParent, or Windows treats the
        // window as an owned popup and it can float above the icons.
        var style = (User32.GetWindowLongPtr(window, User32.GWL_STYLE) & ~(nint)unchecked((int)User32.WS_POPUP)) | (nint)User32.WS_CHILD | (nint)User32.WS_CLIPSIBLINGS;
        User32.SetWindowLongPtr(window, User32.GWL_STYLE, style);

        if (layered)
        {
            var exStyle = User32.GetWindowLongPtr(window, User32.GWL_EXSTYLE) | (nint)User32.WS_EX_LAYERED;
            User32.SetWindowLongPtr(window, User32.GWL_EXSTYLE, exStyle);
            User32.SetLayeredWindowAttributes(window, 0, 255, User32.LWA_ALPHA);
        }

        if (User32.SetParent(window, target.Parent) == 0 && Marshal.GetLastPInvokeError() != 0)
        {
            error = $"SetParent failed with error {Marshal.GetLastPInvokeError()}.";
            return false;
        }

        // Child coordinates are relative to the parent, whose origin is the virtual
        // screen's top-left, so negative monitor positions need this conversion.
        var origin = new NativePoint { X = bounds.X, Y = bounds.Y };
        User32.ScreenToClient(target.Parent, ref origin);

        // In the Progman layout the wallpaper must sit directly under SHELLDLL_DefView.
        var insertAfter = target.Layout == DesktopLayout.ProgmanChild ? target.DefView : 0;
        var flags = User32.SWP_NOACTIVATE | User32.SWP_SHOWWINDOW | (insertAfter == 0 ? User32.SWP_NOZORDER : 0);
        if (!User32.SetWindowPos(window, insertAfter, origin.X, origin.Y, bounds.Width, bounds.Height, flags))
        {
            error = $"SetWindowPos failed with error {Marshal.GetLastPInvokeError()}.";
            return false;
        }
        return true;
    }

    /// <summary>Makes the desktop redraw whatever a removed window was covering.</summary>
    public static void RepaintDesktop(DesktopHostTarget target)
    {
        const uint flags = User32.RDW_INVALIDATE | User32.RDW_ERASE | User32.RDW_ALLCHILDREN | User32.RDW_UPDATENOW;
        if (target.Parent != 0) User32.RedrawWindow(target.Parent, 0, 0, flags);
        if (target.Progman != 0) User32.RedrawWindow(target.Progman, 0, 0, flags);
    }
}

/// <summary>
/// The window a wallpaper draws into. It belongs to the thread that creates it, and that thread
/// must keep pumping messages: a child window shares an input queue with its parent, so an
/// unpumped one can hang Explorer.
/// </summary>
internal sealed unsafe class DesktopHostWindow : IDisposable
{
    private const string ClassName = "AnimatedWallsWallpaper";
    private const uint WM_ERASEBKGND = 0x0014;
    private const uint WM_NCHITTEST = 0x0084;
    private const nint HTTRANSPARENT = -1;

    private static int _classRegistered;

    private readonly DesktopHostTarget _target;

    public nint Handle { get; private set; }

    /// <summary>False once Explorer has gone and taken this window with it.</summary>
    public bool IsAlive => Handle != 0 && User32.IsWindow(Handle);

    public DesktopHostWindow(Rect bounds)
    {
        _target = DesktopHostLocator.Locate();
        if (_target.Layout == DesktopLayout.Unavailable || _target.Parent == 0)
        {
            throw new InvalidOperationException("The desktop host window could not be found. Explorer may not be running, or a replacement shell is in use.");
        }

        var instance = Kernel32.GetModuleHandle(null);
        if (Interlocked.Exchange(ref _classRegistered, 1) == 0)
        {
            fixed (char* name = ClassName)
            {
                var windowClass = new WindowClassEx { Size = (uint)sizeof(WindowClassEx), WndProc = &WindowProc, Instance = instance, ClassName = name };
                if (User32.RegisterClassEx(&windowClass) == 0)
                {
                    throw new InvalidOperationException($"RegisterClassEx failed with error {Marshal.GetLastPInvokeError()}.");
                }
            }
        }

        Handle = User32.CreateWindowEx(
            User32.WS_EX_TOOLWINDOW | User32.WS_EX_NOACTIVATE,
            ClassName, "Animated Walls Wallpaper", User32.WS_POPUP,
            bounds.X, bounds.Y, bounds.Width, bounds.Height, 0, 0, instance, 0);
        if (Handle == 0)
        {
            throw new InvalidOperationException($"CreateWindowEx failed with error {Marshal.GetLastPInvokeError()}.");
        }

        if (!DesktopHostAttachment.Attach(Handle, _target, bounds, layered: false, out var error))
        {
            User32.DestroyWindow(Handle);
            Handle = 0;
            throw new InvalidOperationException(error);
        }
    }

    [UnmanagedCallersOnly]
    private static nint WindowProc(nint hwnd, uint message, nint wParam, nint lParam)
    {
        return message switch
        {
            // Clicks belong to the desktop icons, never to the wallpaper.
            WM_NCHITTEST => HTTRANSPARENT,
            // Direct3D draws every pixel, so erasing would only cause a flash.
            WM_ERASEBKGND => 1,
            _ => User32.DefWindowProc(hwnd, message, wParam, lParam),
        };
    }

    public void Dispose()
    {
        if (Handle == 0) return;
        if (User32.IsWindow(Handle)) User32.DestroyWindow(Handle);
        Handle = 0;
        DesktopHostAttachment.RepaintDesktop(_target);
    }
}
