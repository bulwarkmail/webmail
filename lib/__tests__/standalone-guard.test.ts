// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  findForbidden,
  guardStandalone,
  isTraceFileAllowed,
  pruneTraces,
} from '../../scripts/standalone-guard.mjs';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/standalone-guard.mjs');
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'standalone-guard-'));
  temps.push(dir);
  return dir;
}

function put(root: string, rel: string, body = 'x'): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('the desktop trust path', () => {
  it('fails a server build that still holds it', () => {
    const dir = tempDir();
    put(dir, 'server.js');
    put(dir, '.next/server/chunks/123.js', 'holder[Symbol.for("bulwark.desktop.trustedJmapOrigins")]');
    expect(guardStandalone(dir, { desktopBuild: false })).toEqual(['.next/server/chunks/123.js (desktop trust path in a server build)']);
  });

  it('passes the desktop build itself', () => {
    const dir = tempDir();
    put(dir, 'server.js');
    put(dir, '.next/server/chunks/123.js', 'holder[Symbol.for("bulwark.desktop.trustedJmapOrigins")]');
    expect(guardStandalone(dir, { desktopBuild: true })).toEqual([]);
  });

  it('fails the command line check on a server build', () => {
    const dir = tempDir();
    put(dir, 'server.js');
    put(dir, '.next/server/chunks/123.js', 'bulwark.desktop.trustedJmapOrigins');
    const env = { ...process.env };
    delete env.NEXT_PUBLIC_BULWARK_DESKTOP;
    const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('desktop trust path');
  });
});

describe('standalone guard check', () => {
  it('fails the build on a planted signing key', () => {
    const dir = tempDir();
    put(dir, 'server.js');
    put(dir, 'data/admin/plugin-signing.key', 'FAKE');
    const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('data/');
  });

  it('passes a clean tree', () => {
    const dir = tempDir();
    put(dir, 'server.js');
    put(dir, 'package.json');
    put(dir, 'public/icon.png');
    put(dir, '.next/server/app/api/data/route.js');
    put(dir, 'node_modules/some-package/data/table.json');
    const run = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it.each([
    'data/admin/admin.json',
    'local-data/notes.md',
    'repos/plugins/index.js',
    '.env.local',
    'lib/plugin-signing.key',
  ])('finds %s', (rel) => {
    const dir = tempDir();
    put(dir, 'server.js');
    put(dir, rel);
    expect(findForbidden(dir)).toHaveLength(1);
  });

  it('finds them when the project is nested under the tracing root', () => {
    const dir = tempDir();
    put(dir, 'worktrees/webmail/server.js');
    put(dir, 'worktrees/webmail/data/admin/plugin-signing.key');
    expect(findForbidden(dir)).toEqual(['worktrees/webmail/data/']);
  });

  it('removes the .env files Next copies next to server.js, then passes', () => {
    const dir = tempDir();
    put(dir, 'worktrees/webmail/server.js');
    put(dir, 'worktrees/webmail/.env', 'SECRET=1');
    put(dir, 'worktrees/webmail/.env.production', 'SECRET=1');
    expect(guardStandalone(dir)).toEqual([]);
    expect(existsSync(path.join(dir, 'worktrees/webmail/.env'))).toBe(false);
    expect(existsSync(path.join(dir, 'worktrees/webmail/.env.production'))).toBe(false);
  });

  it('does not remove a .env.local, which Next never copies, and reports it', () => {
    const dir = tempDir();
    put(dir, 'server.js');
    put(dir, '.env.local', 'SECRET=1');
    expect(guardStandalone(dir)).toEqual(['.env.local']);
  });
});

describe('trace pruning', () => {
  const project = path.resolve('/project');

  it.each([
    ['node_modules/next/dist/server.js', true],
    ['.next/server/chunks/1.js', true],
    ['public/icon.png', true],
    ['package.json', true],
    ['data/admin/plugin-signing.key', false],
    ['local-data/notes.md', false],
    ['repos/plugins/index.js', false],
    ['.env', false],
    ['.git/config', false],
    ['lib/admin/paths.ts', false],
  ])('%s allowed: %s', (rel, allowed) => {
    expect(isTraceFileAllowed(path.join(project, rel), project)).toBe(allowed);
  });

  it('keeps a node_modules outside the project and nothing else from there', () => {
    expect(isTraceFileAllowed(path.resolve('/elsewhere/node_modules/next/x.js'), project)).toBe(true);
    expect(isTraceFileAllowed(path.resolve('/elsewhere/secrets.txt'), project)).toBe(false);
  });

  it('rewrites a trace without the planted files', () => {
    const projectDir = tempDir();
    const distDir = path.join(projectDir, '.next');
    const trace = path.join(distDir, 'server/middleware.js.nft.json');
    put(
      projectDir,
      '.next/server/middleware.js.nft.json',
      JSON.stringify({
        version: 1,
        files: ['../../data/admin/plugin-signing.key', '../../.env', '../../node_modules/next/index.js', 'chunks/1.js'],
      }),
    );
    expect(pruneTraces({ distDir, projectDir })).toBe(2);
    expect(JSON.parse(readFileSync(trace, 'utf8'))).toEqual({
      version: 1,
      files: ['../../node_modules/next/index.js', 'chunks/1.js'],
    });
  });

  it('keeps Turbopack hashes and symlink indexes on the right files', () => {
    const projectDir = tempDir();
    const distDir = path.join(projectDir, '.next');
    const trace = path.join(distDir, 'server/middleware.js.nft.json');
    put(
      projectDir,
      '.next/server/middleware.js.nft.json',
      JSON.stringify({
        version: 1,
        files: ['../../data/x', '../../node_modules/a', '../../repos/y', '../node_modules/esbuild-1', '../../data/link'],
        fileHashes: ['h0', 'h1', 'h2', 'h3', 'h4'],
        symlinks: [
          [3, '../../node_modules/esbuild'],
          [4, '../../outside'],
        ],
      }),
    );
    expect(pruneTraces({ distDir, projectDir })).toBe(3);
    expect(JSON.parse(readFileSync(trace, 'utf8'))).toEqual({
      version: 1,
      files: ['../../node_modules/a', '../node_modules/esbuild-1'],
      fileHashes: ['h1', 'h3'],
      symlinks: [[1, '../../node_modules/esbuild']],
    });
  });

  it('leaves unreadable traces alone instead of failing mid-build', () => {
    const projectDir = tempDir();
    put(projectDir, '.next/server/page.js.nft.json', '{ half written');
    expect(pruneTraces({ distDir: path.join(projectDir, '.next'), projectDir })).toBe(0);
  });
});

describe('build wiring', () => {
  it('prunes after compiling and checks after every standalone build', () => {
    const config = readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8');
    expect(config).toMatch(/runAfterProductionCompile[\s\S]*pruneTraces/);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toMatch(/next build[^&]*&& node scripts\/standalone-guard\.mjs/);
    expect(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')).toMatch(
      /next build --webpack[\s\S]{0,40}node scripts\/standalone-guard\.mjs/,
    );
    expect(readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')).toContain('!scripts/standalone-guard.mjs');
    expect(readFileSync(path.join(ROOT, '.github/workflows/standalone-release.yml'), 'utf8')).toMatch(/run: npm run build/);
  });
});
