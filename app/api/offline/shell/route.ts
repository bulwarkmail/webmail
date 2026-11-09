import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
/** Files a page can load: scripts, styles, fonts and the images they name. */
const SHELL_FILE = /\.(js|css|woff2?|svg|png|webp)$/;
/** The local store's engine in public/. */
const ENGINE_FILE = /\.(mjs|wasm)$/;

async function listFiles(dir: string, prefix: string, out: string[], wanted: RegExp = SHELL_FILE): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await listFiles(join(dir, entry.name), `${prefix}${entry.name}/`, out, wanted);
    else if (wanted.test(entry.name)) out.push(`${prefix}${entry.name}`);
  }
}

/**
 * The files of this build's app shell (#523): everything under
 * /_next/static/, which is the same for every user and content-hashed. A
 * tab with offline mode on hands the list to the service worker, which keeps
 * the files in this build's cache so the app also starts without a network.
 * The local store's worker and its database engine come along: without them
 * the store can't start offline. The worker's address carries the build id, as
 * the page asks for it (lib/store/client/api.ts).
 */
export async function GET() {
  const files: string[] = [];
  await listFiles(join(process.cwd(), '.next', 'static'), `${BASE_PATH}/_next/static/`, files);
  await listFiles(join(process.cwd(), 'public', 'sqlite3mc'), `${BASE_PATH}/sqlite3mc/`, files, ENGINE_FILE);
  const buildId = process.env.NEXT_PUBLIC_BUILD_ID ?? '';
  files.push(`${BASE_PATH}/store-worker.js${buildId ? `?v=${encodeURIComponent(buildId)}` : ''}`);
  return NextResponse.json(
    { buildId, files },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
