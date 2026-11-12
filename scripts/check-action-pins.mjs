#!/usr/bin/env node
// Fails (exit 1) while a workflow or composite action in the repo:
//   - uses an action that is not pinned to a full commit SHA (or a docker:// image without a
//     digest), in any YAML form, or runs a tool straight off the network (`curl | sh`,
//     `npx --yes`, `npm install <names>`);
//   - hands a secret or a write token to code from outside. The events that count: those that run
//     a pull request's code (pull_request, pull_request_review, pull_request_review_comment),
//     issue_comment (anyone can start it), and workflow_run when it follows a workflow one of
//     those events starts, follows a workflow it can't find, or uses the triggering run's head.
//     A step whose `if:` (or its job's) lets such an event in reads no secret but GITHUB_TOKEN,
//     and such a job holds no write permission. A branch inside this repository gets the secrets
//     on `pull_request` just like main does, so the `if:` is the only gate.
//     `pull_request_target` is refused outright;
//   - uses a cache in a job that publishes (packages, contents or id-token write) or builds what
//     such a job publishes: actions/cache, a `cache:` input, `cache-from`/`cache-to`,
//     `--cache-from`/`--cache-to` in a run: line, or setup-node without
//     `package-manager-cache: false` (it turns the npm cache on by itself). Any job on main can
//     write the Actions cache, so a release would ship what it left;
//   - has no top-level `permissions:` block. With one, a job that sets none starts from it
//     instead of from the repository default.
// The Dockerfiles at the root and the shell scripts under scripts/ get the line rules of the
// first point too: a build or an upload runs what the lockfile holds, nothing fetched fresh.
// Every FROM in those Dockerfiles names its base image by digest (stages and scratch aside).
//
//   node scripts/check-action-pins.mjs [repo root]      default: the current directory
//   node scripts/check-action-pins.mjs --self-test      runs the cases below
//
// Run from the lint job of .github/workflows/tests.yml after `npm ci`: the files are read with
// js-yaml, which comes with eslint (through @eslint/eslintrc).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textOf = (v) => (v === undefined || v === null || typeof v === 'object' ? '' : String(v));
const listOf = (v) => (Array.isArray(v) ? v.map(String) : isMap(v) ? Object.keys(v) : v == null ? [] : [String(v)]);
const stepsOf = (job) => (isMap(job) && Array.isArray(job.steps) ? job.steps.filter(isMap) : []);

// Parses a file; spanOf(node) gives the 1-based lines a mapping or a list covers.
function parse(text) {
  const spans = new WeakMap();
  const open = [];
  const doc = load(text, {
    listener(event, state) {
      if (event === 'open') {
        open.push(state.line + 1);
        return;
      }
      const start = open.pop();
      if (state.result && typeof state.result === 'object' && !spans.has(state.result)) {
        spans.set(state.result, { start, end: state.line + 1 });
      }
    },
  });
  const raw = text.split(/\r?\n/);
  // The line inside `node` that holds `needle` (a string or a RegExp), else where `node` starts.
  const lineOf = (node, needle) => {
    const span = spans.get(node) ?? { start: 1, end: raw.length };
    if (needle !== undefined) {
      for (let i = span.start - 1; i < Math.min(span.end, raw.length); i++) {
        if (typeof needle === 'string' ? raw[i].includes(needle) : needle.test(raw[i])) return i + 1;
      }
    }
    return span.start;
  };
  return { doc, lineOf };
}

// ---------------------------------------------------------------------------
// Which events an `if:` lets through, as {only: Set} or {except: Set}. Only
// `github.event_name == '...'` / `!= '...'` comparisons count, joined by `&&`
// (or `==` ones by `||`); anything else lets every event through.

function splitTop(expr, op) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'") quote = !quote;
    else if (quote) continue;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim());
}

// True when the `(` at the start of `expr` is closed by its last character.
function wrapped(expr) {
  let depth = 0;
  let quote = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'") quote = !quote;
    else if (quote) continue;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i === expr.length - 1;
  }
  return false;
}

function stripParens(expr) {
  let e = expr.trim();
  while (e.startsWith('(') && wrapped(e)) e = e.slice(1, -1).trim();
  return e;
}

const EVENT_IS = /^github\.event_name\s*==\s*'([\w-]+)'$/;
const EVENT_IS_NOT = /^github\.event_name\s*!=\s*'([\w-]+)'$/;
const EVERY_EVENT = { except: new Set() };

function intersect(a, b) {
  if (a.only && b.only) return { only: new Set([...a.only].filter((e) => b.only.has(e))) };
  if (a.only) return { only: new Set([...a.only].filter((e) => !b.except.has(e))) };
  if (b.only) return intersect(b, a);
  return { except: new Set([...a.except, ...b.except]) };
}

function eventsOf(condition) {
  if (condition === false) return { only: new Set() };
  const text = textOf(condition).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  if (!text) return EVERY_EVENT;
  let events = EVERY_EVENT;
  for (const part of splitTop(text, '&&')) {
    const conj = stripParens(part);
    const not = conj.match(EVENT_IS_NOT);
    if (not) {
      events = intersect(events, { except: new Set([not[1]]) });
      continue;
    }
    const alts = splitTop(conj, '||').map((a) => stripParens(a).match(EVENT_IS));
    if (alts.every(Boolean)) events = intersect(events, { only: new Set(alts.map((a) => a[1])) });
  }
  return events;
}

const lets = (events, name) => (events.only ? events.only.has(name) : !events.except.has(name));
const overlap = (a, b) => {
  const both = intersect(a, b);
  return both.only ? both.only.size > 0 : true;
};

// Every string under a node.
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (isMap(v)) Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// Every mapping under a node, the node itself included.
function maps(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => maps(x, out));
  else if (isMap(v)) {
    out.push(v);
    Object.values(v).forEach((x) => maps(x, out));
  }
  return out;
}

// Secrets the expressions under a node read, other than GITHUB_TOKEN.
function secretReads(node) {
  const names = [];
  for (const text of strings(node)) {
    for (const [expr] of text.matchAll(/\$\{\{[\s\S]*?\}\}/g)) {
      for (const m of expr.matchAll(/\bsecrets\b(?:\.([A-Za-z_][\w-]*)|\s*\[\s*'([^']+)'\s*\])?/g)) {
        const name = m[1] ?? m[2] ?? '*';
        if (name !== 'GITHUB_TOKEN') names.push(name);
      }
    }
  }
  return names;
}

function writeScopes(permissions) {
  if (isMap(permissions)) return Object.entries(permissions).filter(([, v]) => textOf(v).trim() === 'write').map(([k]) => k);
  return textOf(permissions).trim() === 'write-all' ? ['write-all'] : [];
}

// Events that can run code nobody has merged yet, or that anyone can start.
const OUTSIDE = ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment'];
const PUBLISHES = new Set(['packages', 'contents', 'id-token', 'write-all']);
const usesOf = (step) => textOf(step.uses).trim();

// The events a cache input is on for: `${{ <condition> && 'npm' || '' }}`
// turns it on only where the condition holds; any other value always.
function cacheEvents(value) {
  const text = textOf(value).trim();
  if (!text || text === 'false') return null;
  const m = text.match(/^\$\{\{\s*([\s\S]+?)\s*&&\s*'[^']*'\s*\|\|\s*''\s*\}\}$/);
  return m ? eventsOf(m[1]) : EVERY_EVENT;
}

function cacheInputs(job, lineOf) {
  const found = [];
  const jobEvents = eventsOf(job.if);
  for (const step of stepsOf(job)) {
    const stepEvents = intersect(jobEvents, eventsOf(step.if));
    const uses = usesOf(step);
    if (/^actions\/cache(\/(restore|save))?@/.test(uses)) found.push({ what: uses.split('@')[0], line: lineOf(step), events: stepEvents });
    const inputs = isMap(step.with) ? step.with : {};
    for (const key of ['cache', 'cache-from', 'cache-to']) {
      const events = key in inputs ? cacheEvents(inputs[key]) : null;
      if (events) found.push({ what: `${key}: ${textOf(inputs[key]).trim()}`, line: lineOf(step, `${key}:`), events: intersect(stepEvents, events) });
    }
    const flag = textOf(step.run).match(/--cache-(from|to)\b/);
    if (flag) found.push({ what: `${flag[0]} in run`, line: lineOf(step, flag[0]), events: stepEvents });
    // setup-node restores the npm cache by itself once package.json names npm in
    // `packageManager`, unless the step says `package-manager-cache: false`.
    if (/^actions\/setup-node@/.test(uses) && String(inputs['package-manager-cache']) !== 'false') {
      found.push({ what: 'setup-node without package-manager-cache: false', line: lineOf(step, 'setup-node'), events: stepEvents });
    }
  }
  return found;
}

// Workflows the `workflow_run` trigger follows, by name, and whether outside code can reach it.
function workflowRunIsOutside(doc, byName) {
  const upstream = listOf(isMap(doc.on) && isMap(doc.on.workflow_run) ? doc.on.workflow_run.workflows : undefined);
  if (strings(doc.jobs).some((s) => /github\.event\.workflow_run\.head_/.test(s))) return true;
  return upstream.length === 0 || upstream.some((name) => {
    const triggers = byName.get(name);
    return !triggers || [...OUTSIDE, 'pull_request_target', 'workflow_run'].some((e) => triggers.has(e));
  });
}

function check(files) {
  const problems = [];
  const parsed = [];
  for (const { rel, text } of files) {
    // Downloads and installs: line by line.
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*#/.test(line) || /^\s*(?:-\s*)?uses:/.test(line)) return;
      if (/\b(curl|wget)\b[^|#]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(line)) problems.push(`${rel}:${i + 1}: pipes a download into a shell`);
      if (/\b(npx|npm\s+exec)\s+(--yes|-y)\b/.test(line)) problems.push(`${rel}:${i + 1}: npx --yes installs a package outside the lockfile`);
      if (/\bnpm\s+(i|install)\s+(?!.*--package-lock-only)[^#]*\s[@a-z][\w@/.-]*/.test(line) && !/npm\s+(i|install)\s+-g\s+npm@/.test(line)) {
        problems.push(`${rel}:${i + 1}: npm install of named packages outside the lockfile`);
      }
    });
    if (/(^|\/)Dockerfile[^/]*$/.test(rel)) {
      const stages = new Set(['scratch']);
      text.split(/\r?\n/).forEach((line, i) => {
        const m = line.match(/^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
        if (!m) return;
        if (!stages.has(m[1].toLowerCase()) && !/@sha256:[0-9a-f]{64}$/.test(m[1])) {
          problems.push(`${rel}:${i + 1}: base image ${m[1]} is not pinned by digest`);
        }
        if (m[2]) stages.add(m[2].toLowerCase());
      });
    }
    if (!/\.ya?ml$/.test(rel)) continue;
    try {
      parsed.push({ rel, ...parse(text), workflow: rel.startsWith('.github/workflows/') });
    } catch (e) {
      problems.push(`${rel}: does not parse as YAML (${e.reason ?? e.message})`);
    }
  }

  // Pins: every `uses:`, block or flow style.
  for (const { rel, doc, lineOf } of parsed) {
    for (const node of maps(doc)) {
      const ref = textOf(node.uses).trim();
      if (!ref || ref.startsWith('./')) continue;
      const pinned = ref.startsWith('docker://') ? /@sha256:[0-9a-f]{64}$/.test(ref) : /@[0-9a-f]{40}$/.test(ref);
      if (!pinned) problems.push(`${rel}:${lineOf(node, ref)}: ${ref} is not pinned ${ref.startsWith('docker://') ? 'by digest' : 'to a commit'}`);
    }
  }

  const workflows = parsed.filter((p) => p.workflow && isMap(p.doc));
  const byName = new Map(workflows.filter((w) => w.doc.name).map((w) => [String(w.doc.name), new Set(listOf(w.doc.on))]));

  // Outside code: no secret, no write token.
  for (const { rel, doc, lineOf } of workflows) {
    const triggers = new Set(listOf(doc.on));
    if (triggers.has('pull_request_target')) {
      problems.push(`${rel}:${lineOf(doc, 'pull_request_target')}: pull_request_target runs with the repository's secrets for any fork`);
    }
    const outside = OUTSIDE.filter((e) => triggers.has(e));
    if (triggers.has('workflow_run') && workflowRunIsOutside(doc, byName)) outside.push('workflow_run');
    if (!outside.length || !isMap(doc.jobs)) continue;
    const reached = (events) => outside.filter((e) => lets(events, e));
    const hint = (names) => `exclude ${names.join(', ')} in its if:`;
    const workflowEnvReads = secretReads(doc.env);

    for (const [id, job] of Object.entries(doc.jobs)) {
      if (!isMap(job)) continue;
      const jobEvents = eventsOf(job.if);
      const jobReached = reached(jobEvents);
      if (!jobReached.length) continue;
      const on = jobReached.join(', ');
      const write = writeScopes(job.permissions ?? doc.permissions);
      if (write.length) {
        const line = 'permissions' in job ? lineOf(job, 'permissions') : lineOf(doc, /^permissions\s*:/);
        problems.push(`${rel}:${line}: job ${id} holds ${write.join(', ')} write and runs on ${on} (${hint(jobReached)})`);
      }
      for (const name of workflowEnvReads) {
        problems.push(`${rel}:${lineOf(doc, `secrets.${name}`)}: secrets.${name} in the workflow env reaches job ${id}, which runs on ${on}`);
      }
      for (const [key, value] of Object.entries(job)) {
        if (key === 'steps' || key === 'if') continue;
        if (key === 'secrets') problems.push(`${rel}:${lineOf(job, 'secrets:')}: job ${id} passes secrets on and runs on ${on}`);
        for (const name of secretReads(value)) {
          problems.push(`${rel}:${lineOf(job, 'secrets')}: job ${id} reads secrets.${name} and runs on ${on} (${hint(jobReached)})`);
        }
      }
      for (const step of stepsOf(job)) {
        const stepReached = reached(intersect(jobEvents, eventsOf(step.if)));
        if (!stepReached.length) continue;
        for (const name of secretReads(step)) {
          problems.push(`${rel}:${lineOf(step, 'secrets')}: reads secrets.${name} in a step that runs on ${stepReached.join(', ')} (${hint(stepReached)})`);
        }
      }
    }
  }

  // Jobs that publish restore no cache, since any job that ran on main before
  // could have written it: a job holding packages, contents or id-token write,
  // and a job whose artifacts such a job downloads, for the events the
  // publishing job runs on. Test jobs keep their caches.
  for (const { rel, doc, lineOf } of workflows) {
    if (!isMap(doc.jobs)) continue;
    const jobs = doc.jobs;
    const publishScopes = (job) => writeScopes(job.permissions ?? doc.permissions).filter((s) => PUBLISHES.has(s));
    for (const [id, job] of Object.entries(jobs)) {
      if (!isMap(job)) continue;
      const scopes = publishScopes(job);
      if (!scopes.length) continue;
      const events = eventsOf(job.if);
      for (const c of cacheInputs(job, lineOf)) {
        if (overlap(c.events, events)) problems.push(`${rel}:${c.line}: job ${id} holds ${scopes.join(', ')} write and uses a cache (${c.what})`);
      }
      if (!stepsOf(job).some((s) => /^actions\/download-artifact@/.test(usesOf(s)))) continue;
      // The jobs it needs, directly or through others, that upload artifacts.
      const seen = new Set();
      const queue = listOf(job.needs);
      while (queue.length) {
        const name = queue.shift();
        const dep = jobs[name];
        if (seen.has(name) || !isMap(dep)) continue;
        seen.add(name);
        queue.push(...listOf(dep.needs));
        if (publishScopes(dep).length || !stepsOf(dep).some((s) => /^actions\/upload-artifact@/.test(usesOf(s)))) continue;
        for (const c of cacheInputs(dep, lineOf)) {
          if (overlap(c.events, events)) problems.push(`${rel}:${c.line}: job ${name} builds what job ${id} publishes and uses a cache (${c.what})`);
        }
      }
    }
  }

  for (const { rel, doc } of workflows) {
    if (!('permissions' in doc)) problems.push(`${rel}:1: no top-level permissions: block (add permissions: contents: read)`);
  }
  return problems;
}

// Each case: a name, the number of problems the check must report, and the workflow files.
const CASES = [
  ['write token on a pull request job, as a flow mapping', 1, { 'x.yml': `
on: [push, pull_request]
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    permissions: { contents: write, packages: write }
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: npm ci && npm run build
` }],
  ['--cache-from in a run: line of a publishing job', 1, { 'x.yml': `
on:
  release:
    types: [published]
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1
      - run: docker buildx build --cache-from type=gha,scope=main --push -t ghcr.io/example/x:1 .
` }],
  ['secret in a pull_request_review job', 1, { 'x.yml': `
on:
  pull_request_review:
    types: [submitted]
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: npm ci && bash scripts/upload-sourcemaps.sh sourcemaps
        env:
          BUGSINK_AUTH_TOKEN: \${{ secrets.BUGSINK_AUTH_TOKEN }}
` }],
  ['secret in a workflow_run job that checks out the triggering head', 1, { 'x.yml': `
on:
  workflow_run:
    workflows: ["CI: Unit tests"]
    types: [completed]
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.workflow_run.head_sha }}
      - run: npm ci && npm run build
        env:
          BUGSINK_AUTH_TOKEN: \${{ secrets.BUGSINK_AUTH_TOKEN }}
` }],
  ['top-level write token as a flow mapping', 1, { 'x.yml': `
on: pull_request
permissions: { contents: write }
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: npm ci && npm test
` }],
  ['secret behind an if: that excludes one branch prefix', 1, { 'x.yml': `
on: [push, pull_request]
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - if: github.event_name != 'pull_request' || !startsWith(github.head_ref, 'warden/')
        env:
          TOKEN: \${{ secrets.BUGSINK_AUTH_TOKEN }}
        run: bash scripts/upload-sourcemaps.sh sourcemaps
` }],
  ['secret by index in a with: input', 1, { 'x.yml': `
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: read
jobs:
  j:
    if: \${{ success() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550 # v4.8.0
        with:
          registry: docker.io
          password: \${{ secrets['DOCKERHUB_TOKEN'] }}
` }],
  ['docker:// image without a digest', 1, { 'x.yml': `
on: push
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine:3.20
      - uses: docker://alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000
` }],
  ['short SHA, quoted tag and a flow-style step', 3, { 'x.yml': `
on: push
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: "actions/checkout@3d3c42e"
      - uses: 'actions/setup-node@v7'
      - {uses: actions/upload-artifact@v7}
` }],
  ['flow-style steps list', 1, { 'x.yml': `
on: push
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps: [{ uses: actions/checkout@v7 }, { run: echo hi }]
` }],
  ['secret in an issue_comment job', 1, { 'x.yml': `
on:
  issue_comment:
    types: [created]
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
        run: ./deploy.sh
` }],
  ['pull_request_target', 1, { 'x.yml': `
on: pull_request_target
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
` }],
  ['no top-level permissions', 1, { 'x.yml': `
on: push
jobs:
  j:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: echo hi
` }],
  ['caches in jobs that build what a release job publishes', 3, { 'x.yml': `
on: [release, push]
permissions:
  contents: read
jobs:
  on-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          cache: \${{ github.event_name == 'release' && 'npm' || '' }}
          package-manager-cache: false
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
  push-only:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          cache: \${{ github.event_name == 'push' && 'npm' || '' }}
          package-manager-cache: false
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
  restores:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0
        with:
          path: x
          key: y
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
  middle:
    needs: restores
    runs-on: ubuntu-latest
    steps:
      - run: echo middle
  publish:
    needs: [on-release, push-only, middle]
    if: github.event_name == 'release'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          cache: npm
  image:
    needs: gate
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          cache-from: type=gha
` }],
  ['setup-node that may turn the npm cache on by itself', 2, { 'x.yml': `
on: [release, pull_request]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
  build-off:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
          package-manager-cache: false
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
  build-expression:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          package-manager-cache: \${{ github.event_name == 'pull_request' }}
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          cache: npm
  release:
    needs: [build, build-off, build-expression, test]
    if: github.event_name == 'release'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
` }],
  ['secrets kept away from pull requests', 0, { 'x.yml': `
on: [push, pull_request, release]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - if: github.event_name != 'pull_request'
        env:
          T: \${{ secrets.UPLOAD_TOKEN }}
        run: ./upload.sh
      - if: \${{ github.event_name == 'push' }}
        env:
          T: \${{ secrets.OTHER_TOKEN }}
        run: ./upload.sh
  release:
    if: github.event_name == 'release'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: gh release upload x
` }],
  ['workflow_run after a release workflow', 0, {
    'release.yml': `
name: "Docker: Release image"
on:
  release:
    types: [published]
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`,
    'deploy.yml': `
on:
  workflow_run:
    workflows: ["Docker: Release image"]
    types: [completed]
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - env:
          KEY: \${{ secrets.DEPLOY_SSH_KEY }}
        run: ./deploy.sh
`,
  }],
  ['npx --yes in a Dockerfile and in a script', 2, {
    Dockerfile: `
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder
RUN npm ci
# npx --yes in a comment does not count
RUN npx --yes "@sentry/cli@3.8.2" sourcemaps inject .next/static
RUN npx --no-install sentry-cli sourcemaps inject .next/static
`,
    'scripts/upload-sourcemaps.sh': `#!/usr/bin/env bash
npx -y @sentry/cli --url "$url" sourcemaps upload "$dir"
npx --no-install sentry-cli --version
`,
  }],
  ['base images without a digest', 2, {
    'Dockerfile.lite': `
FROM --platform=$BUILDPLATFORM node:24-alpine AS builder
FROM builder AS debug-ids
FROM scratch AS sourcemaps
FROM nginxinc/nginx-unprivileged:1.30-alpine-slim
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runner
`,
  }],
];

function selfTest() {
  const failures = [];
  for (const [name, want, files] of CASES) {
    // A bare .yml name is a workflow; anything else is a path from the repo root.
    const rel = (file) => (/^[\w.-]+\.ya?ml$/.test(file) ? `.github/workflows/${file}` : file);
    const got = check(Object.entries(files).map(([file, text]) => ({ rel: rel(file), text })));
    if (got.length !== want) failures.push(`case "${name}": expected ${want}, got ${got.length}${got.length ? `\n    ${got.join('\n    ')}` : ''}`);
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`self-test: ${CASES.length} cases as expected`);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const root = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '.');
  const files = [
    ...walk(path.join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f)),
    ...walk(path.join(root, '.github', 'actions')).filter((f) => /(^|[\\/])action\.ya?ml$/.test(f)),
    ...['action.yml', 'action.yaml', 'action/action.yml'].map((f) => path.join(root, f)).filter(existsSync),
    ...readdirSync(root).filter((f) => /^Dockerfile(\..+)?$/.test(f)).map((f) => path.join(root, f)),
    ...walk(path.join(root, 'scripts')).filter((f) => /\.sh$/.test(f)),
  ];
  const problems = check(files.map((file) => ({ rel: path.relative(root, file).replace(/\\/g, '/'), text: readFileSync(file, 'utf8') })));
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s) in ${files.length} file(s).`);
    process.exit(1);
  }
  console.log(
    `ok: ${files.length} workflow, action, Dockerfile and script file(s): actions pinned to a commit, base images by digest, nothing fetched outside the lockfile, no secret or write token where outside code runs, no cache in publishing jobs, top-level permissions in every workflow`,
  );
}
