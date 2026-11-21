import { describe, it, expect } from 'vitest';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import type { FilterCondition, FilterRule } from '@/lib/jmap/sieve-types';

function makeRule(conditions: FilterCondition[], overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'rule-1',
    name: 'Alias',
    enabled: true,
    matchType: 'all',
    conditions,
    actions: [{ type: 'add_label', value: 'shop' }],
    stopProcessing: false,
    ...overrides,
  };
}

function metadataVersion(script: string): number {
  return JSON.parse(script.slice(script.indexOf('{'), script.indexOf('\n@metadata:end'))).version;
}

describe('"Delivered to" in the generator (#726)', () => {
  it('writes "is the address" as an envelope test on the recipient and requires envelope', () => {
    const script = generateScript([makeRule([{ field: 'delivered_to', comparator: 'address_is', value: 'shop@example.com' }])]);
    expect(script).toContain('if envelope :is "to" "shop@example.com" {');
    expect(script).toContain('require ["envelope", "imap4flags"];');
  });

  it('writes "has the domain" as envelope :domain :is, with several values as a list', () => {
    const script = generateScript([makeRule([{ field: 'delivered_to', comparator: 'domain_is', value: ['example.com', 'example.org'] }])]);
    expect(script).toContain('if envelope :domain :is "to" ["example.com", "example.org"] {');
  });

  it('writes "contains" as envelope :contains, escaping quotes and backslashes', () => {
    const script = generateScript([makeRule([{ field: 'delivered_to', comparator: 'contains', value: 'a"b\\c' }])]);
    expect(script).toContain('if envelope :contains "to" "a\\"b\\\\c" {');
  });

  it('marks the metadata as version 2, which older builds leave alone', () => {
    expect(metadataVersion(generateScript([makeRule([{ field: 'from', comparator: 'contains', value: 'x' }])]))).toBe(1);
    expect(metadataVersion(generateScript([makeRule([{ field: 'delivered_to', comparator: 'address_is', value: 'x@example.com' }])]))).toBe(2);
  });

  it('does not require envelope for a disabled rule', () => {
    const script = generateScript([
      makeRule([{ field: 'delivered_to', comparator: 'address_is', value: 'x@example.com' }], { enabled: false }),
    ]);
    expect(script).not.toContain('"envelope"');
  });
});

describe('"Delivered to" in the parser (#726)', () => {
  it('round-trips through the metadata block, and a second save writes the same script', () => {
    const rules = [
      makeRule([{ field: 'delivered_to', comparator: 'address_is', value: ['shop@example.com', 'news@example.com'] }]),
      makeRule([{ field: 'delivered_to', comparator: 'domain_is', value: 'example.org' }], { id: 'rule-2', name: 'Domain' }),
      makeRule(
        [{ field: 'delivered_to', comparator: 'contains', value: '+lists' }, { field: 'subject', comparator: 'contains', value: 'x' }],
        { id: 'rule-3', name: 'Mixed', matchType: 'any' },
      ),
    ];
    const script = generateScript(rules);
    const parsed = parseScript(script);
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules).toEqual(rules);
    expect(generateScript(parsed.rules, undefined, { externalRequires: parsed.externalRequires })).toBe(script);
  });

  it('reads envelope tests on the recipient in a script without metadata', () => {
    const parsed = parseScript([
      'require ["envelope", "fileinto"];',
      'if envelope :is "to" ["shop@example.com", "news@example.com"] {',
      '    fileinto "Shop";',
      '}',
      'if envelope :domain :is "To" "example.org" {',
      '    fileinto "Org";',
      '}',
      'if envelope :is :domain "to" "example.net" {',
      '    fileinto "Net";',
      '}',
      'if envelope :all :contains "to" "+lists" {',
      '    fileinto "Lists";',
      '}',
    ].join('\n'));
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules.map(r => r.conditions[0])).toEqual([
      { field: 'delivered_to', comparator: 'address_is', value: ['shop@example.com', 'news@example.com'] },
      { field: 'delivered_to', comparator: 'domain_is', value: 'example.org' },
      { field: 'delivered_to', comparator: 'domain_is', value: 'example.net' },
      { field: 'delivered_to', comparator: 'contains', value: '+lists' },
    ]);
    expect(parsed.rules.every(r => r.origin === 'external')).toBe(true);
  });

  it('leaves envelope tests it has no builder form for as preserved blocks', () => {
    const parsed = parseScript([
      'if envelope :is "from" "anna@acme.com" { discard; }',
      'if not envelope :is "to" "shop@example.com" { discard; }',
      'if envelope :localpart :is "to" "shop" { discard; }',
      'if envelope :domain :contains "to" "example" { discard; }',
      'if envelope :matches "to" "*@example.com" { discard; }',
    ].join('\n'));
    expect(parsed.rules.map(r => r.origin)).toEqual(['opaque', 'opaque', 'opaque', 'opaque', 'opaque']);
  });
});
