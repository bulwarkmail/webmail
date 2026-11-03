#!/usr/bin/env node
// The webmail build the desktop app embeds: `npm run build:desktop`. It's the
// regular standalone build with NEXT_PUBLIC_BULWARK_DESKTOP compiled in, using
// webpack (a third of Turbopack's server size, and its hashed external links
// don't relocate). No other build sets the flag: repos/desktop's
// scripts/fetch-webmail.mjs refuses a tree without it.

import { spawnSync } from 'node:child_process';

const env = { ...process.env, NEXT_PUBLIC_BULWARK_DESKTOP: '1', NEXT_TELEMETRY_DISABLED: '1' };
const isWindows = process.platform === 'win32';

for (const [command, ...args] of [
  ['node', 'scripts/build-pst-worker.mjs'],
  ['node', 'scripts/build-store-worker.mjs'],
  ['node', 'scripts/build-plugin-sandbox.mjs'],
  ['npx', 'next', 'build', '--webpack'],
  ['node', 'scripts/standalone-guard.mjs'],
]) {
  const run = spawnSync(command, args, { env, stdio: 'inherit', shell: isWindows });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
