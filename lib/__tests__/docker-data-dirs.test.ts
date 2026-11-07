// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Everything the server keeps lives under /app/data. The compose file has to
// persist all of it, and the image has to create each dir for the app user,
// or a fresh volume on one of them comes up root-owned and unwritable.

const ROOT = path.resolve(__dirname, '../..');

function libFiles(dir = path.join(ROOT, 'lib'), out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) libFiles(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Default data dirs named in the source: <cwd>/data/<dir>, and plugin-secrets next to settings. */
function defaultDataDirs(): string[] {
  const dirs = new Set<string>();
  for (const file of libFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/cwd\(\),\s*'data',\s*'([a-z-]+)'/g)) dirs.add(m[1]);
    for (const m of text.matchAll(/'\.\.',\s*'([a-z-]+)'\)/g)) dirs.add(m[1]);
  }
  return [...dirs].sort();
}

describe('docker data dirs', () => {
  it('finds the data dirs in the source', () => {
    expect(defaultDataDirs()).toEqual(
      expect.arrayContaining(['admin', 'admin-state', 'plugin-secrets', 'settings', 'telemetry', 'version-check']),
    );
  });

  it('creates every data dir in the image for the app user', () => {
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const run = dockerfile.match(/RUN mkdir -p ([^&]+)&&[\s\S]*?chown -R nextjs:0[^\n]*\/app\/data/);
    expect(run).not.toBeNull();
    const created = run![1].split(/[\s\\]+/).filter(Boolean);
    for (const dir of defaultDataDirs()) expect(created).toContain(`/app/data/${dir}`);
  });

  it('lets any uid in group 0 write the data dirs and the cache (#1569)', () => {
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/chown -R nextjs:0 \/app\/\.next\/cache \/app\/data/);
    expect(dockerfile).toMatch(/chmod -R g=u \/app\/\.next\/cache \/app\/data/);
  });

  it('persists every data dir in docker-compose.yml, by its own volume or one on /app/data', () => {
    const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const mounts = [...compose.matchAll(/^\s*-\s*[\w.-]+:(\/app\/data[^\s:]*)/gm)].map((m) => m[1].replace(/\/+$/, ''));
    expect(mounts.length).toBeGreaterThan(0);
    const unpersisted = defaultDataDirs().filter(
      (dir) => !mounts.includes('/app/data') && !mounts.includes(`/app/data/${dir}`),
    );
    expect(unpersisted).toEqual([]);
  });
});

describe('.env.example', () => {
  it('shows a session secret sample long enough to be accepted', () => {
    const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const sample = example.match(/^#\s*SESSION_SECRET=(\S+)/m);
    expect(sample).not.toBeNull();
    expect(sample![1].length).toBeGreaterThanOrEqual(32);
    expect(example).toContain('openssl rand -hex 32');
  });
});
