import { describe, it, expect } from 'vitest';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import type { FilterCondition, FilterRule } from '@/lib/jmap/sieve-types';

function makeRule(conditions: FilterCondition[], overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'rule-1',
    name: 'Quick',
    enabled: true,
    matchType: 'all',
    conditions,
    actions: [{ type: 'move', value: 'News', mailboxId: 'mb-news' }],
    stopProcessing: true,
    ...overrides,
  };
}

/** The if-block the generator writes for the rule. */
function ruleBlock(script: string): string {
  const start = script.indexOf('# Rule:');
  return script.slice(start).trim();
}

describe('address comparators in the generator', () => {
  it('writes address_is as an exact address test on the parsed From', () => {
    const script = generateScript([makeRule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }])]);
    expect(script).toContain('if address :is "From" "anna@acme.com" {');
    expect(script).not.toContain('header :contains "From"');
  });

  it('writes several senders as one address test with a string list', () => {
    const script = generateScript([
      makeRule([{ field: 'from', comparator: 'address_is', value: ['anna@acme.com', 'bob@example.org'] }]),
    ]);
    expect(script).toContain('if address :is "From" ["anna@acme.com", "bob@example.org"] {');
  });

  it('writes domain_is as an address :domain test', () => {
    const script = generateScript([makeRule([{ field: 'from', comparator: 'domain_is', value: 'acme.com' }])]);
    expect(script).toContain('if address :domain :is "From" "acme.com" {');
  });

  it('writes several domains as a string list', () => {
    const script = generateScript([
      makeRule([{ field: 'from', comparator: 'domain_is', value: ['acme.com', 'example.org'] }]),
    ]);
    expect(script).toContain('address :domain :is "From" ["acme.com", "example.org"]');
  });

  it('uses the right header for To and Cc', () => {
    const script = generateScript([
      makeRule([
        { field: 'to', comparator: 'address_is', value: 'me@acme.com' },
        { field: 'cc', comparator: 'domain_is', value: 'acme.com' },
      ]),
    ]);
    expect(script).toContain('allof(address :is "To" "me@acme.com", address :domain :is "Cc" "acme.com")');
  });

  it('escapes quotes and backslashes in addresses', () => {
    const script = generateScript([makeRule([{ field: 'from', comparator: 'address_is', value: 'a"b\\c@acme.com' }])]);
    expect(script).toContain('address :is "From" "a\\"b\\\\c@acme.com"');
  });

  it('keeps an address comparator on a non-address field readable, as header :contains', () => {
    const script = generateScript([makeRule([{ field: 'subject', comparator: 'address_is', value: 'x' }])]);
    expect(script).toContain('if header :contains "Subject" "x" {');
    expect(script).not.toContain('address ');
  });

  it('needs no extra require for the address test', () => {
    const script = generateScript([
      makeRule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }], {
        actions: [{ type: 'mark_read' }],
      }),
    ]);
    expect(script).toContain('require ["imap4flags"];');
  });

  it('writes the whole quick rule: mailbox id, stop and the spam guard', () => {
    const script = generateScript(
      [makeRule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }])],
      undefined,
      { extensions: ['fileinto', 'mailbox', 'mailboxid', 'spamtestplus', 'relational', 'imap4flags'] },
    );
    expect(ruleBlock(script)).toBe([
      '# Rule: Quick',
      'if allof(address :is "From" "anna@acme.com", not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {',
      '    fileinto :mailboxid "mb-news" "News";',
      '    stop;',
      '}',
    ].join('\n'));
  });

  it('leaves the spam guard off a block rule (includeSpam)', () => {
    const script = generateScript(
      [makeRule([{ field: 'from', comparator: 'address_is', value: 'spam@acme.com' }], {
        actions: [{ type: 'move', value: 'Junk', mailboxId: 'mb-junk' }],
        includeSpam: true,
      })],
      undefined,
      { extensions: ['fileinto', 'mailbox', 'mailboxid', 'spamtestplus', 'relational'] },
    );
    expect(ruleBlock(script)).toBe([
      '# Rule: Quick',
      'if address :is "From" "spam@acme.com" {',
      '    fileinto :mailboxid "mb-junk" "Junk";',
      '    stop;',
      '}',
    ].join('\n'));
  });
});

describe('List-Id condition', () => {
  it('uses the existing header vocabulary', () => {
    const script = generateScript([
      makeRule([{ field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'news.acme.com' }]),
    ]);
    expect(script).toContain('if header :contains "List-Id" "news.acme.com" {');
  });
});

describe('existing comparators are unchanged', () => {
  const cases: Array<[FilterCondition, string]> = [
    [{ field: 'from', comparator: 'contains', value: 'anna@acme.com' }, 'header :contains "From" "anna@acme.com"'],
    [{ field: 'from', comparator: 'is', value: 'Anna <anna@acme.com>' }, 'header :is "From" "Anna <anna@acme.com>"'],
    [{ field: 'from', comparator: 'ends_with', value: '@acme.com' }, 'header :matches "From" "*@acme.com"'],
    [{ field: 'from', comparator: 'starts_with', value: 'anna' }, 'header :matches "From" "anna*"'],
    [{ field: 'to', comparator: 'not_contains', value: 'x' }, 'not header :contains "To" "x"'],
    [{ field: 'cc', comparator: 'not_is', value: 'x' }, 'not header :is "Cc" "x"'],
    [{ field: 'subject', comparator: 'matches', value: 'a*b' }, 'header :matches "Subject" "a*b"'],
    [{ field: 'from', comparator: 'contains', value: ['a', 'b'] }, 'header :contains "From" ["a", "b"]'],
  ];
  it.each(cases)('%j', (condition, expected) => {
    const script = generateScript([makeRule([condition], { actions: [{ type: 'mark_read' }], stopProcessing: false })]);
    expect(script).toContain(`if ${expected} {`);
  });
});

describe('address comparators in the parser', () => {
  it('round-trips through the metadata block', () => {
    const rules = [
      makeRule([{ field: 'from', comparator: 'address_is', value: ['anna@acme.com', 'bob@example.org'] }]),
      makeRule([{ field: 'from', comparator: 'domain_is', value: 'acme.com' }], { id: 'rule-2', name: 'Domain' }),
    ];
    const parsed = parseScript(generateScript(rules));
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules).toEqual(rules);
  });

  it('keeps a rule with an unknown comparator, which the generator writes as header :contains', () => {
    const script = generateScript([]).replace(
      '"rules":[]',
      JSON.stringify({ rules: [makeRule([{ field: 'from', comparator: 'is_similar_to' as never, value: 'anna' }])] }).slice(1, -1),
    );
    const parsed = parseScript(script);
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules[0].conditions[0].comparator).toBe('is_similar_to');
    expect(generateScript(parsed.rules)).toContain('if header :contains "From" "anna" {');
  });

  it('reads address tests in a script without metadata', () => {
    const parsed = parseScript([
      'require ["fileinto"];',
      '# Rule: Hand made',
      'if address :is "from" ["anna@acme.com", "bob@example.org"] {',
      '    fileinto "News";',
      '}',
      'if address :domain :is "From" "acme.com" {',
      '    fileinto "Acme";',
      '}',
      'if address :is :domain "to" "example.org" {',
      '    fileinto "Example";',
      '}',
    ].join('\n'));
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.rules.map(r => r.conditions[0])).toEqual([
      { field: 'from', comparator: 'address_is', value: ['anna@acme.com', 'bob@example.org'] },
      { field: 'from', comparator: 'domain_is', value: 'acme.com' },
      { field: 'to', comparator: 'domain_is', value: 'example.org' },
    ]);
    expect(parsed.rules.every(r => r.origin === 'external')).toBe(true);
  });

  it('leaves address tests it has no builder form for as preserved blocks', () => {
    const parsed = parseScript([
      'if not address :is "from" "anna@acme.com" { discard; }',
      'if address :localpart :is "from" "anna" { discard; }',
      'if address :is "subject" "anna" { discard; }',
    ].join('\n'));
    expect(parsed.rules.map(r => r.origin)).toEqual(['opaque', 'opaque', 'opaque']);
  });
});
