#!/usr/bin/env node
// Fails (exit 1) while a `run:` block in a workflow or composite action contains a ${{ }}
// expression whose value someone outside the workflow file chooses: event payload fields,
// workflow inputs, head refs, and job or step outputs (which often carry one of those).
// The fix is always the same: put the value in `env:` and use "$NAME" in the script.
//
//   node scripts/check-run-expressions.mjs [repo root]
//
// Run from the lint job of .github/workflows/tests.yml.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else if (/\.ya?ml$/.test(name)) out.push(full);
  }
  return out;
};
const files = [...walk(path.join(root, '.github', 'workflows')), ...walk(path.join(root, '.github', 'actions'))];

// Values that are fixed by GitHub or by the workflow file itself.
const SAFE = /^(github\.(sha|run_id|run_number|run_attempt|repository|repository_owner|event_name|workspace|job|actor_id|ref_type)|runner\.[a-z_]+|matrix\.[\w.-]+|env\.[A-Z_][A-Z0-9_]*|secrets\.[A-Z0-9_]+|vars\.[A-Z0-9_]+|steps\.[\w-]+\.(outcome|conclusion)|job\.status)$/;

const problems = [];
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let inRun = false, runIndent = 0;
  lines.forEach((line, i) => {
    const indent = line.match(/^\s*/)[0].length;
    const m = line.match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (m) {
      runIndent = m[1].length + (line.trimStart().startsWith('-') ? 2 : 0);
      inRun = /^[|>]/.test(m[2]);
      if (!inRun) check(m[2], i);
      return;
    }
    if (inRun) {
      if (line.trim() !== '' && indent <= runIndent) { inRun = false; return; }
      check(line, i);
    }
  });
  function check(text, i) {
    for (const [, expr] of text.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) {
      const parts = expr.split(/\s*(?:\|\||&&|==|!=)\s*/).map((p) => p.trim()).filter((p) => !/^('.*'|\d+|true|false)$/.test(p));
      const risky = parts.filter((p) => !SAFE.test(p));
      if (risky.length) problems.push(`${rel}:${i + 1}: \${{ ${expr} }} inside run:`);
    }
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} expression(s) in run: blocks. Pass them through env: instead.`);
  process.exit(1);
}
console.log(`ok: ${files.length} file(s), no outside value pasted into a run: block`);
