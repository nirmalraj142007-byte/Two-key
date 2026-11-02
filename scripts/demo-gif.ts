/**
 * npm run demo:gif -- <video.webm> [more.webm …]
 *
 * Turns Playwright videos of e2e/failure.spec.ts into docs/demo.gif (at most 4 MB):
 *
 *   E2E_SANDBOX=1 PW_VIDEO=on npx playwright test e2e/failure.spec.ts -c apps/web --output=<dir>
 *   npm run demo:gif -- <dir>/…attack…/video.webm <dir>/…anomaly…/video.webm
 *
 * ffmpeg (on PATH, FFMPEG_PATH, or the build Playwright installs for video) extracts PNG frames;
 * gifenc encodes them with one shared palette. Repeated frames become one longer frame.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

// gifenc is CommonJS without detectable named exports.
const { applyPalette, GIFEncoder, quantize } = gifenc;

const MAX_BYTES = 4 * 1024 * 1024;
const OUT = new URL('../docs/demo.gif', import.meta.url);
/** Tried in order until the GIF fits. */
const SETTINGS = [
  { width: 800, fps: 5 },
  { width: 720, fps: 4 },
  { width: 640, fps: 4 },
  { width: 640, fps: 3 },
];
const HOLD_LAST_MS = 1500;

function findFfmpeg(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (spawnSync('ffmpeg', ['-version']).status === 0) return 'ffmpeg';
  const base = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'ms-playwright')
    : join(
        process.env.HOME ?? '',
        process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright',
      );
  const dirs = existsSync(base)
    ? readdirSync(base)
        .filter((d) => d.startsWith('ffmpeg-'))
        .sort()
    : [];
  for (const d of dirs.reverse()) {
    for (const exe of ['ffmpeg-win64.exe', 'ffmpeg-linux', 'ffmpeg-mac']) {
      if (existsSync(join(base, d, exe))) return join(base, d, exe);
    }
  }
  throw new Error('No ffmpeg found: set FFMPEG_PATH or run npx playwright install ffmpeg');
}

interface Frame {
  rgba: Uint8Array;
  width: number;
  height: number;
  delay: number;
}

function extract(ffmpeg: string, video: string, width: number, fps: number): Frame[] {
  const dir = mkdtempSync(join(tmpdir(), 'demo-gif-'));
  try {
    const r = spawnSync(
      ffmpeg,
      [
        '-loglevel',
        'error',
        '-i',
        video,
        '-r',
        String(fps),
        '-vf',
        `scale=${width}:-2`,
        join(dir, 'f_%05d.png'),
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`ffmpeg failed on ${video}: ${r.stderr}`);
    const frames = readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort()
      .map((f) => {
        const png = PNG.sync.read(readFileSync(join(dir, f)));
        const frame = {
          rgba: new Uint8Array(png.data),
          width: png.width,
          height: png.height,
          delay: 1000 / fps,
        };
        hideDevBadge(frame);
        return frame;
      });
    // Drop the blank frames before the first page paints.
    const start = frames.findIndex((f) => !isBlank(f));
    return start < 0 ? [] : frames.slice(start);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when every pixel is the first pixel's colour. */
function isBlank(f: Frame): boolean {
  const { rgba } = f;
  for (let i = 4; i < rgba.length; i += 4) {
    if (rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] || rgba[i + 2] !== rgba[2]) return false;
  }
  return true;
}

/**
 * The recording comes from `next dev`, which draws its round dev-tools badge in the bottom-left
 * corner. Paint that corner with the page background next to it so no framework logo shows.
 */
function hideDevBadge(f: Frame): void {
  // The badge sits about 20 px from the left and bottom of a 1280-px-wide viewport; a margin covers its shadow.
  const k = f.width / 1280;
  const x0 = Math.floor(14 * k);
  const x1 = Math.ceil(72 * k);
  const y0 = f.height - Math.ceil(72 * k);
  const y1 = f.height - Math.floor(8 * k);
  const px = (x: number, y: number) => (y * f.width + x) * 4;
  for (let y = y0; y < y1; y++) {
    // The page margin left of the badge, on the same row.
    const src = px(Math.max(0, x0 - 4), y);
    for (let x = x0; x < x1; x++) {
      const p = px(x, y);
      for (let c = 0; c < 4; c++) f.rgba[p + c] = f.rgba[src + c] as number;
    }
  }
}

function encode(clips: Frame[][]): Uint8Array {
  const all = clips.flat();
  const first = all[0];
  if (!first) throw new Error('No frames extracted');
  // One palette from a sample of frames across all clips.
  const step = Math.max(1, Math.floor(all.length / 12));
  const sample = all.filter((_, i) => i % step === 0);
  const pixels = new Uint8Array(sample.reduce((n, f) => n + f.rgba.length, 0));
  let at = 0;
  for (const f of sample) {
    pixels.set(f.rgba, at);
    at += f.rgba.length;
  }
  const palette = quantize(pixels, 256);
  const gif = GIFEncoder();
  for (const clip of clips) {
    const last = clip.at(-1);
    if (last) last.delay += HOLD_LAST_MS;
    let prev: Uint8Array | null = null;
    let pending: { index: Uint8Array; delay: number; width: number; height: number } | null = null;
    const flush = () => {
      if (pending) {
        gif.writeFrame(pending.index, pending.width, pending.height, {
          palette,
          delay: Math.round(pending.delay),
        });
      }
    };
    for (const f of clip) {
      const index = applyPalette(f.rgba, palette);
      if (pending && prev && Buffer.compare(Buffer.from(prev), Buffer.from(index)) === 0) {
        pending.delay += f.delay;
        continue;
      }
      flush();
      pending = { index, delay: f.delay, width: f.width, height: f.height };
      prev = index;
    }
    flush();
  }
  gif.finish();
  return gif.bytes();
}

const videos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (videos.length === 0) {
  console.error('usage: npm run demo:gif -- <video.webm> [more.webm …]');
  process.exit(1);
}
const ffmpeg = findFfmpeg();
for (const s of SETTINGS) {
  const bytes = encode(videos.map((v) => extract(ffmpeg, v, s.width, s.fps)));
  const mb = (bytes.length / 1024 / 1024).toFixed(2);
  if (bytes.length <= MAX_BYTES) {
    writeFileSync(OUT, bytes);
    console.log(
      `wrote docs/demo.gif: ${mb} MB, ${s.width}px wide, ${s.fps} fps, ${videos.length} clip(s)`,
    );
    process.exit(0);
  }
  console.log(`${s.width}px at ${s.fps} fps is ${mb} MB (over 4 MB); trying smaller`);
}
console.error('Could not fit the GIF under 4 MB');
process.exit(1);
