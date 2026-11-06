# Animated Walls

Premium animated wallpapers for Windows 10 and 11. Wallpapers render on the GPU while they can be seen, and stop rendering when other windows cover them.

**Status:** video wallpapers (MP4 and WebM) play behind the desktop icons, decoded on the GPU, and stop completely when covered. Image and web wallpapers import, but cannot play yet. Audio is not implemented.

## Repository layout

```
apps/desktop/          Electron app
  electron/main/       Main process: database, engine supervisor, library, tray, logging
  electron/preload/    The renderer's only route to the system
  electron/ipc/        Validated IPC handlers
  src/                 React UI
engine/                Native engine (C#, .NET 10), a separate executable
packages/
  shared-types/        Wire contracts shared by main, preload and renderer
  wallpaper-format/    .awall manifest and package validation
  design-system/       Tokens and reusable React components
database/              Versioned SQL migrations and the schema snapshot
docs/                  Architecture, specifications and testing
samples/               Sample wallpaper sources, built into samples/dist
scripts/               Build and asset scripts
```

## Prerequisites

- Windows 10 or 11, x64
- Node.js 24 or newer
- [.NET 10 SDK](https://dotnet.microsoft.com/download)

No C++ toolchain or Windows SDK is needed. The app has no native Node modules.

## Getting started

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` builds the engine in development mode, then starts the app with hot reload.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development |
| `npm run build` | Build the release engine and the app |
| `npm run typecheck` | Type-check all TypeScript |
| `npm run test:ts` | Format, database, library and engine integration tests |
| `npm run test:engine` | Engine unit tests |
| `npm run test:engine:desktop` | Engine tests against the real desktop. A window flashes briefly |
| `npm run test:e2e` | Build, then drive the real app end to end |
| `npm run package:dir` | Build an unpacked distributable in `release/win-unpacked` |
| `npm run package` | Build the NSIS installer in `release/` |
| `npm run samples` | Build sample `.awall` packages into `samples/dist` |

The engine also runs on its own:

```bash
apps/desktop/resources/engine/AnimatedWalls.Engine.exe --diagnose
```

```bash
apps/desktop/resources/engine/AnimatedWalls.Engine.exe --hosting-poc --seconds 4
```

`--diagnose` prints GPU, display, visibility and hosting findings as JSON. `--hosting-poc` draws solid colours behind your desktop icons for a few seconds and prints what it measured.

## Where data lives

Everything is under `%APPDATA%\Animated Walls`:

| Path | Contents |
|---|---|
| `animated-walls.db` | Settings, library metadata and display assignments |
| `wallpapers/<id>/` | Extracted wallpaper files |
| `logs/app.log`, `logs/engine.log` | Structured logs, one JSON object per line, rotated at 5 MB |

## Documentation

- [Architecture overview and decisions](docs/architecture/overview.md)
- [Rendering, GPU policy and visibility](docs/architecture/rendering-and-visibility.md)
- [Windows desktop hosting findings](docs/architecture/windows-desktop-hosting.md)
- [`.awall` format specification](docs/specifications/awall-format.md)
- [Testing and how suspended rendering is verified](docs/testing/testing.md)

## Licence

Proprietary and source-available. See [LICENSE](LICENSE).
