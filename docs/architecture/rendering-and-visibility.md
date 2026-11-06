# Rendering, GPU policy and visibility

## GPU policy

Wallpapers render on hardware or not at all. `GpuCapabilityDetector` enforces this:

- Each adapter is enumerated with DXGI. A device is created with `DriverType.Unknown` and an explicit adapter, which means that hardware or nothing. No code path requests `DriverType.Warp`.
- Rejected: anything with `DXGI_ADAPTER_FLAG_SOFTWARE`, and all of vendor `0x1414` (Microsoft Basic Render, Basic Display and virtual GPUs). Also rejected is any adapter that cannot create a device at feature level 11_0 or above.
- Selection prefers an adapter that drives a display, since presenting from it avoids a cross-adapter copy. After that, it prefers the most dedicated memory.
- Detection repeats when displays change or a session reconnects, which is how driver updates, new GPUs and Remote Desktop show up. A change reaches the UI as a `gpu.changed` event.
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
| `WTSRegisterSessionNotification` | Lock, unlock, and sessions connecting or disconnecting, read back with `WTSQuerySessionInformation` |
| `SPI_GETSCREENSAVERRUNNING`, read when a desktop switch fires | Screen saver |
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
| 5 | Nobody connected to the session | suspended | `session-disconnected` |
| 6 | Screen saver running | suspended | `screen-saver` |
| 7 | Display off | suspended | `display-off` |
| 8 | User paused | suspended | `user-paused` |
| 9 | On battery, with the setting on | suspended | `on-battery` |
| 10 | Exclusive fullscreen on this display | suspended | `exclusive-fullscreen` |
| 11 | Covered | suspended | `desktop-covered` |
| 12 | Partly visible | render | `partially-visible` |
| 13 | Otherwise | render | `desktop-visible` |

## The video renderer

`WallpaperRenderer` makes the desktop match the coordinator's decisions, with one `WallpaperSurface` per display. Each surface has its own thread, host window, Direct3D 11 device, flip-model swap chain and Media Engine.

| State | Presenting | Decoding | Resources |
|---|---|---|---|
| Playing | Each new frame, up to the frame rate limit | Yes | All held |
| Suspended | No | No, the Media Engine is paused | The last frame stays on screen, and the thread sleeps until woken |
| Suspended for 30 seconds | No | No | The decoder is released. It is recreated at the same position on resume |
| Idle or blocked | No | No | The surface is removed, and the normal Windows wallpaper returns |

A display that starts out covered creates nothing until it first shows.

### How GPU-only is enforced for video

Windows chooses the decoder, and a stream the hardware cannot handle could quietly decode in software. So there are three checks:

1. The device is created on an explicit hardware adapter, so it can never be WARP.
2. Once playing, the video's codec is compared with the adapter's hardware decode profiles.
3. The GPU's video engine is measured for this process while frames decode. If frames arrive while it stays idle on two attempts, playback stops with `no-hardware-decode`.

If the counters are unavailable, the result is inconclusive and logged, and playback continues, because a machine with performance counters disabled should not lose its wallpaper over that. The software path of the third check has only been unit tested, since this hardware decodes everything it was given.

### Frame pacing

The loop waits on `IDXGIOutput::WaitForVBlank`, then asks the Media Engine whether a new frame is due. A frame is presented only if there is a new one and the limit allows it, so a 30 fps video on a 60 Hz display presents 30 times a second.

## Still to build

- **Web wallpapers:** WebView2 `TrySuspendAsync` when suspended. It needs testing to confirm rendering really stops, since suspension behaviour depends on the WebView being hidden first.
- **Image wallpapers:** a single present and nothing further.
- **Partial visibility:** every partly visible display currently draws in full. Fractions and rectangles are already reported.
