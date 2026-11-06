# Testing

## Test suites

| Command | Covers | Needs |
|---|---|---|
| `npm run test:engine` | Region arithmetic, window classification, every row of the behaviour table, GPU policy, framing, authentication, RPC, log rotation | .NET SDK |
| `npm run test:engine:desktop` | Real display enumeration, real GPU detection, a real window covering a display | An interactive desktop. A window flashes briefly |
| `npm run test:ts` | Manifest and package validation, migrations, persistence across restarts, repositories, hostile package rejection, logging, and the real engine over the real pipe | A built engine. Integration tests are skipped without one |
| `npm run test:e2e` | The real Electron app and engine driven by Playwright: navigation, imports, video playback, assignment, restart persistence, security boundaries, the tray close path, and logs | A built app. A window opens during the run |

The end-to-end suite uses a temporary user data folder and never touches real app data. It writes screenshots to `test-results/screenshots`.

## How suspended rendering is verified

The product promises that wallpapers stop rendering when covered. GPU percentages alone cannot prove this, so three independent signals are used:

### 1. Engine counters

`framesPresented` and `framesDecoded` are monotonic counters in `EngineCounters`, reported by `engine.health`. Sample them, wait, and sample again. **While suspended, both must not change.** This is exact, immune to noise, and cheap enough to always have on.

`WallpaperSurface` increments them at the point of `Present` and at the point the Media Engine reports a new frame, not anywhere higher up.

### 2. Process-scoped GPU engine counters

`GpuUsageSampler` reads `\GPU Engine(pid_<pid>_*)\Utilization Percentage`, the same source as Task Manager, and reports 3D and video-decode use for the engine process only.

The figures deliberately exclude `dwm.exe` and other processes. The compositor keeps using the GPU while wallpapers are suspended, so a claim of "zero GPU use" system-wide would be false. The claim is that **this process** does no rendering or decoding work.

`WallpaperSurfaceTests` asserts the decode figure is above 0 while playing, and exactly 0 for both 3D and decode while suspended, using real video on real hardware.

Web wallpapers run in WebView2 child processes. When the renderer ships, the sampler must sum over the whole engine process tree or these numbers will under-report.

### 3. Structured transition logs

Each `render.transition` and `visibility.changed` log line records from, to, reason and display, so a field report can be matched against what the user was doing.

## Acceptance tests

`npm run test:engine:desktop` runs `WallpaperSurfaceTests`, which control a surface directly so they work whatever windows are open. They draw a test video behind the icons for a few seconds:

- Frames present, and the GPU's video engine is busy, while playing.
- While suspended, the presented and decoded counters do not change at all, and GPU use reads 0%.
- Frames resume afterwards.
- The picture on the desktop really changes, and the normal wallpaper returns after stopping.
- The frame rate limit holds.
- A long suspension releases the decoder, and resuming recreates it.
- A missing or corrupt file fails and says why.

`npm run test:e2e` covers the same behaviour through the whole app, using a real covering window.

## Manual checks still outstanding

These need a person, or hardware that was not available during Sprint 01:

| Check | How | Why it is manual |
|---|---|---|
| Fully visible on a real desktop | Minimise everything, open the Displays page, and move a window across and off the screen. The badge should go Visible, Partly visible, Covered, and back | Partly visible to covered and back was seen on the real desktop, with suspend reaching the UI in 85 ms and resume in 92 ms. Fully visible was not, since other windows were always open |
| Icons draw above the hosted window | Minimise everything and run `--hosting-poc --seconds 10`. Solid colours should appear with icons on top | The automated check samples an empty point |
| Lock, display off, sleep, screen saver, Remote Desktop disconnect | Do each one, then check `session.changed` and `render.transition` in `engine.log` | Doing this in a test would interrupt the user |
| Exclusive fullscreen game | Run one and check the reason is `exclusive-fullscreen` | Requires a game |
| Multiple monitors, hotplug, mixed DPI | Connect a second display | Only one active display was available |
| Windows 10 and pre-24H2 layouts | Run `--diagnose` and `--hosting-poc` | Not available |
| Integrated GPU, hybrid laptops, Remote Desktop | Run `--diagnose` | Not available |
| The Home page warning on a machine with no GPU | Expect the warning, with playback blocked | CI runners have no GPU, and the engine correctly reports `blocked` there, but the UI has not been seen in that state |
| Tray icon and its menu | Right-click the icon | The icon's creation is logged and tested, but the shell's tray cannot be driven by the test tool |
| The NSIS installer | Install and uninstall | It was built, but installing changes the machine |

## Engine lifetime

Three layers make sure no engine outlives the app:

1. A normal quit sends `engine.shutdown`, with a kill after 3 seconds.
2. libuv spawns children in a kill-on-close job object, so an abrupt crash of Electron ends the engine straight away. This was confirmed with the packaged build. The engine gets no chance to log its exit in this case.
3. If the job does not apply, the engine exits when stdin closes. A test covers this.
