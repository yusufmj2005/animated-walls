// Builds sample .awall packages into samples/dist, for trying the app and for tests.
import { createWriteStream, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { encodePng } from './lib/png.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'samples', 'sources');
const output = join(root, 'samples', 'dist');
mkdirSync(output, { recursive: true });

const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 360;

function mix(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Layered sine ribbons over a vertical gradient, the same look as the live wallpapers. */
function drawRibbons(width, height, { top, bottom, ribbon, ribbons, seed }) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const v = y / height;
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      let r = mix(top[0], bottom[0], v);
      let g = mix(top[1], bottom[1], v);
      let b = mix(top[2], bottom[2], v);
      for (let index = 0; index < ribbons; index += 1) {
        const phase = seed + index * 1.7;
        const center = 0.32 + index * 0.13 + 0.08 * Math.sin(u * 5 + phase) + 0.04 * Math.sin(u * 13 + phase * 2);
        const glow = (1 - smoothstep(0, 0.13, Math.abs(v - center))) * (0.4 - index * 0.05);
        r = mix(r, ribbon[0], glow);
        g = mix(g, ribbon[1], glow);
        b = mix(b, ribbon[2], glow);
      }
      const offset = (y * width + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }
  return encodePng(width, height, pixels);
}

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

async function writePackage(fileName, files) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name);
  zip.end();
  const target = join(output, fileName);
  mkdirSync(dirname(target), { recursive: true });
  await pipeline(zip.outputStream, createWriteStream(target));
  console.log(`[samples] ${relative(root, target)}`);
}

function readSources(name) {
  const directory = join(sourceRoot, name);
  return Object.fromEntries(walk(directory).map((path) => [relative(directory, path).replaceAll('\\', '/'), readFileSync(path)]));
}

const palettes = {
  aurora: { top: [10, 14, 40], bottom: [12, 44, 70], ribbon: [90, 230, 190], ribbons: 3, seed: 0.6 },
  ember: { top: [28, 10, 30], bottom: [90, 26, 34], ribbon: [255, 160, 90], ribbons: 3, seed: 2.2 },
  dusk: { top: [20, 22, 60], bottom: [200, 110, 120], ribbon: [255, 214, 170], ribbons: 2, seed: 4.1 },
};

await writePackage('aurora-drift.awall', {
  ...readSources('aurora-drift'),
  'preview.png': drawRibbons(PREVIEW_WIDTH, PREVIEW_HEIGHT, palettes.aurora),
  'manifest.json': JSON.stringify(
    {
      formatVersion: 1,
      id: 'app.animatedwalls.samples.aurora-drift',
      name: 'Aurora Drift',
      description: 'Slow ribbons of light. A sample web wallpaper drawn with Canvas.',
      creator: { name: 'Animated Walls Samples' },
      type: 'web',
      entry: 'index.html',
      preview: 'preview.png',
      resolution: { width: 3840, height: 2160 },
      audio: { hasAudio: false, defaultVolume: 0, startMuted: true },
      interaction: { mouse: false, keyboard: false },
      requiredCapabilities: ['gpu.d3d11', 'runtime.webview2'],
    },
    null,
    2,
  ),
});

await writePackage('ember-field.awall', {
  ...readSources('aurora-drift'),
  'preview.png': drawRibbons(PREVIEW_WIDTH, PREVIEW_HEIGHT, palettes.ember),
  'manifest.json': JSON.stringify(
    {
      formatVersion: 1,
      id: 'app.animatedwalls.samples.ember-field',
      name: 'Ember Field',
      description: 'Warm currents that follow the pointer. A sample interactive web wallpaper.',
      creator: { name: 'Animated Walls Samples', url: 'https://github.com' },
      type: 'web',
      entry: 'index.html',
      preview: 'preview.png',
      resolution: { width: 2560, height: 1440 },
      interaction: { mouse: true, keyboard: false },
      requiredCapabilities: ['gpu.d3d11', 'runtime.webview2'],
    },
    null,
    2,
  ),
});

const dusk = drawRibbons(1280, 720, palettes.dusk);
await writePackage('quiet-dusk.awall', {
  'dusk.png': dusk,
  'preview.png': drawRibbons(PREVIEW_WIDTH, PREVIEW_HEIGHT, palettes.dusk),
  'manifest.json': JSON.stringify(
    {
      formatVersion: 1,
      id: 'app.animatedwalls.samples.quiet-dusk',
      name: 'Quiet Dusk',
      description: 'A still evening sky. A sample image wallpaper.',
      creator: { name: 'Animated Walls Samples' },
      type: 'image',
      entry: 'dusk.png',
      preview: 'preview.png',
      resolution: { width: 1280, height: 720 },
      requiredCapabilities: ['gpu.d3d11'],
    },
    null,
    2,
  ),
});
