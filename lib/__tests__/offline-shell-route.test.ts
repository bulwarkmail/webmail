// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('the list of files a start without a network needs', () => {
  let dir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('names the store worker with its build id, and the database engine with its .mjs and .wasm', async () => {
    dir = mkdtempSync(join(os.tmpdir(), 'shell-'));
    mkdirSync(join(dir, '.next', 'static', 'chunks'), { recursive: true });
    writeFileSync(join(dir, '.next', 'static', 'chunks', 'app.js'), '');
    writeFileSync(join(dir, '.next', 'static', 'chunks', 'app.js.map'), '');
    mkdirSync(join(dir, 'public', 'sqlite3mc', '1.2'), { recursive: true });
    writeFileSync(join(dir, 'public', 'sqlite3mc', '1.2', 'sqlite3.mjs'), '');
    writeFileSync(join(dir, 'public', 'sqlite3mc', '1.2', 'sqlite3.wasm'), '');
    writeFileSync(join(dir, 'public', 'sqlite3mc', '1.2', 'LICENSE'), '');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('NEXT_PUBLIC_BUILD_ID', 'build a');

    const { GET } = await import('@/app/api/offline/shell/route');
    const { files, buildId } = await (await GET()).json() as { files: string[]; buildId: string };
    expect(buildId).toBe('build a');
    expect(files.sort()).toEqual([
      '/_next/static/chunks/app.js',
      '/sqlite3mc/1.2/sqlite3.mjs',
      '/sqlite3mc/1.2/sqlite3.wasm',
      '/store-worker.js?v=build%20a',
    ]);
  });
});
