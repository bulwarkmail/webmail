import { describe, expect, it } from 'vitest';
import type { FilterRule, VacationSieveConfig } from '@/lib/jmap/sieve-types';
import { generateScript, type GenerateOptions } from '../generator';
import { parseScript } from '../parser';

const EXTENSIONS = [
  'fileinto', 'mailbox', 'mailboxid', 'imap4flags', 'include', 'copy', 'date', 'relational',
  'spamtestplus', 'comparator-i;ascii-numeric', 'body', 'vacation', 'envelope', 'reject',
];

const rules: FilterRule[] = [
  {
    id: 'r1', name: 'Boersen', enabled: true, matchType: 'any',
    conditions: [
      { field: 'from', comparator: 'contains', value: ['autoscout24', 'mobile.de'] },
      { field: 'subject', comparator: 'starts_with', value: 'Anfrage' },
    ],
    actions: [{ type: 'move', value: 'INBOX/Boersen', mailboxId: 'mb-1' }, { type: 'mark_read' }],
    stopProcessing: true,
  },
  {
    id: 'r2', name: 'Chef', enabled: true, matchType: 'all',
    conditions: [{ field: 'from', comparator: 'address_is', value: 'chef@example.com' }],
    actions: [{ type: 'forward', value: 'kollege@example.com', keepCopy: true }, { type: 'star' }],
    stopProcessing: false,
  },
  {
    id: 'r3', name: 'Gross', enabled: false, matchType: 'all',
    conditions: [{ field: 'size', comparator: 'greater_than', value: '1000000' }],
    actions: [{ type: 'discard' }],
    stopProcessing: false, includeSpam: true,
  },
];
const external: FilterRule = {
  id: 'ext-1', name: 'Hand', enabled: true, matchType: 'all', conditions: [], actions: [], stopProcessing: false,
  origin: 'external', rawBlock: '# Hand\nif header :contains "subject" "hand" {\n    keep;\n}',
};
const vacation: VacationSieveConfig = { isEnabled: true, subject: 'Weg', textBody: 'Bin weg' };

const RULE_BLOCKS = [
  '# Rule: Boersen',
  'if allof(anyof(header :contains "From" ["autoscout24", "mobile.de"], header :matches "Subject" "Anfrage*"), not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50") {',
  '    addflag "\\\\Seen";',
  '    fileinto :mailboxid "mb-1" "INBOX/Boersen";',
  '    stop;',
  '}',
  '',
  '# Rule: Chef',
  'if address :is "From" "chef@example.com" {',
  '    addflag "\\\\Flagged";',
  '    redirect :copy "kollege@example.com";',
  '}',
  '',
];

// What the generator wrote for these before rules had periods and the
// vacation card had forwarding and reply recipients, taken from it as it was
// then (0409bde8). Every account's script is rewritten on its next save, so a
// script without the new fields must still come out byte for byte the same.
const BEFORE: Record<string, { args: [FilterRule[], VacationSieveConfig | undefined, GenerateOptions]; script: string }> = {
  'rules next to the vacation include': {
    args: [rules, undefined, { includeVacation: true, extensions: EXTENSIONS }],
    script: [
      '/* @metadata:begin',
      JSON.stringify({ version: 1, rules, includeVacation: true }),
      '@metadata:end */',
      '',
      'require ["comparator-i;ascii-numeric", "copy", "fileinto", "imap4flags", "include", "mailbox", "mailboxid", "relational", "spamtestplus"];',
      '',
      '# Vacation auto-reply',
      'include :personal :optional "vacation";',
      '',
      ...RULE_BLOCKS,
    ].join('\n'),
  },
  'rules, an external block and the vacation written in': {
    args: [[...rules, external], vacation, { externalRequires: ['body'], extensions: EXTENSIONS }],
    script: [
      '/* @metadata:begin',
      JSON.stringify({ version: 1, rules, vacation }),
      '@metadata:end */',
      '',
      'require ["body", "comparator-i;ascii-numeric", "copy", "fileinto", "imap4flags", "mailbox", "mailboxid", "relational", "spamtestplus", "vacation"];',
      '',
      '# Vacation auto-reply',
      'vacation :subject "Weg" "Bin weg";',
      '',
      ...RULE_BLOCKS,
      '# --- External rules (managed outside Bulwark) ---',
      '# Hand',
      'if header :contains "subject" "hand" {',
      '    keep;',
      '}',
      '',
    ].join('\n'),
  },
  'only the vacation include': {
    args: [[], undefined, { includeVacation: true, extensions: EXTENSIONS }],
    script: [
      '/* @metadata:begin',
      '{"version":1,"rules":[],"includeVacation":true}',
      '@metadata:end */',
      '',
      'require ["include"];',
      '',
      '# Vacation auto-reply',
      'include :personal :optional "vacation";',
      '',
    ].join('\n'),
  },
};

describe('a script without periods, forwarding or reply recipients', () => {
  it('comes out exactly as before these existed', () => {
    for (const [name, { args: [r, v, options], script }] of Object.entries(BEFORE)) {
      expect(generateScript(r, v, options), name).toBe(script);
      // The stores pass "none" for both.
      expect(generateScript(r, v, { ...options, vacationForward: null, vacationAudience: null }), name).toBe(script);
    }
  });
});

describe('the metadata version', () => {
  const period = { activeFrom: '2026-10-05T06:00:00.000Z', activeUntil: '2026-10-16T16:00:00.000Z' };
  const versionOf = (script: string) => (JSON.parse(script.split('\n')[1]) as { version: number }).version;
  const generate = (r: FilterRule[], options: GenerateOptions = {}) =>
    generateScript(r, undefined, { extensions: EXTENSIONS, ...options });

  it('is 2 once an older build would drop something, so that it leaves the script alone', () => {
    // An older build takes version 1 as its own and writes it back without
    // what it does not know: the rule would forward for good, the auto-reply
    // would go to everyone.
    expect(versionOf(generate([{ ...rules[1], ...period }]))).toBe(2);
    // A rule that is off keeps its period for when it is on again.
    expect(versionOf(generate([{ ...rules[2], activeUntil: period.activeUntil }]))).toBe(2);
    expect(versionOf(generate([], { vacationForward: { enabled: true, to: 'kollege@example.com', keepCopy: false } }))).toBe(2);
    expect(versionOf(generate([], { includeVacation: true, vacationAudience: { only: 'internal', domains: ['example.com'] } }))).toBe(2);
    expect(versionOf(generate(rules, { includeVacation: true }))).toBe(1);
  });

  it('stays 1 for a forward that is off, so turning it on and off again does not lock older editors out', () => {
    expect(versionOf(generate([], { vacationForward: { enabled: false, to: 'kollege@example.com', keepCopy: false } }))).toBe(1);
  });

  it('reads version 2 back as its own', () => {
    const options: GenerateOptions = {
      includeVacation: true,
      vacationForward: { enabled: true, to: 'kollege@example.com', keepCopy: true, ...period },
      vacationAudience: { only: 'external', domains: ['example.com'] },
    };
    const script = generate([{ ...rules[1], ...period }], options);
    const parsed = parseScript(script);
    expect(parsed.isOpaque).toBe(false);
    expect(generate(parsed.rules, {
      includeVacation: parsed.includeVacation,
      vacationForward: parsed.vacationForward,
      vacationAudience: parsed.vacationAudience,
    })).toBe(script);
  });

  it('takes a version it does not know for a script edited by hand', () => {
    expect(parseScript('/* @metadata:begin\n{"version":3,"rules":[]}\n@metadata:end */').isOpaque).toBe(true);
  });
});
