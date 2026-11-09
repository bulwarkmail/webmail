// Fetches the pinned SQLite3MultipleCiphers WASM build into vendor/sqlite3mc/.
// Run it by hand when moving to a new version, and commit the result, so a
// Docker build needs no access to GitHub. Every download is checked against the
// pinned sha256: a changed artifact fails here.
//
//   node scripts/fetch-sqlite3mc.mjs           downloads and verifies
//   node scripts/fetch-sqlite3mc.mjs --check   verifies what is committed
//
// Fixes for bugs #291-#294 are on trunk, not in a release yet. Check the rules
// in lib/store/adapters/wasm.ts when moving to a newer build, and never go below 2.6.0.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SQLITE3MC = {
  version: '2.6.1-3.54.0',
  tag: 'v2.6.1',
  zip: 'sqlite3mc-2.6.1-sqlite-3.54.0-wasm.zip',
  zipSha256: 'aba121490fd6123bcbef8404ee26df9b26c0301063781e2aa31f05aed6f48384',
  innerDir: 'sqlite3mc-wasm-3540000/jswasm',
  files: {
    'sqlite3.mjs': '5308c7cc857408697c657a8d314e647a6f31c4aee67974ab8efd80c1a07161e0',
    'sqlite3.wasm': '0b5a4bfff35f1ec87bf6f68ea293f425b86cbd661b77628a955cb827c9fbf524',
  },
};

export const SQLITE3MC_VENDOR_DIR = path.join(root, 'vendor', 'sqlite3mc', SQLITE3MC.version);

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** Throws unless the committed files match their pins. */
export function verifyVendored(dir = SQLITE3MC_VENDOR_DIR) {
  for (const [name, expected] of Object.entries(SQLITE3MC.files)) {
    const actual = sha256(readFileSync(path.join(dir, name)));
    if (actual !== expected) throw new Error(`[sqlite3mc] ${name}: expected ${expected}, got ${actual}`);
  }
  readFileSync(path.join(dir, 'LICENSE'));
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`[sqlite3mc] ${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchAndVendor() {
  const base = `https://github.com/utelle/SQLite3MultipleCiphers/releases/download/${SQLITE3MC.tag}`;
  const zip = await download(`${base}/${SQLITE3MC.zip}`);
  const actual = sha256(zip);
  if (actual !== SQLITE3MC.zipSha256) throw new Error(`[sqlite3mc] zip: expected ${SQLITE3MC.zipSha256}, got ${actual}`);
  const entries = unzipSync(zip);
  mkdirSync(SQLITE3MC_VENDOR_DIR, { recursive: true });
  for (const name of Object.keys(SQLITE3MC.files)) {
    const entry = entries[`${SQLITE3MC.innerDir}/${name}`];
    if (!entry) throw new Error(`[sqlite3mc] ${name} is not in the zip`);
    writeFileSync(path.join(SQLITE3MC_VENDOR_DIR, name), entry);
  }
  // The zip has no licence file.
  const license = await download(`https://raw.githubusercontent.com/utelle/SQLite3MultipleCiphers/${SQLITE3MC.tag}/LICENSE`);
  writeFileSync(path.join(SQLITE3MC_VENDOR_DIR, 'LICENSE'), license);
  verifyVendored();
  console.log(`[fetch-sqlite3mc] vendored ${SQLITE3MC.version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    verifyVendored();
    console.log('[fetch-sqlite3mc] ok');
  } else {
    await fetchAndVendor();
  }
}
