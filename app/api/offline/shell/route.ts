import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
/** Files a page can load: scripts, styles, fonts and the images they name. */
const SHELL_FILE = /\.(js|css|woff2?|svg|png|webp)$/;

async function listFiles(dir: string, prefix: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await listFiles(join(dir, entry.name), `${prefix}${entry.name}/`, out);
    else if (SHELL_FILE.test(entry.name)) out.push(`${prefix}${entry.name}`);
  }
}

/**
 * The files of this build's app shell (#523): everything under
 * /_next/static/, which is the same for every user and content-hashed. A
 * tab with offline mode on hands the list to the service worker, which keeps
 * the files in this build's cache so the app also starts without a network.
 */
export async function GET() {
  const files: string[] = [];
  await listFiles(join(process.cwd(), '.next', 'static'), `${BASE_PATH}/_next/static/`, files);
  return NextResponse.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? '', files },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
