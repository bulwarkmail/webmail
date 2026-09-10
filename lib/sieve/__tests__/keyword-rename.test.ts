import { describe, it, expect } from 'vitest';
import { countKeywordUses, renameKeywordInRules } from '../keyword-rename';
import type { FilterRule } from '@/lib/jmap/sieve-types';

const makeRule = (overrides: Partial<FilterRule> = {}): FilterRule => ({
  id: 'rule-1',
  name: 'ISO',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'iso.org' }],
  actions: [{ type: 'add_label', value: 'red' }],
  stopProcessing: false,
  ...overrides,
});

describe('renameKeywordInRules', () => {
  it('rewrites an add_label action that names the old tag', () => {
    const { rules, changed } = renameKeywordInRules([makeRule()], 'red', 'iso');
    expect(changed).toBe(1);
    expect(rules[0].actions[0]).toEqual({ type: 'add_label', value: 'iso' });
  });

  it('leaves actions naming a different tag alone', () => {
    const rules = [makeRule({ actions: [{ type: 'add_label', value: 'blue' }] })];
    const result = renameKeywordInRules(rules, 'red', 'iso');
    expect(result.changed).toBe(0);
    expect(result.rules[0].actions[0].value).toBe('blue');
  });

  it('leaves actions of other types alone even when the value collides', () => {
    const rules = [makeRule({ actions: [{ type: 'move', value: 'red' }] })];
    const result = renameKeywordInRules(rules, 'red', 'iso');
    expect(result.changed).toBe(0);
    expect(result.rules[0].actions[0].value).toBe('red');
  });

  it('counts every action it rewrites, across rules', () => {
    const rules = [
      makeRule({ id: 'r1' }),
      makeRule({ id: 'r2', actions: [{ type: 'star' }, { type: 'add_label', value: 'red' }] }),
    ];
    expect(renameKeywordInRules(rules, 'red', 'iso').changed).toBe(2);
  });

  it('rewrites a disabled rule too, so enabling it later still tags correctly', () => {
    const { changed, rules } = renameKeywordInRules([makeRule({ enabled: false })], 'red', 'iso');
    expect(changed).toBe(1);
    expect(rules[0].actions[0].value).toBe('iso');
  });

  it('does nothing when the id is unchanged', () => {
    const rules = [makeRule()];
    const result = renameKeywordInRules(rules, 'red', 'red');
    expect(result).toEqual({ rules, changed: 0 });
    expect(result.rules).toBe(rules);
  });

  it('does not mutate the rules it was given', () => {
    const rules = [makeRule()];
    renameKeywordInRules(rules, 'red', 'iso');
    expect(rules[0].actions[0].value).toBe('red');
  });

  it('rewrites the raw block of an external rule, which is emitted verbatim', () => {
    const rules = [
      makeRule({
        origin: 'external',
        rawBlock: '# hand written\nif header :contains "From" "iso.org" {\n    addflag "$label:red";\n}',
      }),
    ];
    const { rules: renamed, changed } = renameKeywordInRules(rules, 'red', 'iso');
    expect(changed).toBe(1);
    expect(renamed[0].rawBlock).toContain('addflag "$label:iso";');
    expect(renamed[0].rawBlock).not.toContain('$label:red');
  });

  it('rewrites only the addflag operand of a raw block, not a matching test string', () => {
    const rules = [
      makeRule({
        origin: 'external',
        rawBlock: 'if header :contains "X-Tag" "$label:red" {\n    addflag "$label:red";\n}',
      }),
    ];
    const { rules: renamed, changed } = renameKeywordInRules(rules, 'red', 'iso');
    expect(changed).toBe(1);
    expect(renamed[0].rawBlock).toContain('addflag "$label:iso";');
    expect(renamed[0].rawBlock).toContain('header :contains "X-Tag" "$label:red"');
  });

  it('leaves an opaque rule, which has no parsed actions, untouched', () => {
    const rules = [
      makeRule({
        origin: 'opaque',
        actions: [],
        conditions: [],
        rawBlock: '# unparseable\nif anyof (true) {\n    addflag "$label:red";\n}',
      }),
    ];
    const result = renameKeywordInRules(rules, 'red', 'iso');
    expect(result.changed).toBe(0);
    expect(result.rules[0].rawBlock).toContain('$label:red');
  });

  it('does not touch a raw block whose keyword only shares a prefix with the old id', () => {
    const rules = [
      makeRule({
        origin: 'external',
        actions: [{ type: 'add_label', value: 'red-alert' }],
        rawBlock: 'if true {\n    addflag "$label:red-alert";\n}',
      }),
    ];
    const { rules: renamed, changed } = renameKeywordInRules(rules, 'red', 'iso');
    expect(changed).toBe(0);
    expect(renamed[0].rawBlock).toContain('$label:red-alert');
  });

  it('rewrites a nested id without treating its separator as a pattern', () => {
    const rules = [
      makeRule({
        actions: [{ type: 'add_label', value: 'work/clients' }],
        origin: 'external',
        rawBlock: 'if true {\n    addflag "$label:work/clients";\n}',
      }),
    ];
    const { rules: renamed, changed } = renameKeywordInRules(rules, 'work/clients', 'work/acme');
    expect(changed).toBe(1);
    expect(renamed[0].actions[0].value).toBe('work/acme');
    expect(renamed[0].rawBlock).toContain('addflag "$label:work/acme";');
  });
});

describe('countKeywordUses', () => {
  it('counts the keyword as it is written in a script', () => {
    const script = 'if true {\n    addflag "$label:red";\n}\nif false {\n    addflag "$label:red";\n}';
    expect(countKeywordUses(script, 'red')).toBe(2);
  });

  it('does not count a keyword that merely starts with the id', () => {
    expect(countKeywordUses('addflag "$label:red-alert";', 'red')).toBe(0);
  });

  it('returns zero for a script that never names the tag', () => {
    expect(countKeywordUses('addflag "\\\\Seen";', 'red')).toBe(0);
  });

  it('counts the tag in a multi-flag argument, which is one Sieve string', () => {
    // RFC 5232 section 3.2: the argument is a space-separated flag list, so the
    // keyword is not always followed by the closing quote.
    expect(countKeywordUses('addflag "$label:red \\\\Seen";', 'red')).toBe(1);
    expect(countKeywordUses('addflag "\\\\Seen $label:red";', 'red')).toBe(1);
  });

  it('still does not count a longer tag that starts with the id', () => {
    expect(countKeywordUses('addflag "$label:red-alert \\\\Seen";', 'red')).toBe(0);
  });
});
