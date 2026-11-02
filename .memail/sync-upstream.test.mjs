import process from 'node:process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

// Exercise real local Git histories. Only the two allowed remote endpoints are
// substituted in a temporary copy; no test fetches or pushes a public remote.
test('sync helper preserves both histories and refuses unsafe starting states', () => {
  const directory = mkdtempSync(join(tmpdir(), 'memail-sync-test-'));
  const origin = join(directory, 'origin.git').replaceAll('\\', '/');
  const upstream = join(directory, 'upstream.git').replaceAll('\\', '/');
  const seed = join(directory, 'seed');
  const checkout = join(directory, 'checkout');
  function git(cwd, ...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=NUL', ...args], {cwd, encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  }
  try {
    git(directory, 'init', '--bare', '--initial-branch=main', origin);
    git(directory, 'init', '--bare', '--initial-branch=main', upstream);
    git(directory, 'init', '--initial-branch=main', seed);
    git(seed, 'config', 'user.name', 'Memail test');
    git(seed, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(join(seed, 'base.txt'), 'base\n');
    git(seed, 'add', '.'); git(seed, 'commit', '-m', 'base');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'remote', 'add', 'upstream', upstream);
    git(seed, 'push', 'origin', 'main'); git(seed, 'push', 'upstream', 'main');
    git(directory, 'clone', origin, checkout);
    git(checkout, 'config', 'user.name', 'Memail test');
    git(checkout, 'config', 'user.email', 'test@example.invalid');
    git(checkout, 'remote', 'add', 'upstream', upstream);
    const source = readFileSync(fileURLToPath(new URL('./sync-upstream.mjs', import.meta.url)), 'utf8');
    const helper = join(directory, 'helper.mjs');
    writeFileSync(helper, source.replace("'https://github.com/Saivra/memail.git'", JSON.stringify(origin)).replace("'https://github.com/bulwarkmail/webmail.git'", JSON.stringify(upstream)));
    const invoke = (...args) => spawnSync(process.execPath, [helper, ...args], {cwd: checkout, encoding:'utf8'});
    assert.match(invoke().stdout, /No update needed/);
    writeFileSync(join(checkout, 'dirty.txt'), 'keep me');
    assert.notEqual(invoke().status, 0);
    assert.equal(readFileSync(join(checkout, 'dirty.txt'), 'utf8'), 'keep me');
    git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'Memail customization');
    git(checkout, 'push', 'origin', 'main');
    const downstreamCommit = git(checkout, 'rev-parse', 'HEAD');
    writeFileSync(join(seed, 'upstream.txt'), 'new feature\n');
    git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Bulwark feature');
    git(seed, 'push', 'upstream', 'main');
    const upstreamCommit = git(seed, 'rev-parse', 'HEAD');
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prepared sync\/bulwark-/);
    assert.equal(git(checkout, 'rev-parse', 'HEAD^1'), downstreamCommit);
    assert.equal(git(checkout, 'rev-parse', 'HEAD^2'), upstreamCommit);
    assert.equal(readFileSync(join(checkout, 'dirty.txt'), 'utf8'), 'keep me');
    assert.equal(readFileSync(join(checkout, 'upstream.txt'), 'utf8'), 'new feature\n');
    assert.equal(git(checkout, 'rev-parse', 'origin/main'), downstreamCommit);
    assert.notEqual(invoke('--ref', '--invalid').status, 0);
    git(checkout, 'remote', 'set-url', 'upstream', origin);
    assert.match(invoke().stderr, /Unexpected upstream URL/);
  } finally {
    const child = relative(tmpdir(), directory);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    rmSync(directory, {recursive:true, force:true});
  }
});
