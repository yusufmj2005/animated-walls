# Animated Walls

**Turn your Windows desktop into a moving wallpaper, without slowing your PC down.**

Animated Walls plays videos behind your desktop icons. It uses your graphics card rather than your processor, and when your windows cover the desktop it stops completely, so it isn't working on something you can't see.

**[⬇ Download the latest version](https://github.com/yusufmj2005/animated-walls/releases/latest)**

## Getting started

1. **Install it.** Download `AnimatedWalls-Setup-1.0.0.exe` from the link above and run it. You don't need admin rights.
2. **Add a video.** Open the app, go to **Library**, click **Import** and choose an MP4 or WebM file. You can also drag the file onto the Library page.
3. **Set it as your wallpaper.** Click your video, then click **Assign** next to your monitor under **Show on**.
4. **See it play.** Minimise your windows, and your wallpaper will be moving behind your icons.

> **Windows may warn you when you run the installer.** The installer isn't code-signed yet, so SmartScreen might show "Windows protected your PC". To continue, click **More info**, then **Run anyway**.

## What you can do

| Feature | What it means |
|---|---|
| **Video wallpapers** | Play MP4 and WebM videos behind your icons. They fill the screen, cropping the edges if needed |
| **Stops when hidden** | When windows cover your desktop, or your screen is locked or off, it stops drawing and decoding. It picks up again when the desktop shows |
| **Your library** | Keep your wallpapers in one place, with search and filters |
| **Frame rate and quality** | Choose how smooth the wallpaper is and how much your graphics card works |
| **Pause any time** | Turn it off from Settings or the tray icon |
| **Starts with Windows** | Optional. It can start hidden in the tray |

## How much does it slow my PC down?

Very little. This was measured with a 4K video on an NVIDIA RTX 3080:

| | While playing | While covered |
|---|---|---|
| Graphics card, video decoding | 15% | **0%** |
| Graphics card, 3D | 0.4% | **0%** |
| Processor | 0.4% | **0%** |

These numbers are for Animated Walls only, and yours will depend on your hardware and your video.

## What's not ready yet

- **Image and web wallpapers:** you can import them, but they can't play yet.
- **Sound:** videos play muted.
- **Marketplace:** the page is empty for now.

This version has been tested on Windows 11 with an NVIDIA graphics card and one monitor. Windows 10, multiple monitors, laptops, and AMD or Intel graphics haven't been tested yet, so you may run into problems there.

## Common questions

**My wallpaper isn't moving. What's wrong?**
It only plays when you can see it, so check that your desktop isn't covered by another window. Then open **Home** in the app: the **Decision** and **Reason** rows tell you what it's doing and why.

**Does it replace my normal wallpaper?**
No. It plays on top of it, and your Windows wallpaper setting is never changed. Quit the app and your normal wallpaper comes back.

**Why does it keep running after I close the window?**
So your wallpaper keeps playing. The app stays in the tray, next to the clock. To stop it completely, right-click the tray icon and choose **Quit**. You can turn this off in **Settings** with **Keep running in the tray when closed**.

**It says "Blocked". What does that mean?**
The wallpaper can't play, and **Reason** on the **Home** page explains why. For example, Animated Walls only uses your graphics card, so it stops a video your card can't decode instead of falling back to your processor.

**What happens if I uninstall it?**
The app is removed, but your wallpapers and settings stay in `%APPDATA%\Animated Walls`, so they'll still be there if you reinstall. Delete that folder if you want them gone too.

**Something went wrong. How do I report it?**
[Open an issue](https://github.com/yusufmj2005/animated-walls/issues) and describe what happened. Logs help a lot: go to **Settings**, then **Diagnostics**, then **Open folder**.

## For developers

You'll need Windows 10 or 11 (x64), [Node.js](https://nodejs.org) 24 or newer, and the [.NET 10 SDK](https://dotnet.microsoft.com/download).

Install the dependencies:

```bash
npm install
```

Run the app in development:

```bash
npm run dev
```

| Command | What it does |
|---|---|
| `npm test` | Run the TypeScript and engine tests |
| `npm run test:e2e` | Test the real app from start to finish. A window opens during the run |
| `npm run test:engine:desktop` | Test on your real desktop. It briefly plays a test video behind your icons |
| `npm run typecheck` | Check all the TypeScript types |
| `npm run package` | Build the installer into `release/` |
| `npm run samples` | Build sample wallpapers into `samples/dist` |

**How the code is organised:**

| Folder | What's in it |
|---|---|
| `apps/desktop/` | The desktop app, built with Electron and React |
| `engine/` | The wallpaper engine, a separate C# program that plays the video and watches the desktop |
| `packages/` | Code shared across the project, including the `.awall` wallpaper format |
| `database/` | The database setup |
| `docs/` | Technical documentation |
| `samples/` | Sample wallpapers |
| `scripts/` | Build tools |

**Technical documentation:**

- [Architecture and design decisions](docs/architecture/overview.md)
- [Rendering, GPU rules and visibility](docs/architecture/rendering-and-visibility.md)
- [How wallpapers get behind the desktop icons](docs/architecture/windows-desktop-hosting.md)
- [The `.awall` wallpaper format](docs/specifications/awall-format.md)
- [Testing](docs/testing/testing.md)

## Licence

The source code is public so you can read it, but Animated Walls is proprietary software. See [LICENSE](LICENSE) for what that means.
