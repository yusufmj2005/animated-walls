# `.awall` package format, version 1

An `.awall` file is a ZIP archive with `manifest.json` at its root. Validation lives in `packages/wallpaper-format`.

## Manifest

```json
{
  "formatVersion": 1,
  "id": "com.example.aurora",
  "name": "Aurora",
  "description": "Optional, up to 2000 characters.",
  "creator": { "name": "Example Studio", "url": "https://example.com" },
  "type": "web",
  "entry": "index.html",
  "preview": "preview.png",
  "resolution": { "width": 3840, "height": 2160 },
  "audio": { "hasAudio": false, "defaultVolume": 0, "startMuted": true },
  "interaction": { "mouse": true, "keyboard": false },
  "requiredCapabilities": ["gpu.d3d11", "runtime.webview2"]
}
```

| Field | Required | Rules |
|---|---|---|
| `formatVersion` | Yes | Positive integer, at most the app's supported version |
| `id` | Yes | Lowercase letters and digits, separated by single `.`, `_` or `-`. At most 128 characters. Globally unique; reverse-domain style is recommended |
| `name` | Yes | At most 120 characters, no control characters |
| `description` | No | At most 2000 characters |
| `creator.name` | Yes | At most 120 characters |
| `creator.url` | No | Must be `https://` |
| `type` | Yes | `video`, `image` or `web` |
| `entry` | Yes | Safe package path. `video`: `.mp4`, `.webm`. `image`: `.png`, `.jpg`, `.jpeg`, `.webp`. `web`: `.html`, `.htm` |
| `preview` | Yes | Safe package path to a `.png`, `.jpg`, `.jpeg` or `.webp` |
| `resolution` | Yes | Whole numbers from 1 to 16384 |
| `audio` | No | Defaults to no audio, volume 0, muted. `defaultVolume` is 0 to 1 |
| `interaction` | No | Defaults to `false` for both |
| `requiredCapabilities` | No | At most 32 names. `runtime.webview2` is added automatically for `web` |

The manifest itself may be at most 64 KiB. Unknown fields and capabilities produce warnings, not errors, so newer creator tools stay compatible. A higher `formatVersion` is an error telling the user to update.

### Capabilities

`gpu.d3d11`, `decode.h264`, `decode.hevc`, `decode.vp8`, `decode.vp9`, `decode.av1`, `runtime.webview2`

## Allowed package contents

`.mp4 .webm .html .htm .css .js .mjs .png .jpg .jpeg .webp .json`

Any other file rejects the whole package, including executables and scripts.

## Limits

| Limit | Value |
|---|---|
| Files | 10,000 |
| Per file | 8 GiB |
| Total | 16 GiB |
| Compression ratio | 200:1, for files over 1 MiB |

## Threat model

Packages come from strangers, so all of this is checked before a file is trusted:

| Attack | Defence |
|---|---|
| Path traversal (`../`, `..\`, absolute paths, drive letters) | Rejected in the listing, then re-checked at extraction |
| NTFS tricks: alternate data streams (`a.png:evil`), trailing dots and spaces, device names (`CON.png`) | Rejected by `validatePackagePath` |
| Case collisions (`A.png` and `a.png`) | Rejected, because NTFS would overwrite one with the other |
| Symbolic links, encrypted entries | Rejected |
| Zip bombs | Ratio limit and size limits, plus streaming extraction that yauzl checks against declared sizes |
| A disguised file, such as an `.exe` named `.png` | Content is sniffed for all media; the extension alone is never trusted |
| Oversized manifest, JSON tricks | Size limit, and the manifest is rebuilt field by field, so unknown keys never reach the app |
| `javascript:` links in metadata | `creator.url` must be `https://` |
| UNC paths in an import request | Rejected, because touching one would send the user's NTLM hash to that server |

Extraction happens in a staging directory that is renamed into place only once everything has passed. A rejected or interrupted import leaves nothing behind.

## Web wallpaper sandbox requirements

Web wallpapers do not run yet. When they do, in the renderer milestone, these are requirements:

- They run only in WebView2 under the engine, never in Electron.
- Each wallpaper gets its own user data folder, so no storage is shared with others or with the app.
- Content is served through a virtual host mapped to only that wallpaper's directory.
- No host objects are added, so no native bridge exists.
- Navigation away from the virtual host, new windows, downloads and permission requests are all denied.
- Network access is off by default, enforced through `WebResourceRequested`. A future manifest capability could ask for it, with user consent.
- DevTools and the default context menu are disabled.

The Electron renderer can already never load this code: the media protocol refuses to serve a web wallpaper's entry point.
