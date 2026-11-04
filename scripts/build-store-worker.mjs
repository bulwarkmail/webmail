// Builds the local store's worker (lib/store/worker/worker.ts) into
// public/store-worker.js and copies the vendored SQLite3MultipleCiphers build
// next to it, in a folder named after its version: emscripten looks for the
// literal name sqlite3.wasm, so the files can't have hashed names.
// Both go through proxy.ts's static asset rule, which keeps the page CSP off
// them: wasm compiles under the worker's own response headers.
//
//   node scripts/build-store-worker.mjs   (npm run build, npm run dev)

import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLITE3MC, SQLITE3MC_VENDOR_DIR, verifyVendored } from './fetch-sqlite3mc.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STORE_WORKER_OUTFILE = path.join(root, 'public', 'store-worker.js');
export const SQLITE3MC_PUBLIC_DIR = path.join(root, 'public', 'sqlite3mc', SQLITE3MC.version);

export async function buildStoreWorker({ outfile = STORE_WORKER_OUTFILE, publicDir = SQLITE3MC_PUBLIC_DIR } = {}) {
  verifyVendored();
  mkdirSync(publicDir, { recursive: true });
  for (const name of [...Object.keys(SQLITE3MC.files), 'LICENSE']) {
    copyFileSync(path.join(SQLITE3MC_VENDOR_DIR, name), path.join(publicDir, name));
  }
  const result = await build({
    entryPoints: [path.join(root, 'lib/store/worker/worker.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile,
    minify: true,
    legalComments: 'none',
    alias: { '@': root },
    define: { 'process.env.NODE_ENV': '"production"' },
    metafile: true,
    logLevel: 'warning',
  });
  return { bytes: Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bytes } = await buildStoreWorker();
  console.log(`[build-store-worker] ${path.relative(root, STORE_WORKER_OUTFILE)} ${bytes}`);
}
