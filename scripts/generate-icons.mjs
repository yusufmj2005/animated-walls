// Draws the application and tray icons from code, so the artwork is reproducible and
// needs no image tools. Output: apps/desktop/resources/icons/{app.ico,tray.png}
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodePng } from './lib/png.mjs';

const output = resolve(import.meta.dirname, '..', 'apps', 'desktop', 'resources', 'icons');
mkdirSync(output, { recursive: true });

const SUPERSAMPLE = 4;

function roundedRectCoverage(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const distance = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
  return distance <= 0;
}

/** Three stacked wave bands: motion, on a wall. */
function waveBand(u, v, offset) {
  const center = offset + 0.055 * Math.sin((u + offset * 2.2) * Math.PI * 2);
  return Math.abs(v - center) < 0.058;
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.225;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px + (sx + 0.5) / SUPERSAMPLE;
          const y = py + (sy + 0.5) / SUPERSAMPLE;
          if (!roundedRectCoverage(x, y, size, radius)) continue;
          covered += 1;
          const u = x / size;
          const v = y / size;
          const inBand = u > 0.17 && u < 0.83 && (waveBand(u, v, 0.33) || waveBand(u, v, 0.5) || waveBand(u, v, 0.67));
          if (inBand) {
            r += 200 + 40 * u;
            g += 212 + 24 * u;
            b += 255;
          } else {
            r += 34 + 34 * u;
            g += 38 + 30 * u;
            b += 74 + 70 * (1 - v);
          }
        }
      }
      const offset = (py * size + px) * 4;
      if (covered > 0) {
        pixels[offset] = Math.round(r / covered);
        pixels[offset + 1] = Math.round(g / covered);
        pixels[offset + 2] = Math.round(b / covered);
      }
      pixels[offset + 3] = Math.round((covered / (SUPERSAMPLE * SUPERSAMPLE)) * 255);
    }
  }
  return encodePng(size, size, pixels);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, png: drawIcon(size) }));
writeFileSync(join(output, 'app.ico'), encodeIco(images));
writeFileSync(join(output, 'app.png'), drawIcon(512));
writeFileSync(join(output, 'tray.png'), drawIcon(32));
console.log(`[icons] Wrote icons to ${output}`);
