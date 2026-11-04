import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Usability 2026-11-04, settings-37: wording in the admin panel that was
// wrong or a developer's. Each entry is a phrase that must not come back,
// with what replaced it.
const BANNED: Array<{ phrase: RegExp; why: string }> = [
  { phrase: /automagic/i, why: 'say "Set up with Stalwart"' },
  { phrase: /on their next login/, why: 'policy changes reach open tabs within 15 minutes; plugins and themes on the next load' },
  { phrase: /Settings > Templates/, why: 'templates are in Settings > Composing > Email templates' },
  { phrase: /\(Organisation > |See Organisation > |User policy >/, why: 'the sidebar heading is "Users" and the page "Features and settings"' },
];

const ROOTS = ['app/(main)/admin', 'components/admin', 'lib/admin'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('admin wording', () => {
  it('has none of the phrases the usability pass replaced', () => {
    const root = process.cwd();
    const hits: string[] = [];
    for (const file of ROOTS.flatMap((r) => files(join(root, r)))) {
      const text = readFileSync(file, 'utf8');
      text.split(/\r?\n/).forEach((line, i) => {
        // Comments may name the old place.
        if (/^\s*(\*|\/\/)/.test(line)) return;
        for (const { phrase, why } of BANNED) {
          if (phrase.test(line)) hits.push(`${relative(root, file)}:${i + 1}: ${why}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
