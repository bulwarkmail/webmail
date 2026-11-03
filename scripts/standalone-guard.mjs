#!/usr/bin/env node
// Keeps a checkout's private state out of .next/standalone.
//
// The trace follows fs reads, and the server reads its state directories
// relative to cwd, so a build from a checkout that has been run copies the
// admin password hash, the plugin signing key, the audit log and .env secrets
// into the standalone tree, and from there into whatever ships it.
// outputFileTracingExcludes doesn't stop this:
//  - Turbopack never applies it to the middleware and instrumentation traces,
//    which cover the whole project, and misses "!(next-server)" per route.
//  - Webpack builds the exclude globs with path.join, so on Windows they hold
//    backslashes and match nothing.
//  - Next copies .env and .env.production into standalone on its own.
// So next.config.ts prunes the traces right after compiling (pruneTraces), and
// every build ends with `node scripts/standalone-guard.mjs`, which removes the
// .env copies and fails if anything forbidden is left.

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DESKTOP_TRUST_MARKER, desktopBuildFlag } from './desktop-build-flag.mjs';

/** Top-level project entries the running server needs. Traces drop the rest. */
const TRACE_ALLOWED = new Set(['node_modules', '.next', 'public', 'locales', 'package.json', 'VERSION']);

/** Never in a standalone tree, wherever it sits outside node_modules. */
const FORBIDDEN_DIRS = new Set(['data', 'local-data', 'repos']);
const FORBIDDEN_FILE = /^(\.env.*|plugin-signing\.key)$/;

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Whether a traced file belongs in the build. `abs` is its absolute path. */
export function isTraceFileAllowed(abs, projectDir) {
  const rel = toPosix(path.relative(projectDir, abs));
  if (rel === '') return true;
  const segments = rel.split('/');
  // Outside the project: a junctioned or hoisted node_modules, nothing else.
  if (segments[0] === '..' || path.isAbsolute(rel)) return segments.includes('node_modules');
  return TRACE_ALLOWED.has(segments[0]);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Drops files from a trace in place. Turbopack's fileHashes run parallel to
 * files and its symlinks point at file indexes, so those move along.
 */
function pruneTraceList(list, dir, projectDir) {
  const indexMap = new Map();
  const files = [];
  const fileHashes = Array.isArray(list.fileHashes) ? [] : undefined;
  list.files.forEach((entry, index) => {
    if (!isTraceFileAllowed(path.resolve(dir, entry), projectDir)) return;
    indexMap.set(index, files.length);
    files.push(entry);
    fileHashes?.push(list.fileHashes[index]);
  });
  const dropped = list.files.length - files.length;
  if (dropped === 0) return 0;
  list.files = files;
  if (fileHashes) list.fileHashes = fileHashes;
  if (Array.isArray(list.symlinks)) {
    list.symlinks = list.symlinks
      .filter(([index]) => indexMap.has(index))
      .map(([index, ...rest]) => [indexMap.get(index), ...rest]);
  }
  return dropped;
}

/** Rewrites every *.nft.json under distDir without the files that must not ship. */
export function pruneTraces({ distDir, projectDir }) {
  let removed = 0;
  for (const file of walk(distDir)) {
    if (!file.endsWith('.nft.json')) continue;
    // standalone holds copies from an earlier build, cache holds Next's own.
    if (/[\\/]\.next[\\/](standalone|cache|dev)[\\/]/.test(file)) continue;
    let trace;
    try {
      trace = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // Webpack's trace worker may be rewriting it. The final check still runs.
      continue;
    }
    if (!Array.isArray(trace.files)) continue;
    const dropped = pruneTraceList(trace, path.dirname(file), projectDir);
    if (dropped === 0) continue;
    removed += dropped;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(trace));
    renameSync(tmp, file);
  }
  return removed;
}

/** Everything forbidden in a standalone tree, as paths relative to it. */
export function findForbidden(standaloneDir) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Packages may hold anything, and .next/server has routes named after data.
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        if (FORBIDDEN_DIRS.has(entry.name)) found.push(toPosix(path.relative(standaloneDir, full)) + '/');
        else visit(full);
      } else if (FORBIDDEN_FILE.test(entry.name)) {
        found.push(toPosix(path.relative(standaloneDir, full)));
      }
    }
  };
  visit(standaloneDir);
  return found.sort();
}

/** Removes the .env files Next copies next to server.js on its own. */
export function removeCopiedEnvFiles(standaloneDir) {
  const removed = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
        visit(path.join(dir, entry.name));
      }
    }
    if (!existsSync(path.join(dir, 'server.js'))) return;
    for (const name of ['.env', '.env.production']) {
      const file = path.join(dir, name);
      if (existsSync(file)) {
        rmSync(file);
        removed.push(toPosix(path.relative(standaloneDir, file)));
      }
    }
  };
  visit(standaloneDir);
  return removed;
}

/**
 * Server bundles that still hold the desktop app's trust path. A server build
 * compiles it away (lib/desktop/flag.ts); finding it means the flag leaked into
 * this build or stopped being inlined, and a visitor could reach private hosts.
 */
export function findDesktopTrustPath(standaloneDir) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(full);
      } else if (entry.name.endsWith('.js') && readFileSync(full, 'utf8').includes(DESKTOP_TRUST_MARKER)) {
        found.push(`${toPosix(path.relative(standaloneDir, full))} (desktop trust path in a server build)`);
      }
    }
  };
  visit(standaloneDir);
  return found.sort();
}

/** Cleans and checks a standalone tree. Returns what is still wrong with it. */
export function guardStandalone(standaloneDir, { desktopBuild = desktopBuildFlag() === '1' } = {}) {
  removeCopiedEnvFiles(standaloneDir);
  const forbidden = findForbidden(standaloneDir);
  return desktopBuild ? forbidden : [...forbidden, ...findDesktopTrustPath(standaloneDir)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const standaloneDir = path.resolve(process.argv[2] ?? '.next/standalone');
  if (!existsSync(standaloneDir)) {
    console.error(`[standalone-guard] ${standaloneDir} does not exist`);
    process.exit(1);
  }
  const forbidden = guardStandalone(standaloneDir);
  if (forbidden.length > 0) {
    console.error(`[standalone-guard] private files in ${standaloneDir}:`);
    for (const file of forbidden.slice(0, 50)) console.error(`  ${file}`);
    if (forbidden.length > 50) console.error(`  ... and ${forbidden.length - 50} more`);
    console.error('[standalone-guard] do not ship this build. See scripts/standalone-guard.mjs.');
    process.exit(1);
  }
  console.log('[standalone-guard] ok');
}
