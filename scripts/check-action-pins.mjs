#!/usr/bin/env node
// Fails (exit 1) while a workflow or composite action in the repo:
//   - uses an action that is not pinned to a full commit SHA, or runs a tool
//     straight off the network (`curl | sh`, `npx --yes`, `npm install <names>`);
//   - hands a secret or a write token to a pull request run. In a workflow a
//     pull request starts, a step whose `if:` (or its job's) lets pull
//     requests in reads no secret but GITHUB_TOKEN, and such a job holds no
//     write permission. A branch inside this repository gets the secrets on
//     `pull_request` just like main does, so the `if:` is the only gate.
//     `pull_request_target` is refused outright;
//   - uses a cache in a job that publishes (packages, contents or
//     id-token write) or builds what such a job publishes. Any job on main
//     can write the Actions cache, so a release would ship what it left.
//
//   node scripts/check-action-pins.mjs [repo root]      default: the current directory
//
// Run from the lint job of .github/workflows/tests.yml. No dependencies: the
// workflows are read with the small YAML reader below, which knows the subset
// workflow files use (maps, lists, block scalars, anchors).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');

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

const workflowFiles = walk(path.join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
const files = [
  ...workflowFiles,
  ...walk(path.join(root, '.github', 'actions')).filter((f) => /(^|[\\/])action\.ya?ml$/.test(f)),
  ...['action.yml', 'action.yaml', 'action/action.yml'].map((f) => path.join(root, f)).filter(existsSync),
];

const problems = [];
const relOf = (file) => path.relative(root, file).replace(/\\/g, '/');

// Pins and downloads: line by line.
for (const file of files) {
  const rel = relOf(file);
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const uses = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/);
    if (uses) {
      const ref = uses[1];
      if (ref.startsWith('./')) return; // an action in this repo
      if (ref.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/.test(ref)) problems.push(`${rel}:${i + 1}: ${ref} is not pinned by digest`);
        return;
      }
      if (!/@[0-9a-f]{40}$/.test(ref)) problems.push(`${rel}:${i + 1}: ${ref} is not pinned to a commit`);
      return;
    }
    if (/\b(curl|wget)\b[^|#]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(line)) problems.push(`${rel}:${i + 1}: pipes a download into a shell`);
    if (/\bnpx\s+(--yes|-y)\b/.test(line)) problems.push(`${rel}:${i + 1}: npx --yes installs a package outside the lockfile`);
    if (/\bnpm\s+(i|install)\s+(?!.*--package-lock-only)[^#]*\s[@a-z][\w@/.-]*/.test(line) && !/npm\s+(i|install)\s+-g\s+npm@/.test(line)) {
      problems.push(`${rel}:${i + 1}: npm install of named packages outside the lockfile`);
    }
  });
}

// ---------------------------------------------------------------------------
// A YAML reader for workflow files. Nodes: {type: 'map', entries: Map, line},
// {type: 'seq', items, line}, {type: 'scalar', value, line} and
// {type: 'block', lines: [{text, line}], line} for `|` and `>` scalars.
// Line numbers are 1-based.

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[{-][^:#]*?)\s*:(?:\s+(.*))?$/;
const isSeqItem = (text) => text === '-' || text.startsWith('- ');

function cleanValue(value) {
  const v = value.trim();
  if (v.startsWith('"')) {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"/);
    if (m) return { text: m[1], quoted: true };
  }
  if (v.startsWith("'")) {
    const m = v.match(/^'((?:[^']|'')*)'/);
    if (m) return { text: m[1].replace(/''/g, "'"), quoted: true };
  }
  const hash = v.search(/(^|\s)#/);
  return { text: (hash === -1 ? v : v.slice(0, hash)).trim(), quoted: false };
}

function unquoteKey(key) {
  if (key.startsWith('"')) return key.slice(1, -1);
  if (key.startsWith("'")) return key.slice(1, -1).replace(/''/g, "'");
  return key.trim();
}

function parseYaml(source) {
  const lines = source.split(/\r?\n/).map((raw) => ({ raw, indent: raw.match(/^ */)[0].length, text: raw.trim() }));
  const anchors = new Map();
  let pos = 0;

  const skippable = (l) => l.text === '' || l.text.startsWith('#') || l.text === '---';
  function peek() {
    while (pos < lines.length && skippable(lines[pos])) pos++;
    return pos < lines.length ? lines[pos] : null;
  }

  function parseNode() {
    const l = peek();
    if (!l) return null;
    return isSeqItem(l.text) ? parseSeq(l.indent) : parseMap(l.indent);
  }

  function parseBlockScalar(indent, at) {
    const out = [];
    let p = at + 1;
    for (; p < lines.length; p++) {
      const l = lines[p];
      if (l.text !== '' && l.indent <= indent) break;
      out.push({ text: l.raw, line: p + 1 });
    }
    while (out.length && out[out.length - 1].text.trim() === '') out.pop();
    pos = p;
    return { type: 'block', lines: out, line: at + 1 };
  }

  // The value after `key:` (or after `- `) on line `at`, whose key sits at `indent`.
  function parseValue(rest, indent, at, inMap) {
    let v = cleanValue(rest);
    let anchor = null;
    if (!v.quoted) {
      const a = v.text.match(/^&([\w-]+)(?:\s+(.*))?$/);
      if (a) {
        anchor = a[1];
        v = cleanValue(a[2] ?? '');
      }
    }
    let node;
    if (!v.quoted && /^\*[\w-]+$/.test(v.text)) {
      node = anchors.get(v.text.slice(1)) ?? { type: 'scalar', value: v.text, line: at + 1 };
    } else if (!v.quoted && /^[|>][-+0-9]*$/.test(v.text)) {
      node = parseBlockScalar(indent, at);
    } else if (!v.quoted && v.text === '') {
      const n = peek();
      if (n && n.indent > indent) node = parseNode();
      else if (n && inMap && n.indent === indent && isSeqItem(n.text)) node = parseSeq(indent);
      else node = { type: 'scalar', value: '', line: at + 1 };
    } else {
      let text = v.text;
      if (!v.quoted) {
        // A plain scalar may go on over more-indented lines.
        for (let n = peek(); n && n.indent > indent && !KEY.test(n.text) && !isSeqItem(n.text); n = peek()) {
          text += ` ${cleanValue(n.text).text}`;
          pos++;
        }
      }
      node = { type: 'scalar', value: text, line: at + 1 };
    }
    if (anchor) anchors.set(anchor, node);
    return node;
  }

  function parseMap(indent) {
    const node = { type: 'map', entries: new Map(), line: pos + 1 };
    for (let l = peek(); l && l.indent >= indent; l = peek()) {
      const at = pos;
      const m = l.indent === indent && !isSeqItem(l.text) ? l.text.match(KEY) : null;
      pos++;
      if (!m) continue;
      node.entries.set(unquoteKey(m[1]), parseValue(m[2] ?? '', indent, at, true));
    }
    return node;
  }

  function parseSeq(indent) {
    const node = { type: 'seq', items: [], line: pos + 1 };
    for (let l = peek(); l && l.indent === indent && isSeqItem(l.text); l = peek()) {
      const at = pos;
      const rest = l.text.slice(1).trimStart();
      const contentIndent = indent + (l.text.length - rest.length);
      if (rest !== '' && (KEY.test(rest) || isSeqItem(rest))) {
        // `- key: value` opens a map (or `- - x` a list) at the column of its content.
        lines[at] = { raw: l.raw, indent: contentIndent, text: rest };
        node.items.push(isSeqItem(rest) ? parseSeq(contentIndent) : parseMap(contentIndent));
        continue;
      }
      pos++;
      node.items.push(parseValue(rest, indent, at, false));
    }
    return node;
  }

  return parseNode() ?? { type: 'map', entries: new Map(), line: 1 };
}

const get = (node, key) => (node?.type === 'map' ? node.entries.get(key) : undefined);
const textOf = (node) =>
  node?.type === 'scalar' ? node.value : node?.type === 'block' ? node.lines.map((l) => l.text.trim()).join('\n') : '';

function listOf(node) {
  if (!node) return [];
  if (node.type === 'map') return [...node.entries.keys()];
  if (node.type === 'seq') return node.items.map(textOf);
  const t = textOf(node).trim();
  if (t.startsWith('[')) return t.slice(1, -1).split(',').map((s) => cleanValue(s).text).filter(Boolean);
  return t ? [t] : [];
}

// Every scalar under a node, with its line.
function scalarsOf(node, out = []) {
  if (!node) return out;
  if (node.type === 'scalar') out.push({ text: node.value, line: node.line });
  else if (node.type === 'block') out.push(...node.lines);
  else if (node.type === 'map') for (const v of node.entries.values()) scalarsOf(v, out);
  else if (node.type === 'seq') for (const v of node.items) scalarsOf(v, out);
  return out;
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

function eventsOf(ifNode) {
  const text = textOf(ifNode).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
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

// Secrets an expression reads, other than GITHUB_TOKEN.
function secretReads(node) {
  const hits = [];
  for (const { text, line } of scalarsOf(node)) {
    for (const [expr] of text.matchAll(/\$\{\{[\s\S]*?\}\}/g)) {
      for (const m of expr.matchAll(/\bsecrets\b(?:\.([A-Za-z_][\w-]*)|\s*\[\s*'([^']+)'\s*\])?/g)) {
        const name = m[1] ?? m[2] ?? '*';
        if (name !== 'GITHUB_TOKEN') hits.push({ name, line });
      }
    }
  }
  return hits;
}

function writeScopes(permissions) {
  if (!permissions) return [];
  if (permissions.type === 'map') {
    return [...permissions.entries].filter(([, v]) => textOf(v).trim() === 'write').map(([k]) => k);
  }
  return textOf(permissions).trim() === 'write-all' ? ['write-all'] : [];
}

const workflows = workflowFiles.map((file) => ({ rel: relOf(file), wf: parseYaml(readFileSync(file, 'utf8')) }));
const stepsOf = (job) => {
  const steps = get(job, 'steps');
  return steps?.type === 'seq' ? steps.items : [];
};

// Pull request runs: no secret, no write token.
for (const { rel, wf } of workflows) {
  const on = get(wf, 'on');
  const triggers = new Set(listOf(on));
  if (triggers.has('pull_request_target')) {
    problems.push(`${rel}:${on.line}: pull_request_target runs with the repository's secrets for any fork`);
  }
  const prEvents = ['pull_request', 'pull_request_target'].filter((e) => triggers.has(e));
  if (!prEvents.length) continue;
  const letsPullRequests = (events) => prEvents.some((e) => lets(events, e));

  const workflowEnvReads = secretReads(get(wf, 'env'));
  const jobs = get(wf, 'jobs');
  if (jobs?.type !== 'map') continue;
  for (const [id, job] of jobs.entries) {
    const jobEvents = eventsOf(get(job, 'if'));
    if (!letsPullRequests(jobEvents)) continue;

    const write = writeScopes(get(job, 'permissions') ?? get(wf, 'permissions'));
    if (write.length) {
      problems.push(`${rel}:${job.line}: job ${id} holds ${write.join(', ')} write and runs on pull requests`);
    }
    for (const { name, line } of workflowEnvReads) {
      problems.push(`${rel}:${line}: secrets.${name} in the workflow env reaches job ${id}, which runs on pull requests`);
    }
    for (const [key, value] of job.entries) {
      if (key === 'steps' || key === 'if') continue;
      if (key === 'secrets') problems.push(`${rel}:${value.line}: job ${id} passes secrets on and runs on pull requests`);
      for (const { name, line } of secretReads(value)) {
        problems.push(`${rel}:${line}: job ${id} reads secrets.${name} and runs on pull requests`);
      }
    }
    for (const step of stepsOf(job)) {
      if (!letsPullRequests(intersect(jobEvents, eventsOf(get(step, 'if'))))) continue;
      for (const { name, line } of secretReads(step)) {
        problems.push(`${rel}:${line}: reads secrets.${name} in a step that runs on pull requests (add if: github.event_name != 'pull_request')`);
      }
    }
  }
}

// Jobs that publish restore no cache, since any job that ran on main before
// could have written it: a job holding packages, contents or id-token write,
// and a job whose artifacts such a job downloads, for the events the
// publishing job runs on. Test jobs keep their caches.
const PUBLISHES = new Set(['packages', 'contents', 'id-token', 'write-all']);
const usesOf = (step) => textOf(get(step, 'uses')).trim();
const overlap = (a, b) => {
  const both = intersect(a, b);
  return both.only ? both.only.size > 0 : true;
};

// The events a cache input is on for: `${{ <condition> && 'npm' || '' }}`
// turns it on only where the condition holds; any other value always.
function cacheEvents(value) {
  const text = textOf(value).trim();
  if (!text || text === 'false') return null;
  const m = text.match(/^\$\{\{\s*([\s\S]+?)\s*&&\s*'[^']*'\s*\|\|\s*''\s*\}\}$/);
  return m ? eventsOf({ type: 'scalar', value: m[1] }) : EVERY_EVENT;
}

function cacheInputs(job) {
  const found = [];
  const jobEvents = eventsOf(get(job, 'if'));
  for (const step of stepsOf(job)) {
    const stepEvents = intersect(jobEvents, eventsOf(get(step, 'if')));
    const uses = usesOf(step);
    if (/^actions\/cache(\/restore)?@/.test(uses)) found.push({ what: uses.split('@')[0], line: step.line, events: stepEvents });
    for (const key of ['cache', 'cache-from', 'cache-to']) {
      const value = get(get(step, 'with'), key);
      const events = value && cacheEvents(value);
      if (events) found.push({ what: `${key}: ${textOf(value).trim()}`, line: value.line, events: intersect(stepEvents, events) });
    }
  }
  return found;
}

for (const { rel, wf } of workflows) {
  const jobs = get(wf, 'jobs');
  if (jobs?.type !== 'map') continue;
  const publishScopes = (job) => writeScopes(get(job, 'permissions') ?? get(wf, 'permissions')).filter((s) => PUBLISHES.has(s));
  for (const [id, job] of jobs.entries) {
    const scopes = publishScopes(job);
    if (!scopes.length) continue;
    const events = eventsOf(get(job, 'if'));
    for (const c of cacheInputs(job)) {
      if (overlap(c.events, events)) problems.push(`${rel}:${c.line}: job ${id} holds ${scopes.join(', ')} write and uses a cache (${c.what})`);
    }
    if (!stepsOf(job).some((s) => /^actions\/download-artifact@/.test(usesOf(s)))) continue;
    // The jobs it needs, directly or through others, that upload artifacts.
    const seen = new Set();
    const queue = listOf(get(job, 'needs'));
    while (queue.length) {
      const name = queue.shift();
      const dep = jobs.entries.get(name);
      if (seen.has(name) || !dep) continue;
      seen.add(name);
      queue.push(...listOf(get(dep, 'needs')));
      if (publishScopes(dep).length || !stepsOf(dep).some((s) => /^actions\/upload-artifact@/.test(usesOf(s)))) continue;
      for (const c of cacheInputs(dep)) {
        if (overlap(c.events, events)) problems.push(`${rel}:${c.line}: job ${name} builds what job ${id} publishes and uses a cache (${c.what})`);
      }
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s) in ${files.length} file(s).`);
  process.exit(1);
}
console.log(
  `ok: ${files.length} workflow and action file(s), every action pinned to a commit, no secret or write token on a pull request, no cache in a publishing job`,
);
