# Architecture overview

## Processes

```
┌───────────────────────── Electron ─────────────────────────┐
│  Renderer (React)                                          │
│    sandboxed, context-isolated, no Node.js, strict CSP     │
│         │  window.animatedWalls: a fixed, typed API        │
│  Preload                                                   │
│         │  named IPC channels only                         │
│  Main process                                              │
│    IPC validation · SQLite · library · tray · logging      │
│    engine supervisor                                       │
└────────┬───────────────────────────────────────────────────┘
         │  named pipe: length-prefixed JSON, mutual HMAC handshake
┌────────┴───────────────────────────────────────────────────┐
│  AnimatedWalls.Engine.exe (C#, .NET 10)                    │
│    Desktop signals → visibility → render policy → state    │
│    GPU detection · display monitoring · diagnostics        │
└────────────────────────────────────────────────────────────┘
```

The engine is a separate process so a native crash cannot take the UI down, and so wallpapers can keep running with almost no overhead while the UI is closed. The renderer lives here too. WebView2 wallpaper processes will be children of the engine.

## Three kinds of "suspended"

These are different and the code keeps them apart:

| State | What it means | Owner |
|---|---|---|
| Process shutdown | The engine exits | `EngineSupervisor`, `EngineHost` |
| Application suspension | The UI window is hidden, and the engine keeps running | `apps/desktop/electron/main/index.ts` |
| Rendering suspension | The engine runs, and a display draws and decodes nothing | `RenderPolicy` |

## Security boundaries

- **Renderer:** treated as less trusted than the main process. It has no Node.js, runs sandboxed, and can only call named methods whose arguments are validated in main. Each call also checks that it came from the app's own page.
- **IPC to the engine:** the pipe has a random name per launch and uses `FirstPipeInstance`, so the name cannot be squatted. Its ACL allows only the current user and denies network logons. Both sides prove they hold a token passed over stdin, using HMAC, so the token never crosses the pipe and never appears on a command line.
- **Wallpaper packages:** untrusted. See [the format specification](../specifications/awall-format.md). Web wallpaper code is never served to the app's renderer; the media protocol returns only preview images and video.
- **Packaged build:** Electron fuses disable `RunAsNode`, `NODE_OPTIONS` and CLI inspection, and enable asar integrity validation.

## Decisions

### D1. `node:sqlite` instead of `better-sqlite3`

Electron 45 bundles Node 24, where `node:sqlite` works. Both libraries were tested inside Electron and both work.

Chosen because it means no native module, no rebuild step, no ABI mismatch between test runs on system Node and the app in Electron, and one fewer dependency. **Trade-off:** the API is still marked as under active development upstream. All SQL goes through the repository classes, so swapping it would be contained.

### D2. npm workspaces, with all runtime code bundled

Every runtime dependency is a `devDependency` that Vite bundles. The packaged app ships no `node_modules`, which keeps the asar small and the audit surface obvious.

### D3. Named pipe and length-prefixed JSON

Chosen over gRPC or a local TCP port. A pipe has an OS-enforced ACL, a TCP port does not. JSON is easy to log and debug at the low message rate involved. Frames carry a size limit that is checked before allocation. Video frames will never cross this channel.

### D4. Vortice for Direct3D, not hand-written COM

Sprint 01 only needs a little DXGI and D3D11, but the renderer needs swap chains, video devices and Media Foundation. Vortice is a maintained, MIT-licensed, thin binding. Win32 calls with no COM involved stay as `LibraryImport` in `Core/Native.cs`.

### D5. Event-driven visibility with no polling

See [rendering and visibility](rendering-and-visibility.md). While the desktop is unchanged, the engine does no periodic work apart from answering the 15-second health check.

### D6. Biased classification of occluders

When unsure whether a window is opaque, it does not count as covering the wallpaper. A wrong "visible" costs some GPU time, whereas a wrong "covered" freezes a wallpaper the user can see.

### D7. Self-contained, single-file engine for release

Users do not need .NET installed. Native AOT would give a smaller, faster-starting binary, but it needs the C++ toolchain, so it was left for later evaluation.

### D8. No router or state library in the UI

Five pages and a small set of stores do not justify the dependencies. `useSyncExternalStore` with a 20-line store is enough for now.

### D9. The Media Engine for video playback

`IMFMediaEngine` in frame-server mode, rather than assembling a source reader and pacing frames by hand. It handles timing, looping and format changes, and pausing it is what stops decoding. Frames go straight into the swap chain's back buffer with `TransferVideoFrame`.

**Trade-off:** Windows chooses the decoder, and the API does not expose which one it picked. So hardware decoding is verified by measurement instead. See [rendering and visibility](rendering-and-visibility.md).

## Not yet built

- Image and web wallpapers, including WebView2 hosting.
- Audio. Video plays muted.
- Rendering only the visible parts of a partly covered display.
- Multi-monitor playback is built per display, but has only run on one monitor.
- Code signing. The installer is unsigned, so SmartScreen will warn. A certificate is required before any commercial release.
- Marketplace and Creator Portal backends.
