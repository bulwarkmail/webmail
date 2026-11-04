#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
let ref = 'main';
let publish = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ref' && args[i + 1]) ref = args[++i];
  else if (args[i] === '--publish') publish = true;
  else throw new Error('Usage: node .memail/sync-upstream.mjs [--ref main|release-tag] [--publish]');
}
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed.\n${result.stderr || result.stdout || ''}`);
  return (result.stdout || '').trim();
}
function git(...argv) { return run('git', argv); }
if (ref.startsWith('-')) throw new Error('Invalid upstream ref.');
git('check-ref-format', '--branch', ref);
const top = git('rev-parse', '--show-toplevel');
process.chdir(top);
if (git('status', '--porcelain')) throw new Error('Working tree must be clean, including untracked files. Commit or preserve your changes first.');
const expected = {
  origin: ['https://github.com/Saivra/memail-webmail.git', 'https://github.com/Saivra/memail-webmail', 'git@github.com:Saivra/memail-webmail.git'],
  upstream: ['https://github.com/bulwarkmail/webmail.git', 'https://github.com/bulwarkmail/webmail', 'git@github.com:bulwarkmail/webmail.git'],
};
for (const [remote, urls] of Object.entries(expected)) {
  const url = git('remote', 'get-url', remote).toLowerCase();
  if (!urls.some(allowed => allowed.toLowerCase() === url)) throw new Error(`Unexpected ${remote} URL. Check .memail/UPSTREAM.md before proceeding.`);
}
if (git('rev-parse', '--is-shallow-repository') === 'true') throw new Error('Fetch full history first: git fetch --unshallow upstream');
git('fetch', 'origin', 'main');
git('fetch', 'upstream', ref);
const sha = git('rev-parse', 'FETCH_HEAD^{commit}');
const contained = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { encoding: 'utf8' });
if (contained.status === 0) {
  console.log(`origin/main already contains Bulwark ${ref} (${sha}). No update needed.`);
  process.exit(0);
}
if (contained.status !== 1) throw new Error(contained.stderr || 'Could not compare upstream ancestry.');
const branch = `sync/bulwark-${sha.slice(0, 12)}`;
git('switch', '-c', branch, 'origin/main');
try {
  git('merge', '--no-ff', '-m', `chore(upstream): merge Bulwark ${ref} (${sha.slice(0, 12)})`, sha);
} catch (error) {
  console.error(`Stopped on ${branch}. Resolve the merge and commit, or run git merge --abort. No branch was pushed.`);
  throw error;
}
console.log(`Prepared ${branch} with Bulwark ${sha}. Review the diff and run .memail/UPSTREAM.md checks.`);
if (publish) {
  git('push', '-u', 'origin', branch);
  const directory = mkdtempSync(join(tmpdir(), 'memail-upstream-'));
  try {
    const body = join(directory, 'pr.md');
    writeFileSync(body, `Integrates Bulwark ref \`${ref}\` at \`${sha}\`, preserving upstream ancestry.\n\nReview the upstream changes and complete the checks in .memail/UPSTREAM.md before merging. Application validation has not been run by this helper.\n\nMerge with a merge commit; do not squash or rebase this update.\n`);
    console.log(run('gh', ['pr', 'create', '--repo', 'Saivra/memail-webmail', '--base', 'main', '--head', branch, '--draft', '--title', `chore(upstream): merge Bulwark ${ref}`, '--body-file', body]));
  } finally {
    const body = join(directory, 'pr.md');
    if (existsSync(body)) unlinkSync(body);
    rmdirSync(directory);
  }
}
