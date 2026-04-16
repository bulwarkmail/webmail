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
    const script = '/* @metadata:begin\n{"version":2,"rules":[]}\n@metadata:end */';
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
