# Windows desktop hosting

To draw a wallpaper behind the desktop icons, a window must be parented into Explorer's desktop window tree. None of this is a documented or supported Windows API, so it could change in any Windows update. The code detects the layout it finds rather than branching on a version number.

## The two layouts

### Classic: Windows 10, and Windows 11 before 24H2

```
Progman
WorkerW  ← created by message 0x052C
  └─ SHELLDLL_DefView (icons)
WorkerW  ← empty, behind the icons: parent the wallpaper here
```

### Current: Windows 11 24H2 and later

Observed directly on build 26300:

```
Progman  (WS_EX_NOREDIRECTIONBITMAP)
  ├─ SHELLDLL_DefView (icons, WS_EX_LAYERED)
  ├─ wallpaper window  ← insert directly below DefView
  └─ WorkerW           ← created by message 0x052C
```

`DesktopHostLocator` tells these apart by where it finds `SHELLDLL_DefView`.

## Proof of concept

```bash
AnimatedWalls.Engine.exe --hosting-poc --seconds 4
```

It locates the host, parents a window, creates a Direct3D 11 device on the hardware adapter with a flip-model swap chain, presents frames, holds a probe colour, stops, and reports.

### Checking the result without disturbing the user

Reading the screen fails when windows cover the desktop. So the check registers a live DWM thumbnail of Progman into a tiny topmost window and reads that pixel from the screen. DWM draws the thumbnail from Progman's own composition tree, whatever is on top of it.

### Result on Windows 11 Pro build 26300, RTX 3080

| Measurement | Result |
|---|---|
| Layout detected | `ProgmanChild` |
| Parent, and z-order below icons | Confirmed |
| Swap chain | `FlipDiscard` on a plain `WS_CHILD` window |
| Frames presented | 273 in about 4.5 s (60 Hz vsync) |
| Pixel before | `#DAD8DD` (the user's wallpaper) |
| Pixel while presenting | `#D919A6` (probe colour `#D91AA6`, within tolerance) |
| Pixel after stopping | `#DCD9DF` (the wallpaper again, differing slightly from before) |
| This process's GPU 3D while presenting | 0.14% |
| This process's GPU 3D after stopping | 0% |

The fallback variant, a layered window with a blit-model swap chain, is implemented, but was not needed and has not been exercised.

### What this does and does not prove

**Proven here:** the window is in the right place in the tree, frames from the hardware adapter reach Progman's composition, the desktop returns afterwards, and process-level GPU measurement distinguishes presenting from stopped.

**Not proven:**

- **That icons visibly draw on top.** Z-order says they should, but the check samples one pixel in an empty area. This still needs a person to look at a desktop with no windows in the way.
- **The classic layout.** No Windows 10 or pre-24H2 machine was available. Its code path has never run.
- **Multiple monitors.** Only one active display was available, and the proof of concept handles only the primary. Mixed-DPI and negative-coordinate setups are untested, other than as unit tests of the arithmetic.
- **Explorer restarts.** The signal is detected and logged, but no re-parenting exists yet.
- **Long-running behaviour.** It ran for seconds, not hours, and has not been through sleep and resume.
- **Other shells.** Replacement shells such as ExplorerPatcher, Start11 and WindowBlinds are untested.

## Limitations and alternatives

| Approach | Verdict |
|---|---|
| Child of Progman or WorkerW (used) | The only approach that puts content behind icons. Undocumented, but widely relied on by existing wallpaper software, which gives Microsoft a reason not to break it casually |
| Topmost-bottom borderless window | Draws over icons, so it does not meet the requirement |
| `IDesktopWallpaper` with rapidly changing images | Documented, but slideshow-based, with no GPU path and heavy disk use |
| DirectComposition visual into Progman | Worth evaluating. Progman on this layout is already composition-based, but this needs more undocumented behaviour than a child window does |

## How the renderer uses this

- `TaskbarCreated` rebuilds every surface after a short delay, since Explorer takes the wallpaper windows with it. Written, not yet exercised.
- A change of display geometry rebuilds that display's surface. Written, not yet exercised.
- Each display has its own host window and swap chain, so displays suspend independently.
- The host window's thread keeps pumping messages even while suspended. A child window shares an input queue with its parent, so an unpumped one can hang Explorer.
- Clicks pass through, as the window answers `HTTRANSPARENT`.
- Destroying the window is what restores the normal wallpaper, and no settings call is involved. The classic layout may behave differently, since a `WorkerW` can retain its last frame.
- `SPI_SETDESKWALLPAPER` is never called, so the user's own wallpaper setting is never changed.
