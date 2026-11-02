// Builds the Outlook PST import worker (lib/mail-import/pst/worker.ts) into
// public/pst-worker.js. The page loads it only when someone imports a .pst
// or .ost file (lib/mail-import/pst-source.ts).
//
// pst-extractor is written for Node: it needs Buffer, `fs` (only to read the
// file in pieces), `zlib` (only to inflate OST 2013 blocks) and iconv-lite
// (only to decode text in a codepage). In the worker those become the
// `buffer` package, a File-backed fs, fflate and TextDecoder; iconv-lite's
// tables alone would be three times the rest of the worker.
//
//   node scripts/build-pst-worker.mjs   (npm run build, npm run dev, npm run build:lite)

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PST_WORKER_OUTFILE = path.join(root, 'public', 'pst-worker.js');

export async function buildPstWorker({ outfile = PST_WORKER_OUTFILE } = {}) {
  const shims = path.join(root, 'lib/mail-import/pst/shims');
  const result = await build({
    entryPoints: [path.join(root, 'lib/mail-import/pst/worker.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    outfile,
    minify: true,
    // The licences of pst-extractor, buffer, fflate and long stay with their code.
    legalComments: 'eof',
    alias: {
      '@': root,
      fs: path.join(shims, 'fs.ts'),
      zlib: path.join(shims, 'zlib.ts'),
      'iconv-lite': path.join(shims, 'iconv.ts'),
    },
    inject: [path.join(shims, 'buffer.ts')],
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    metafile: true,
    logLevel: 'warning',
  });
  return { bytes: Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0), inputs: Object.keys(result.metafile.inputs) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bytes } = await buildPstWorker();
  console.log(`[build-pst-worker] ${path.relative(root, PST_WORKER_OUTFILE)} ${bytes}`);
}
