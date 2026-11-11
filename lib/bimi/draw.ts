import { spawn } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Drawing a sender's logo to a PNG. A small SVG can keep librsvg drawing for
 * a long time, and sharp draws on the libuv pool that every file read, DNS
 * lookup and zlib call of this process needs; a worker thread shares that
 * pool and can't be stopped while librsvg runs. So each logo is drawn in a
 * child process of its own, which is killed when it draws past the
 * deadline. The caller limits how many run at once (MAX_DRAWINGS).
 *
 * The desktop app runs this server in an Electron utility process, which
 * can't start Node children (its runAsNode fuse is off). There the logo is
 * drawn in this process, one at a time, and `onStopped` fires only when
 * sharp has finished: a logo that draws for long holds one thread of the
 * pool, and the logos after it wait for that slot instead of taking more.
 */

/** Avatars are at most 48 CSS px; this covers 4x screens. */
export const INDICATOR_SIZE = 192;
/** How long one logo may draw. */
export const DRAW_DEADLINE_MS = 2000;
/** How long the child may take to load sharp before the drawing starts. */
const START_DEADLINE_MS = 10_000;
/** A 192 px PNG is far below this. */
const MAX_PNG_BYTES = 1024 * 1024;

const IN_PROCESS = typeof process.versions.electron === 'string';
/** Logos drawn at once in this process. */
export const MAX_DRAWINGS = IN_PROCESS ? 1 : 2;

/**
 * A drawing that didn't produce a PNG. `temporary` when it never started
 * (no slot, the child couldn't start or load sharp), so the logo itself
 * isn't to blame and is worth another try soon.
 */
export class LogoDrawingError extends Error {
  constructor(message: string, readonly temporary: boolean) {
    super(message);
    this.name = 'LogoDrawingError';
  }
}

/**
 * The child: loads sharp, says "R", reads the SVG from stdin and writes the
 * PNG to stdout. The same steps as drawPng below. A string, because the
 * server bundle can't hand a file of its own to a child process.
 */
const CHILD_SOURCE = `
  const { createRequire } = require('node:module');
  const path = require('node:path');
  let sharp = null;
  for (const dir of JSON.parse(process.argv[1])) {
    try { sharp = createRequire(path.join(dir, 'index.js'))('sharp'); break; } catch {}
  }
  if (!sharp) process.exit(3);
  sharp.cache(false);
  sharp.concurrency(1);
  const size = Number(process.argv[2]);
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const input = Buffer.concat(chunks);
    sharp(input).metadata().then((meta) => {
      const intrinsic = Math.max(1, Math.min(meta.width ?? size, meta.height ?? size));
      const density = Math.max(1, Math.min(2400, Math.ceil((72 * size) / intrinsic)));
      return sharp(input, { density, limitInputPixels: 4096 * 4096 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    }).then((png) => process.stdout.write(png, () => process.exit(0)), () => process.exit(2));
  });
  process.stdout.write('R');
`;

/** Where the child looks for sharp: the server's folder (standalone, next start) and the script's. */
function sharpSearchDirs(): string[] {
  const dirs = [process.cwd()];
  if (process.argv[1]) dirs.push(path.dirname(process.argv[1]));
  return dirs;
}

/** The child gets what Node and sharp need to start, none of the server's secrets. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function drawInChild(svg: string, onStopped: () => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      onStopped();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, ['--max-old-space-size=128', '-e', CHILD_SOURCE, JSON.stringify(sharpSearchDirs()), String(INDICATOR_SIZE)], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: childEnv(),
        windowsHide: true,
      });
    } catch (err) {
      stop();
      reject(new LogoDrawingError(`drawing could not start: ${(err as Error).message}`, true));
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let ready = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error: LogoDrawingError | null, png?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else {
        resolve(png!);
      }
    };
    timer = setTimeout(() => finish(new LogoDrawingError('drawing did not start in time', true)), START_DEADLINE_MS);

    child.on('error', (err) => {
      finish(new LogoDrawingError(`drawing could not start: ${err.message}`, true));
      stop();
    });
    child.on('close', (code) => {
      if (code === 0 && ready && received > 0) finish(null, Buffer.concat(chunks));
      else if (code === 3) finish(new LogoDrawingError('sharp could not be loaded for drawing', true));
      else finish(new LogoDrawingError(`drawing failed (${code ?? 'killed'})`, false));
      stop();
    });
    // The child exits without reading the rest when it fails.
    child.stdin!.on('error', () => {});
    child.stdout!.on('data', (data: Buffer) => {
      let chunk = data;
      if (!ready) {
        if (chunk[0] !== 0x52) {
          finish(new LogoDrawingError('drawing answered something else', false));
          return;
        }
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new LogoDrawingError(`gave up drawing after ${DRAW_DEADLINE_MS} ms`, false)), DRAW_DEADLINE_MS);
        chunk = chunk.subarray(1);
      }
      received += chunk.length;
      if (received > MAX_PNG_BYTES) {
        finish(new LogoDrawingError('drawing too large', false));
        return;
      }
      chunks.push(chunk);
    });
    child.stdin!.end(Buffer.from(svg, 'utf8'));
  });
}

/** The same steps as CHILD_SOURCE, in this process. */
async function drawPng(svg: string): Promise<Buffer> {
  const input = Buffer.from(svg, 'utf8');
  // librsvg draws at 72 dpi from the intrinsic size; raise the density so a
  // small viewBox isn't scaled up blurred, and cap it so a huge one doesn't
  // allocate a giant canvas.
  const meta = await sharp(input).metadata();
  const intrinsic = Math.max(1, Math.min(meta.width ?? INDICATOR_SIZE, meta.height ?? INDICATOR_SIZE));
  const density = Math.max(1, Math.min(2400, Math.ceil((72 * INDICATOR_SIZE) / intrinsic)));
  return sharp(input, { density, limitInputPixels: 4096 * 4096 })
    .resize(INDICATOR_SIZE, INDICATOR_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

function drawInProcess(svg: string, onStopped: () => void): Promise<Buffer> {
  const work = drawPng(svg);
  work.then(onStopped, onStopped);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LogoDrawingError(`gave up drawing after ${DRAW_DEADLINE_MS} ms`, false)), DRAW_DEADLINE_MS);
    work.then(
      (png) => { clearTimeout(timer); resolve(png); },
      (err: Error) => { clearTimeout(timer); reject(new LogoDrawingError(`drawing failed: ${err.message}`, false)); },
    );
  });
}

export interface RasterizeOptions {
  /**
   * Called once when the drawing has stopped for good: the child has exited,
   * or sharp has finished in this process. Later than the answer when the
   * drawing was given up on.
   */
  onStopped?: () => void;
}

/**
 * Draw the SVG to a square PNG of INDICATOR_SIZE pixels, away from this
 * process's thread pool. Rejects with a LogoDrawingError when the logo
 * fails to draw or draws for longer than DRAW_DEADLINE_MS.
 */
export function rasterize(svg: string, { onStopped = () => {} }: RasterizeOptions = {}): Promise<Buffer> {
  return IN_PROCESS ? drawInProcess(svg, onStopped) : drawInChild(svg, onStopped);
}
