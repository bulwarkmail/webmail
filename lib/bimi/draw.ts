import { spawn } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Drawing a sender's logo to a PNG. A small SVG can keep librsvg drawing for
 * a long time, and sharp draws on the libuv pool that every file read, DNS
 * lookup and zlib call of this process needs; a worker thread shares that
 * pool and can't be stopped while librsvg runs. So each logo is drawn in a
 * child process of its own. The child counts the drawing's time itself,
 * from when it has the logo, and ends itself when the logo draws past
 * DRAW_DEADLINE_MS: a server that is busy for a moment doesn't count
 * against the logo. The caller limits how many run at once (MAX_DRAWINGS).
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
/**
 * How much longer than its own deadline a child may go without an answer
 * before it is ended from here. A child does that only when something
 * other than the logo held it up, so that counts as "try again later".
 */
const STOP_MARGIN_MS = 5000;
/** A 192 px PNG is far below this. */
const MAX_PNG_BYTES = 1024 * 1024;

const IN_PROCESS = typeof process.versions.electron === 'string';
/** Logos drawn at once in this process. */
export const MAX_DRAWINGS = IN_PROCESS ? 1 : 2;

/**
 * A drawing that didn't produce a PNG. `temporary` when the logo isn't to
 * blame (no slot, the child couldn't start or load sharp, or it was given up
 * on from here because the server was busy), so it is worth another try
 * soon and is not remembered as "no logo". `neverStarted` when no drawing
 * process came up at all: until that is put right no logo is drawn, which
 * the operator has to hear about.
 */
export class LogoDrawingError extends Error {
  constructor(message: string, readonly temporary: boolean, readonly neverStarted = false) {
    super(message);
    this.name = 'LogoDrawingError';
  }
}

/**
 * The child: loads sharp, says "R", reads the SVG from stdin, and answers
 * "P" and the PNG. Past its own deadline it says "T" and ends at once (an
 * exit would wait for librsvg). The same steps as drawPng below. A string,
 * because the server bundle can't hand a file of its own to a child process.
 */
const CHILD_SOURCE = `
  const { createRequire } = require('node:module');
  const fs = require('node:fs');
  const path = require('node:path');
  let sharp = null;
  for (const dir of JSON.parse(process.argv[1])) {
    try { sharp = createRequire(path.join(dir, 'index.js'))('sharp'); break; } catch {}
  }
  if (!sharp) process.exit(3);
  sharp.cache(false);
  sharp.concurrency(1);
  const size = Number(process.argv[2]);
  const limit = Number(process.argv[3]);
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const timer = setTimeout(() => {
      try { fs.writeSync(1, 'T'); } catch {}
      process.kill(process.pid, 'SIGKILL');
    }, limit);
    const input = Buffer.concat(chunks);
    sharp(input).metadata().then((meta) => {
      const intrinsic = Math.max(1, Math.min(meta.width ?? size, meta.height ?? size));
      const density = Math.max(1, Math.min(2400, Math.ceil((72 * size) / intrinsic)));
      return sharp(input, { density, limitInputPixels: 4096 * 4096 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    }).then((png) => {
      clearTimeout(timer);
      process.stdout.write(Buffer.concat([Buffer.from('P'), png]), () => process.exit(0));
    }, () => {
      clearTimeout(timer);
      process.exit(2);
    });
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
      child = spawn(process.execPath, [
        '--max-old-space-size=128', '-e', CHILD_SOURCE, JSON.stringify(sharpSearchDirs()), String(INDICATOR_SIZE), String(DRAW_DEADLINE_MS),
      ], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: childEnv(),
        windowsHide: true,
      });
    } catch (err) {
      stop();
      reject(new LogoDrawingError(`drawing could not start: ${(err as Error).message}`, true, true));
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    // What the child has said: nothing yet, "R" (ready), then "P" (the PNG follows).
    let stage: 'starting' | 'drawing' | 'picture' = 'starting';
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
    timer = setTimeout(() => finish(new LogoDrawingError('drawing did not start in time', true, true)), START_DEADLINE_MS);

    child.on('error', (err) => {
      finish(new LogoDrawingError(`drawing could not start: ${err.message}`, true, stage === 'starting'));
      stop();
    });
    child.on('close', (code, signal) => {
      if (code === 0 && stage === 'picture' && received > 0) finish(null, Buffer.concat(chunks));
      else if (code === 3) finish(new LogoDrawingError('sharp could not be loaded for drawing', true, true));
      // It failed on the logo, or ended itself past its own deadline.
      else finish(new LogoDrawingError(`drawing failed (${code ?? signal})`, false));
      stop();
    });
    // The child exits without reading the rest when it fails.
    child.stdin!.on('error', () => {});
    child.stdout!.on('data', (data: Buffer) => {
      let chunk = data;
      if (stage === 'starting' && chunk.length > 0) {
        if (chunk[0] !== 0x52) {
          finish(new LogoDrawingError('drawing answered something else', false));
          return;
        }
        stage = 'drawing';
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(new LogoDrawingError('the drawing did not answer in time', true)),
          DRAW_DEADLINE_MS + STOP_MARGIN_MS,
        );
        chunk = chunk.subarray(1);
      }
      if (stage === 'drawing' && chunk.length > 0) {
        if (chunk[0] === 0x54) {
          finish(new LogoDrawingError(`gave up drawing after ${DRAW_DEADLINE_MS} ms`, false));
          return;
        }
        if (chunk[0] !== 0x50) {
          finish(new LogoDrawingError('drawing answered something else', false));
          return;
        }
        stage = 'picture';
        chunk = chunk.subarray(1);
      }
      if (stage !== 'picture') return;
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
    let settled = false;
    const timer = setTimeout(() => {
      // When this process was busy, the finished picture may be waiting
      // behind this timer: its callback runs before setImmediate's.
      setImmediate(() => {
        if (settled) return;
        settled = true;
        reject(new LogoDrawingError(`gave up drawing after ${DRAW_DEADLINE_MS} ms`, false));
      });
    }, DRAW_DEADLINE_MS);
    work.then(
      (png) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(png);
      },
      (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new LogoDrawingError(`drawing failed: ${err.message}`, false));
      },
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
