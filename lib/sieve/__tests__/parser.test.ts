import { describe, it, expect } from 'vitest';
import { parseScript } from '../parser';
import { generateScript } from '../generator';
import type { FilterRule } from '@/lib/jmap/sieve-types';

function makeRule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'test@example.com' }],
    actions: [{ type: 'move', value: 'Archive' }],
    stopProcessing: false,
    ...overrides,
  };
}

describe('parseScript', () => {
  it('extracts rules from valid metadata', () => {
    const rules = [makeRule()];
    const script = generateScript(rules);
    const result = parseScript(script);
    expect(result.isOpaque).toBe(false);
    expect(result.rules).toEqual(rules);
  });

  it('parses external rules when no Bulwark metadata is present', () => {
    const result = parseScript('require ["fileinto"];\nif header :contains "From" "x" { fileinto "Y"; }');
    expect(result.isOpaque).toBe(false);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].origin).toBe('external');
    expect(result.rules[0].conditions[0]).toMatchObject({ field: 'from', comparator: 'contains', value: 'x' });
    expect(result.rules[0].actions[0]).toEqual({ type: 'move', value: 'Y' });
    expect(result.externalRequires).toContain('fileinto');
  });

  it('returns isOpaque for corrupted JSON', () => {
    const script = '/* @metadata:begin\n{not valid json\n@metadata:end */';
    const result = parseScript(script);
    expect(result.isOpaque).toBe(true);
    expect(result.rules).toEqual([]);
  });

  it('returns isOpaque for version mismatch', () => {
    const script = '/* @metadata:begin\n{"version":3,"rules":[]}\n@metadata:end */';
    const result = parseScript(script);
    expect(result.isOpaque).toBe(true);
    expect(result.rules).toEqual([]);
  });

  it('returns isOpaque for empty metadata block', () => {
    const script = '/* @metadata:begin\n\n@metadata:end */';
    const result = parseScript(script);
    expect(result.isOpaque).toBe(true);
    expect(result.rules).toEqual([]);
  });

  it('returns isOpaque for missing rules array', () => {
    const script = '/* @metadata:begin\n{"version":1}\n@metadata:end */';
    const result = parseScript(script);
    expect(result.isOpaque).toBe(true);
    expect(result.rules).toEqual([]);
  });

  it('returns isOpaque for invalid rule objects', () => {
    const script = '/* @metadata:begin\n{"version":1,"rules":[{"id":"x"}]}\n@metadata:end */';
    const result = parseScript(script);
    expect(result.isOpaque).toBe(true);
    expect(result.rules).toEqual([]);
  });

  it('handles metadata with extra whitespace', () => {
    const rules = [makeRule()];
    const json = JSON.stringify({ version: 1, rules });
    const script = `/* @metadata:begin\n   ${json}   \n@metadata:end */\n\nrequire ["fileinto"];`;
    const result = parseScript(script);
    expect(result.isOpaque).toBe(false);
    expect(result.rules).toEqual(rules);
  });

  it('handles script with only metadata block', () => {
    const rules = [makeRule({ enabled: false })];
    const json = JSON.stringify({ version: 1, rules });
    const script = `/* @metadata:begin\n${json}\n@metadata:end */`;
    const result = parseScript(script);
    expect(result.isOpaque).toBe(false);
    expect(result.rules).toEqual(rules);
  });

  it('returns isOpaque for missing end marker', () => {
    const script = '/* @metadata:begin\n{"version":1,"rules":[]}';
    const result = parseScript(script);
    expect(result.isOpaque).toBe(true);
  });

  it('treats an empty string as an empty, editable script (not opaque)', () => {
    const result = parseScript('');
    expect(result.isOpaque).toBe(false);
    expect(result.rules).toEqual([]);
  });

  describe('round-trip', () => {
    it('preserves complex rules through generate → parse', () => {
      const rules: FilterRule[] = [
        makeRule({ id: '1', name: 'Newsletter', enabled: true, stopProcessing: true }),
        makeRule({
          id: '2',
          name: 'VIP',
          matchType: 'any',
          conditions: [
            { field: 'from', comparator: 'is', value: 'boss@company.com' },
            { field: 'from', comparator: 'is', value: 'ceo@company.com' },
          ],
          actions: [{ type: 'star' }, { type: 'mark_read' }],
        }),
        makeRule({ id: '3', name: 'Disabled', enabled: false }),
      ];
      const script = generateScript(rules);
      const result = parseScript(script);
      expect(result.isOpaque).toBe(false);
      expect(result.rules).toEqual(rules);
    });

    it('reads a rule whose name has runs of whitespace back as one rule, save after save', () => {
      // A hand-written block, and one that only looks like Bulwark's.
      const external = '# Hand\nif header :contains "subject" "hand" {\n    keep;\n}\n'
        + '# Rule: Someone else\nif header :contains "subject" "other" {\n    keep;\n}\n';
      const rules = [
        makeRule({ id: '1', name: 'Foo  Bar' }),
        makeRule({ id: '2', name: ' Tab\tand  trailing ' }),
        // No-break and ideographic spaces count as whitespace too.
        makeRule({ id: '3', name: 'Büro 　Post' }),
        // Not possible in the editor, but in metadata written elsewhere.
        makeRule({ id: '4', name: '' }),
      ];
      let script = `${generateScript(rules)}\n${external}`;
      for (let save = 0; save < 3; save++) {
        const result = parseScript(script);
        expect(result.isOpaque).toBe(false);
        // The four rules, and each other block once.
        const own = result.rules.filter((r) => (r.origin ?? 'bulwark') === 'bulwark');
        expect(own.map((r) => r.id)).toEqual(['1', '2', '3', '4']);
        expect(result.rules.length - own.length).toBe(2);
        script = generateScript(result.rules, result.vacation, { externalRequires: result.externalRequires });
      }
      expect(script.split('# Rule: Foo Bar\n').length).toBe(2);
      expect(script.split('# Rule: Büro Post\n').length).toBe(2);
      expect(script.split('# Rule: \n').length).toBe(2);
      expect(script.split('if header :contains "subject" "hand"').length).toBe(2);
      expect(script.split('# Rule: Someone else').length).toBe(2);
    });

    it('takes a block written before names were collapsed for the rule itself', () => {
      // Up to 1.11.0 the "# Rule:" line carried the name as typed.
      const rule = makeRule({ id: '1', name: 'Foo  Bar' });
      const asWritten = generateScript([rule]).replace('# Rule: Foo Bar', '# Rule: Foo  Bar');
      expect(asWritten).toContain('# Rule: Foo  Bar');
      expect(parseScript(asWritten).rules).toEqual([rule]);
    });

    it('drops the copies of such a rule an earlier save left behind', () => {
      const rule = makeRule({ id: '1', name: 'Foo  Bar' });
      const block = generateScript([rule]).slice(generateScript([rule]).indexOf('# Rule: Foo Bar'));
      // As written before: the rule, and two copies read back as someone else's.
      const withCopies = `${generateScript([rule])}\n# --- External rules (managed outside Bulwark) ---\n${block}\n${block}`;
      const result = parseScript(withCopies);
      expect(result.rules).toEqual([rule]);
      expect(generateScript(result.rules).split('# Rule: Foo Bar').length).toBe(2);
    });

    it('preserves rules with special characters', () => {
      const rules = [makeRule({
        conditions: [{ field: 'subject', comparator: 'contains', value: 'say "hello" \\ world' }],
        actions: [{ type: 'move', value: 'My "Folder"' }],
      })];
      const script = generateScript(rules);
      const result = parseScript(script);
      expect(result.rules).toEqual(rules);
    });

    it('preserves all action types', () => {
      const rules = [makeRule({
        actions: [
          { type: 'move', value: 'Folder' },
          { type: 'copy', value: 'Backup' },
          { type: 'forward', value: 'fwd@x.com' },
          { type: 'mark_read' },
          { type: 'star' },
          { type: 'add_label', value: 'Tag' },
          { type: 'keep' },
        ],
      })];
      const script = generateScript(rules);
      const result = parseScript(script);
      expect(result.rules).toEqual(rules);
    });
  });

  describe('validation edge cases', () => {
    it('returns isOpaque when rule has non-string id', () => {
      const script = `/* @metadata:begin\n${JSON.stringify({ version: 1, rules: [{ id: 123, name: 'x', enabled: true, matchType: 'all', conditions: [{ field: 'from', comparator: 'contains', value: 'a' }], actions: [{ type: 'keep' }], stopProcessing: false }] })}\n@metadata:end */`;
      expect(parseScript(script).isOpaque).toBe(true);
    });

    it('returns isOpaque when rule has non-boolean enabled', () => {
      const script = `/* @metadata:begin\n${JSON.stringify({ version: 1, rules: [{ id: '1', name: 'x', enabled: 'yes', matchType: 'all', conditions: [{ field: 'from', comparator: 'contains', value: 'a' }], actions: [{ type: 'keep' }], stopProcessing: false }] })}\n@metadata:end */`;
      expect(parseScript(script).isOpaque).toBe(true);
    });

    it('returns isOpaque when rule has invalid matchType', () => {
      const script = `/* @metadata:begin\n${JSON.stringify({ version: 1, rules: [{ id: '1', name: 'x', enabled: true, matchType: 'none', conditions: [{ field: 'from', comparator: 'contains', value: 'a' }], actions: [{ type: 'keep' }], stopProcessing: false }] })}\n@metadata:end */`;
      expect(parseScript(script).isOpaque).toBe(true);
    });

    it('returns isOpaque when condition missing value', () => {
      const script = `/* @metadata:begin\n${JSON.stringify({ version: 1, rules: [{ id: '1', name: 'x', enabled: true, matchType: 'all', conditions: [{ field: 'from', comparator: 'contains' }], actions: [{ type: 'keep' }], stopProcessing: false }] })}\n@metadata:end */`;
      expect(parseScript(script).isOpaque).toBe(true);
    });

    it('returns isOpaque when action missing type', () => {
      const script = `/* @metadata:begin\n${JSON.stringify({ version: 1, rules: [{ id: '1', name: 'x', enabled: true, matchType: 'all', conditions: [{ field: 'from', comparator: 'contains', value: 'a' }], actions: [{ value: 'Inbox' }], stopProcessing: false }] })}\n@metadata:end */`;
      expect(parseScript(script).isOpaque).toBe(true);
    });

    it('accepts valid empty rules array', () => {
      const script = `/* @metadata:begin\n${JSON.stringify({ version: 1, rules: [] })}\n@metadata:end */`;
      const result = parseScript(script);
      expect(result.isOpaque).toBe(false);
      expect(result.rules).toEqual([]);
    });

    it('preserves all comparator types through round-trip', () => {
      const comparators = ['contains', 'not_contains', 'is', 'not_is', 'starts_with', 'ends_with', 'matches'] as const;
      const rules = comparators.map((comparator, i) => makeRule({
        id: `r${i}`,
        name: `Rule ${comparator}`,
        conditions: [{ field: 'from', comparator, value: 'test' }],
      }));
      const script = generateScript(rules);
      const result = parseScript(script);
      expect(result.isOpaque).toBe(false);
      expect(result.rules).toEqual(rules);
    });

    it('preserves size comparators through round-trip', () => {
      const rules = [
        makeRule({ id: 'r1', conditions: [{ field: 'size', comparator: 'greater_than', value: '1000' }], actions: [{ type: 'discard' }] }),
        makeRule({ id: 'r2', conditions: [{ field: 'size', comparator: 'less_than', value: '500' }], actions: [{ type: 'keep' }] }),
      ];
      const script = generateScript(rules);
      const result = parseScript(script);
      expect(result.rules).toEqual(rules);
    });

    it('preserves header field with custom headerName', () => {
      const rules = [makeRule({
        conditions: [{ field: 'header', comparator: 'contains', value: 'test', headerName: 'X-My-Header' }],
      })];
      const script = generateScript(rules);
      const result = parseScript(script);
      expect(result.rules).toEqual(rules);
    });
  });
});
