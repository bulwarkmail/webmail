#!/usr/bin/env node
// Fails (exit 1) while a workflow or composite action pastes a ${{ }} expression into text that a
// shell or an interpreter runs: a step's `run:` (in any YAML form), the `script:` input of an
// action such as actions/github-script, and a `shell:` command, also under `defaults.run`.
// GitHub substitutes the expression into that text before the program starts, so the value
// becomes part of the code, whatever context it comes from (`env.*` and `matrix.*` included).
// Put the value in the step's `env:`, where any expression may build it, and read it there as
// "$NAME" (process.env.NAME in a script).
//
//   node scripts/check-run-expressions.mjs [repo root]
//   node scripts/check-run-expressions.mjs --self-test     runs the cases below
//
// Run from the lint job of .github/workflows/tests.yml after `npm ci`: the files are read with
// js-yaml, which comes with eslint (through @eslint/eslintrc).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

// Parses a file; lineOf(node) is the 1-based line where a mapping or a list starts.
function parse(text) {
  const lines = new WeakMap();
  const open = [];
  const doc = load(text, {
    listener(event, state) {
      if (event === 'open') {
        open.push(state.line + 1);
        return;
      }
      const line = open.pop();
      if (state.result && typeof state.result === 'object' && !lines.has(state.result)) lines.set(state.result, line);
    },
  });
  return { doc, lineOf: (node) => lines.get(node) ?? 1 };
}

// Every ${{ ... }} in a text. A `}}` inside a quoted string does not end the expression.
function expressions(text) {
  const found = [];
  let i = text.indexOf('${{');
  while (i !== -1) {
    let j = i + 3;
    let quoted = false;
    while (j < text.length && (quoted || !text.startsWith('}}', j))) {
      if (text[j] === "'") quoted = !quoted;
      j++;
    }
    found.push(text.slice(i, j + 2).replace(/\s+/g, ' '));
    i = text.indexOf('${{', j + 2);
  }
  return found;
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every scalar of a file that a shell or an interpreter runs, with where it sits.
function scripts(doc, lineOf) {
  const out = [];
  const add = (where, value, node) => {
    if (value !== undefined && value !== null) out.push({ where, text: String(value), line: lineOf(node) });
  };
  const defaults = (owner, where) => {
    if (isMap(owner.defaults) && isMap(owner.defaults.run)) add(`${where}defaults.run.shell`, owner.defaults.run.shell, owner.defaults);
  };
  const steps = (list, where) => {
    (Array.isArray(list) ? list : []).forEach((step, n) => {
      if (!isMap(step)) return;
      const at = `${where}steps[${n}]${step.name ? ` (${step.name})` : ''}`;
      add(`${at} run`, step.run, step);
      add(`${at} shell`, step.shell, step);
      if (isMap(step.with)) add(`${at} with.script`, step.with.script, step);
    });
  };
  if (!isMap(doc)) return out;
  defaults(doc, '');
  for (const [id, job] of Object.entries(isMap(doc.jobs) ? doc.jobs : {})) {
    if (!isMap(job)) continue;
    defaults(job, `jobs.${id}.`);
    steps(job.steps, `jobs.${id}.`);
  }
  if (isMap(doc.runs)) steps(doc.runs.steps, 'runs.');
  return out;
}

function check(rel, text) {
  let parsed;
  try {
    parsed = parse(text);
  } catch (e) {
    return [`${rel}: does not parse as YAML (${e.reason ?? e.message})`];
  }
  const raw = text.split(/\r?\n/);
  const lineOfText = (from, needle) => {
    for (let i = Math.max(0, from - 1); i < raw.length; i++) if (raw[i].includes(needle)) return i + 1;
    return from;
  };
  const problems = [];
  for (const s of scripts(parsed.doc, parsed.lineOf)) {
    for (const expr of expressions(s.text)) problems.push(`${rel}:${lineOfText(s.line, expr)}: ${expr} in ${s.where}`);
  }
  return problems;
}

// Workflows, each with the number of expressions the check must report in it.
const CASES = [
  ['block run, expression on a continuation line', 1, `
on: pull_request
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo start
          if [ -n "x" ]; then
            echo "\${{ github.head_ref }}" \\
              && echo done
          fi
`],
  ['python run', 1, `
on: pull_request
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - shell: python
        run: |
          title = """\${{ github.event.pull_request.title }}"""
          print(title)
`],
  ['github-script script input', 1, `
on: pull_request
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v8
        with:
          script: |
            const title = "\${{ github.event.pull_request.title }}";
            core.info(title);
`],
  ['plain run starting on the next line', 1, `
on: pull_request
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run:
          echo \${{ github.head_ref }}
`],
  ['plain run folded over two lines', 1, `
on: pull_request
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo start &&
          echo \${{ github.head_ref }}
`],
  ['braces inside a string literal', 1, `
on: pull_request
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ format('{0}', github.head_ref) }}
`],
  ['env context pasted into the script', 1, `
on: pull_request
jobs:
  j:
    runs-on: ubuntu-latest
    env:
      BRANCH: \${{ github.head_ref }}
    steps:
      - run: echo \${{ env.BRANCH }}
`],
  ['block run after a blank line, and a folded run', 2, `
on: pull_request
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo one

          echo \${{ github.event.pull_request.title }}
      - run: >-
          echo \${{ inputs.flows }}
`],
  ['shell command, also under defaults', 2, `
on: workflow_dispatch
defaults:
  run:
    shell: \${{ inputs.shell }}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - shell: bash --noprofile -e {0} \${{ inputs.flags }}
        run: echo hi
`],
  ['flow-style step in a composite action', 1, `
runs:
  using: composite
  steps: [{ shell: bash, run: "echo \${{ inputs.name }}" }]
`],
  ['values passed through env', 0, `
on: pull_request
jobs:
  j:
    if: \${{ github.event_name == 'pull_request' }}
    runs-on: ubuntu-latest
    env:
      BRANCH: \${{ github.head_ref }}
    steps:
      - env:
          TITLE: \${{ github.event.pull_request.title }}
        run: echo "$BRANCH $TITLE"
      - uses: actions/github-script@v8
        env:
          TITLE: \${{ github.event.pull_request.title }}
        with:
          script: core.info(process.env.TITLE)
      - uses: actions/upload-artifact@v7
        with:
          path: \${{ env.ZIP }}
`],
];

function selfTest() {
  const failures = [];
  for (const [name, want, text] of CASES) {
    const got = check('case.yml', text);
    if (got.length !== want) failures.push(`case "${name}": expected ${want}, got ${got.length}${got.length ? `\n    ${got.join('\n    ')}` : ''}`);
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`self-test: ${CASES.length} cases as expected`);
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const root = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '.');
  const walk = (dir, out = []) => {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.ya?ml$/.test(name)) out.push(full);
    }
    return out;
  };
  const files = [
    ...walk(path.join(root, '.github', 'workflows')),
    ...walk(path.join(root, '.github', 'actions')),
    ...['action.yml', 'action.yaml'].map((f) => path.join(root, f)).filter(existsSync),
  ];
  const problems = files.flatMap((file) => check(path.relative(root, file).replace(/\\/g, '/'), readFileSync(file, 'utf8')));
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} expression(s) in script text. Pass them through env: instead.`);
    process.exit(1);
  }
  console.log(`ok: ${files.length} file(s), no expression in run:, script: or shell: text`);
}
