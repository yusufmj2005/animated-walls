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

Both are 0 today because the renderer does not exist. The renderer must increment them at the point of `Present` and at the point a frame is decoded, not anywhere higher up.

### 2. Process-scoped GPU engine counters

`GpuUsageSampler` reads `\GPU Engine(pid_<pid>_*)\Utilization Percentage`, the same source as Task Manager, and reports 3D and video-decode use for the engine process only.

The figures deliberately exclude `dwm.exe` and other processes. The compositor keeps using the GPU while wallpapers are suspended, so a claim of "zero GPU use" system-wide would be false. The claim is that **this process** does no rendering or decoding work.

The proof of concept showed that this sampler separates the two states on real hardware, reading 0.14% while presenting a solid colour at 60 Hz and 0% after stopping. A solid-colour clear is a very light load, so with a real wallpaper this gap will be far larger.

Web wallpapers run in WebView2 child processes. When the renderer ships, the sampler must sum over the whole engine process tree or these numbers will under-report.

### 3. Structured transition logs

Each `render.transition` and `visibility.changed` log line records from, to, reason and display, so a field report can be matched against what the user was doing.

## Acceptance test to add with the renderer

These cannot be automated meaningfully until the renderer exists:

1. Assign a wallpaper to a display and uncover the desktop. Confirm that `framesPresented` increases and engine GPU use is above 0.
2. Cover the display with an opaque window. Within 200 ms the decision must be `suspended`.
3. Hold for 5 seconds. Assert that the `framesPresented` and `framesDecoded` deltas are exactly 0, and that engine GPU 3D and decode are about 0.
4. Close the window and assert that the counters resume, with no visible glitch.
5. Repeat for each row of the behaviour table, on each display independently.

## Manual checks still outstanding

These need a person, or hardware that was not available during Sprint 01:

| Check | How | Why it is manual |
|---|---|---|
| Visible to covered to visible on a real desktop | Minimise everything, open the Displays page, and move a window across and off the screen. The badge should go Visible, Partly visible, Covered, and back | The development desktop was always covered by maximised windows, so automated runs only saw covered to covered |
| Icons draw above the hosted window | Minimise everything and run `--hosting-poc --seconds 10`. Solid colours should appear with icons on top | The automated check samples an empty point |
| Lock, display off, sleep | Lock the PC, let the display sleep, and check `session.changed` and `render.transition` in `engine.log` | Doing this in a test would interrupt the user |
| Exclusive fullscreen game | Run one and check the reason is `exclusive-fullscreen` | Requires a game |
| Multiple monitors, hotplug, mixed DPI | Connect a second display | Only one active display was available |
| Windows 10 and pre-24H2 layouts | Run `--diagnose` and `--hosting-poc` | Not available |
| Integrated GPU, hybrid laptops, Remote Desktop | Run `--diagnose` | Not available |
| A machine with no GPU | Expect `unsupported` and the Home page warning | Not available. The policy is unit tested |
| Tray icon and its menu | Right-click the icon | The icon's creation is logged and tested, but the shell's tray cannot be driven by the test tool |
| The NSIS installer | Install and uninstall | It was built, but installing changes the machine |

## Engine lifetime

Three layers make sure no engine outlives the app:

1. A normal quit sends `engine.shutdown`, with a kill after 3 seconds.
2. libuv spawns children in a kill-on-close job object, so an abrupt crash of Electron ends the engine straight away. This was confirmed with the packaged build. The engine gets no chance to log its exit in this case.
3. If the job does not apply, the engine exits when stdin closes. A test covers this.
