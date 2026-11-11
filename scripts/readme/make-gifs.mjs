// Builds README GIFs from PNG frames: scripts/readme/frames/<name>/<nn>_<delayMs>.png -> assets/<name>.gif
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const here = path.dirname(fileURLToPath(import.meta.url));
const framesDir = path.join(here, 'frames');
// Not "readme/": VS Code would take that folder for the extension's README.
const outDir = path.join(here, '..', '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

for (const name of fs.readdirSync(framesDir)) {
  const dir = path.join(framesDir, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
  if (!files.length) continue;
  const gif = GIFEncoder();
  let size;
  for (const f of files) {
    const png = PNG.sync.read(fs.readFileSync(path.join(dir, f)));
    size ??= [png.width, png.height];
    if (png.width !== size[0] || png.height !== size[1]) throw new Error(`${name}/${f}: frame size differs`);
    const delay = Number(/_(\d+)\.png$/.exec(f)?.[1] ?? 1200);
    const palette = quantize(png.data, 256);
    gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, { palette, delay });
  }
  gif.finish();
  const out = path.join(outDir, `${name}.gif`);
  fs.writeFileSync(out, gif.bytes());
  console.log(`${out}  ${files.length} frames  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}
