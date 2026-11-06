# Rendering, GPU policy and visibility

## GPU policy

Wallpapers render on hardware or not at all. `GpuCapabilityDetector` enforces this:

- Each adapter is enumerated with DXGI. A device is created with `DriverType.Unknown` and an explicit adapter, which means that hardware or nothing. No code path requests `DriverType.Warp`.
- Rejected: anything with `DXGI_ADAPTER_FLAG_SOFTWARE`, and all of vendor `0x1414` (Microsoft Basic Render, Basic Display and virtual GPUs). Also rejected is any adapter that cannot create a device at feature level 11_0 or above.
- Selection prefers an adapter that drives a display, since presenting from it avoids a cross-adapter copy. After that, it prefers the most dedicated memory.
- With no usable adapter, the status is `unsupported`. Any display with a wallpaper assigned reports `blocked`, the UI shows why, and nothing falls back.

Hardware decode support comes from `ID3D11VideoDevice::GetVideoDecoderProfile`, matched against the known H.264, HEVC, VP8, VP9 and AV1 profile GUIDs.

### Measured on the development machine

| | |
|---|---|
| Selected adapter | NVIDIA GeForce RTX 3080, feature level 12_1, 9.8 GB dedicated |
| Hardware decode | AV1, H.264, HEVC, VP9. VP8 is not reported, so VP8 WebM will not have hardware decode here |
| Rejected | Microsoft Basic Render Driver (software rasteriser) |
| Note | A second adapter with the same name and no outputs also appears. A Parsec virtual display driver is installed on this machine and is the likely source. The output check means it is not selected |

## Visibility pipeline

```
Windows events ──► DesktopSignalPump ──► VisibilityMonitor ──► PlaybackCoordinator ──► state.changed
(WinEvents, power,   throttled 80 ms      window snapshot       RenderPolicy per
 session, display)   on one STA thread    + region arithmetic   display, per reason
```

### Signals

| Source | Used for |
|---|---|
| `SetWinEventHook` (out of context): foreground, minimise, move/size end, show, hide, reorder, location change, cloak, desktop switch | Windows changing |
| `WTSRegisterSessionNotification` | Lock and unlock |
| `RegisterPowerSettingNotification`: `GUID_SESSION_DISPLAY_STATUS`, `GUID_ACDC_POWER_SOURCE` | Display off or dimmed, battery |
| `WM_POWERBROADCAST` | System sleep and resume |
| `WM_DISPLAYCHANGE`, `WM_DPICHANGED`, `WM_SETTINGCHANGE` | Monitor layout |
| `"TaskbarCreated"` broadcast | Explorer restarted, so hosted windows must be re-parented |
| `SHQueryUserNotificationState` | True exclusive fullscreen |

`WINEVENT_OUTOFCONTEXT` injects nothing into other processes, which matters around anti-cheat systems. Cursor, caret and child-control events are dropped before any work is done.

The signal window is a hidden top-level window, because a message-only window does not receive broadcasts.

### Why not ask DWM directly?

There is no public DWM API that reports whether a window is occluded by others. What DWM does provide, and what this uses, is:

- `DWMWA_CLOAKED`: excludes windows on other virtual desktops and suspended UWP apps. A plain visibility check gets these wrong.
- `DWMWA_EXTENDED_FRAME_BOUNDS`: the true visible rectangle. `GetWindowRect` includes an invisible resize border of about 8 px per side.

Occlusion is computed by walking `EnumWindows` (top of the z-order first) to the desktop layer, classifying each window, and subtracting opaque ones from each monitor's rectangle.

### Classification findings

Tested against a real session on Windows 11 build 26300:

- **There are many hidden `WorkerW` windows** in the z-order, 16 on this machine, with real application windows beneath them. The walk stops only at `Progman`, or a visible `WorkerW` that holds the icons.
- **`WS_EX_NOREDIRECTIONBITMAP` says nothing about opacity.** Chromium browsers set it and are opaque, so it must not exclude a window.
- **Click-through windows are excluded.** These are overlays, such as game bars and recorders.
- **Layered windows count only if they are readably opaque.** Per-pixel alpha windows make `GetLayeredWindowAttributes` fail and do not count.
- **A display counts as covered at 0.25% visible or less.** An auto-hidden taskbar leaves a 2 px strip that would otherwise keep a wallpaper rendering.

### Known limits of this approach

- **Windows with transparent content but no sign of it in their styles** will count as opaque. For example, an app using DirectComposition with a transparent background can falsely suspend the wallpaper. A class list or a user override may be needed once this shows up in practice.
- **Display power is per session, not per monitor.** Windows reports one status, so turning off one monitor of several is not detected through this signal.
- **Partial visibility** is reported as a fraction and a rectangle list. Rendering only those regions is a renderer-milestone decision. The likely route is `IDXGISwapChain1::Present1` with dirty rectangles for web content; for video it probably will not save enough to be worthwhile.
- **A window hidden behind the wallpaper layer** cannot happen by construction, but other shell replacements have not been tested.

## Render policy

`RenderPolicy.Decide` is a pure function. Checks run in this order, and the first match wins:

| # | Condition | Decision | Reason |
|---|---|---|---|
| 1 | No wallpaper assigned | idle | `no-wallpaper-assigned` |
| 2 | No supported GPU | blocked | `gpu-unsupported` |
| 3 | System asleep | suspended | `system-suspended` |
| 4 | Session locked | suspended | `session-locked` |
| 5 | Display off | suspended | `display-off` |
| 6 | User paused | suspended | `user-paused` |
| 7 | On battery, with the setting on | suspended | `on-battery` |
| 8 | Exclusive fullscreen on this display | suspended | `exclusive-fullscreen` |
| 9 | Covered | suspended | `desktop-covered` |
| 10 | Partly visible | render | `partially-visible` |
| 11 | Otherwise | render | `desktop-visible` |

While `EngineInfo.RendererImplemented` is false, a `render` decision means only that frames would be drawn. The UI labels it "Would render".

## For the renderer milestone

- **On suspend:** stop presenting and stop the decode loop, keep decoder and swap chain alive, and hold the current frame. Add a timer that releases decoders and video memory after a sustained suspension, such as 30 seconds.
- **On resume:** seek-free continue if resources are still held, otherwise re-create them and resume from the saved position.
- **Web wallpapers:** WebView2 `TrySuspendAsync` when suspended. It needs testing to confirm rendering really stops, since suspension behaviour depends on the WebView being hidden first.
- **Frame pacing:** `frameRateLimit` is already stored and delivered to the engine, but nothing consumes it yet.
- **Media Foundation:** use `IMFSourceReader` with a DXGI device manager for zero-copy decode. If a stream has no hardware decode path, report it and do not play it, per the GPU policy.
