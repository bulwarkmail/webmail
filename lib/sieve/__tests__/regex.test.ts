import { describe, it, expect } from 'vitest';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import { isValidSieveRegex, supportsRegex } from '../regex';
import type { FilterCondition, FilterRule } from '@/lib/jmap/sieve-types';

function makeRule(conditions: FilterCondition[], overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'rule-1',
    name: 'Cron mail',
    enabled: true,
    matchType: 'any',
    conditions,
    actions: [{ type: 'move', value: 'wartung' }],
    stopProcessing: true,
    ...overrides,
  };
}

function requireLine(script: string): string {
  return script.split('\n').find((l) => l.startsWith('require ')) ?? '';
}

function metadataVersion(script: string): number {
  const json = script.split('\n')[1];
  return JSON.parse(json).version;
}

describe('regex conditions in the generator', () => {
  it('writes header :regex and requires "regex"', () => {
    const script = generateScript([
      makeRule([{ field: 'subject', comparator: 'regex', value: '^Cron.*|^Anacron.*Job.*|.*mailman.*moderator.*request.*' }]),
    ]);
    expect(script).toContain('if header :regex "Subject" "^Cron.*|^Anacron.*Job.*|.*mailman.*moderator.*request.*" {');
    expect(requireLine(script)).toContain('"regex"');
  });

  it('doubles backslashes so Sieve hands the server the expression as typed', () => {
    const script = generateScript([
      makeRule([{ field: 'from', comparator: 'regex', value: '@(onedomain\\.com|otherdomain\\.de)' }]),
    ]);
    expect(script).toContain('header :regex "From" "@(onedomain\\\\.com|otherdomain\\\\.de)"');
  });

  it('writes a custom header and the body with :regex', () => {
    const script = generateScript([
      makeRule([
        { field: 'header', headerName: 'List-Id', comparator: 'regex', value: 'dev-[0-9]+' },
        { field: 'body', comparator: 'regex', value: 'inv[0-9]{4,6}' },
      ]),
    ]);
    expect(script).toContain('header :regex "List-Id" "dev-[0-9]+"');
    expect(script).toContain('body :regex "inv[0-9]{4,6}"');
    expect(requireLine(script)).toContain('"body"');
    expect(requireLine(script)).toContain('"regex"');
  });

  it('requires "regex" only when an enabled rule uses it', () => {
    const plain = generateScript([makeRule([{ field: 'subject', comparator: 'contains', value: 'Cron' }])]);
    expect(requireLine(plain)).not.toContain('"regex"');
    const disabled = generateScript([
      makeRule([{ field: 'subject', comparator: 'regex', value: '^Cron' }], { enabled: false }),
    ]);
    expect(requireLine(disabled)).not.toContain('"regex"');
    expect(disabled).not.toContain(':regex');
  });

  it('marks the metadata version 2 so older builds leave the rule alone', () => {
    expect(metadataVersion(generateScript([makeRule([{ field: 'subject', comparator: 'contains', value: 'Cron' }])]))).toBe(1);
    expect(metadataVersion(generateScript([makeRule([{ field: 'subject', comparator: 'regex', value: '^Cron' }])]))).toBe(2);
  });
});

describe('regex conditions in the parser', () => {
  it('reads a saved regex rule back unchanged', () => {
    const rule = makeRule([
      { field: 'from', comparator: 'regex', value: '@(onedomain\\.com|otherdomain\\.de)' },
      { field: 'body', comparator: 'regex', value: 'a{1,3}' },
    ]);
    const parsed = parseScript(generateScript([rule]));
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules[0].conditions).toEqual(rule.conditions);
  });

  it('imports a hand-written header :regex rule as a regex condition', () => {
    const parsed = parseScript([
      'require ["fileinto", "regex"];',
      'if anyof(header :regex "Subject" "^Cron.*|^Anacron.*Job.*") {',
      '    fileinto "wartung";',
      '    stop;',
      '}',
    ].join('\n'));
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules[0].conditions).toEqual([
      { field: 'subject', comparator: 'regex', value: '^Cron.*|^Anacron.*Job.*' },
    ]);
  });

  it('does not read "not header :regex" as a positive match', () => {
    const parsed = parseScript([
      'require ["fileinto", "regex"];',
      'if not header :regex "Subject" "^Cron" {',
      '    fileinto "wartung";',
      '}',
    ].join('\n'));
    const conditions = parsed.rules.flatMap((r) => r.conditions);
    expect(conditions).not.toContainEqual({ field: 'subject', comparator: 'regex', value: '^Cron' });
  });
});

describe('regex helpers', () => {
  it('needs the server to list the extension', () => {
    expect(supportsRegex(['fileinto', 'regex'])).toBe(true);
    expect(supportsRegex(['fileinto'])).toBe(false);
    expect(supportsRegex(undefined)).toBe(false);
  });

  it('accepts expressions the server compiles, including Rust inline flags', () => {
    expect(isValidSieveRegex('^Cron.*|mailman')).toBe(true);
    expect(isValidSieveRegex('a{1,3}')).toBe(true);
    expect(isValidSieveRegex('(?i)^cron')).toBe(true);
    expect(isValidSieveRegex('(?i:cron)job')).toBe(true);
    expect(isValidSieveRegex('(?P<user>[a-z]+)@')).toBe(true);
  });

  it('rejects expressions the server refuses', () => {
    expect(isValidSieveRegex('(unclosed')).toBe(false);
    expect(isValidSieveRegex('[abc')).toBe(false);
    expect(isValidSieveRegex('*abc')).toBe(false);
    expect(isValidSieveRegex('')).toBe(false);
  });
});
