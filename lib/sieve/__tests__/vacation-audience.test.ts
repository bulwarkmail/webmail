import { describe, expect, it } from 'vitest';
import type { FilterRule, VacationAudience } from '@/lib/jmap/sieve-types';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import { ownDomains } from '../vacation-audience';

const EXTENSIONS = ['fileinto', 'imap4flags', 'include', 'envelope'];
const INCLUDE = 'include :personal :optional "vacation";';

const rule: FilterRule = {
  id: 'r1',
  name: 'Boersen',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'autoscout24' }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
};

const audience = (only: VacationAudience['only'], domains = ['example.com', 'example.org']): VacationAudience => ({ only, domains });

const generate = (vacationAudience: VacationAudience | null, includeVacation = true) =>
  generateScript([rule], undefined, { includeVacation, vacationAudience, extensions: EXTENSIONS });

/** The auto-reply block: its marker comment up to the first rule. */
function replyBlock(script: string): string {
  const start = script.indexOf('# Vacation auto-reply');
  return script.slice(start, script.indexOf('\n\n', start));
}

describe('who gets the auto-reply (generator)', () => {
  it('answers only senders from the own domains', () => {
    // Judged by the envelope sender, whom the reply goes to: a From header
    // naming a colleague on mail from outside gets no reply meant for colleagues.
    const script = generate(audience('internal'));
    expect(replyBlock(script)).toBe([
      '# Vacation auto-reply',
      'if envelope :domain :is "from" ["example.com", "example.org"] {',
      `    ${INCLUDE}`,
      '}',
    ].join('\n'));
    expect(script).toMatch(/^require \["envelope", "imap4flags", "include"\];$/m);
  });

  it('answers only senders from elsewhere', () => {
    expect(replyBlock(generate(audience('external')))).toBe([
      '# Vacation auto-reply',
      'if not envelope :domain :is "from" ["example.com", "example.org"] {',
      `    ${INCLUDE}`,
      '}',
    ].join('\n'));
  });

  it('answers everyone when no one is singled out', () => {
    // Byte for byte as before the choice existed: see generator-compat.test.ts.
    const script = generate(null);
    expect(replyBlock(script)).toBe(['# Vacation auto-reply', INCLUDE].join('\n'));
    expect(script).not.toContain('vacationAudience');
  });

  it('keeps the choice while the auto-reply is off', () => {
    const script = generate(audience('external'), false);
    expect(script).not.toContain('include');
    expect(script).not.toContain('envelope');
    expect(parseScript(script).vacationAudience).toEqual(audience('external'));
  });

  it('lets an include that stays while the auto-reply is off run for every sender, and keeps the choice', () => {
    // Stalwart 1.2 keeps its own rules and sender lists in "managed" next to
    // the auto-reply: inside the test they would run for those senders only.
    const script = generateScript([rule], undefined, {
      includeVacation: true,
      vacationScriptName: 'managed',
      vacationAudience: audience('external'),
      vacationAudienceIdle: true,
      extensions: EXTENSIONS,
    });
    expect(replyBlock(script)).toBe(['# Vacation auto-reply', 'include :personal :optional "managed";'].join('\n'));
    expect(script).toMatch(/^require \["imap4flags", "include"\];$/m);
    expect(parseScript(script)).toMatchObject({
      includeVacation: true,
      vacationScriptName: 'managed',
      vacationAudience: audience('external'),
      vacationAudienceIdle: true,
    });
  });

  it('keeps to the period the choice carries: outside it the include runs for every sender', () => {
    // Around Stalwart's "managed", which answers nobody outside the
    // auto-reply's period and runs the rules kept in Stalwart itself.
    const now = 'currentdate :zone "+0000"';
    const from = `anyof(${now} :value "gt" "date" "2026-12-24", allof(${now} :is "date" "2026-12-24", ${now} :value "ge" "time" "08:00:00"))`;
    const until = `anyof(${now} :value "lt" "date" "2027-01-06", allof(${now} :is "date" "2027-01-06", ${now} :value "le" "time" "17:30:00"))`;
    const senders = 'envelope :domain :is "from" ["example.com", "example.org"]';
    const write = (period: Partial<VacationAudience>, extensions = [...EXTENSIONS, 'date', 'relational']) =>
      generateScript([rule], undefined, {
        includeVacation: true,
        vacationScriptName: 'managed',
        vacationAudience: { ...audience('internal'), ...period },
        extensions,
      });
    const block = (test: string) => ['# Vacation auto-reply', `if ${test} {`, '    include :personal :optional "managed";', '}'].join('\n');
    const both = { activeFrom: '2026-12-24T09:00:00+01:00', activeUntil: '2027-01-06T17:30:00Z' };

    const script = write(both);
    expect(replyBlock(script)).toBe(block(`anyof(${senders}, not allof(${from}, ${until}))`));
    expect(script).toMatch(/^require \["date", "envelope", "imap4flags", "include", "relational"\];$/m);
    // Read back as its own, and written the same again.
    const parsed = parseScript(script);
    expect(parsed).toMatchObject({ includeVacation: true, vacationScriptName: 'managed', vacationAudience: { ...audience('internal'), ...both } });
    expect(parsed.vacationAudienceIdle).toBeUndefined();
    expect(parsed.rules.map((r) => r.origin ?? 'bulwark')).toEqual(['bulwark']);
    expect(generateScript(parsed.rules, parsed.vacation, {
      includeVacation: parsed.includeVacation,
      vacationScriptName: parsed.vacationScriptName,
      vacationAudience: parsed.vacationAudience,
      externalRequires: parsed.externalRequires,
      extensions: [...EXTENSIONS, 'date', 'relational'],
    })).toBe(script);

    // One end left open.
    expect(replyBlock(write({ activeFrom: both.activeFrom }))).toBe(block(`anyof(${senders}, not ${from})`));
    expect(replyBlock(write({ activeUntil: both.activeUntil }))).toBe(block(`anyof(${senders}, not ${until})`));
    // A server that cannot test the date: narrowed throughout, the period kept.
    const untested = write(both, EXTENSIONS);
    expect(replyBlock(untested)).toBe(block(senders));
    expect(parseScript(untested).vacationAudience).toEqual({ ...audience('internal'), ...both });
    // While the auto-reply is off, for every sender, whatever the period.
    const off = generateScript([rule], undefined, {
      includeVacation: true,
      vacationScriptName: 'managed',
      vacationAudience: { ...audience('internal'), ...both },
      vacationAudienceIdle: true,
      extensions: [...EXTENSIONS, 'date', 'relational'],
    });
    expect(replyBlock(off)).toBe(['# Vacation auto-reply', 'include :personal :optional "managed";'].join('\n'));
    expect(parseScript(off)).toMatchObject({ vacationAudience: { ...audience('internal'), ...both }, vacationAudienceIdle: true });
  });

  it('never writes a choice it cannot read back', () => {
    for (const unusable of [
      audience('external', []),
      audience('external', ['example.com"; discard; "']),
      { only: 'everyone', domains: ['example.com'] } as unknown as VacationAudience,
      { ...audience('external'), activeFrom: 'next week' },
    ]) {
      const script = generate(unusable);
      expect(replyBlock(script)).toBe(['# Vacation auto-reply', INCLUDE].join('\n'));
      expect(script).not.toContain('vacationAudience');
    }
  });
});

describe('who gets the auto-reply (parser)', () => {
  it('reads its own narrowed include back as its own', () => {
    const readAndWrite = (script: string) => {
      const parsed = parseScript(script);
      return {
        parsed,
        script: generateScript(parsed.rules, parsed.vacation, {
          includeVacation: parsed.includeVacation,
          vacationAudience: parsed.vacationAudience,
          externalRequires: parsed.externalRequires,
          extensions: EXTENSIONS,
        }),
      };
    };
    const first = readAndWrite(generate(audience('internal')));
    expect(first.parsed.isOpaque).toBe(false);
    expect(first.parsed.includeVacation).toBe(true);
    expect(first.parsed.vacationAudience).toEqual(audience('internal'));
    expect(first.parsed.rules.map((r) => r.origin ?? 'bulwark')).toEqual(['bulwark']);
    expect(readAndWrite(first.script).script).toBe(first.script);
    expect(first.script.split(INCLUDE).length).toBe(2);
    expect(first.parsed.vacationAudienceIdle).toBeUndefined();
  });

  it('reads an include for every sender back as one, with the choice that waits', () => {
    const write = (parsed: ReturnType<typeof parseScript>) => generateScript(parsed.rules, parsed.vacation, {
      includeVacation: parsed.includeVacation,
      vacationAudience: parsed.vacationAudience,
      vacationAudienceIdle: parsed.vacationAudienceIdle,
      externalRequires: parsed.externalRequires,
      extensions: EXTENSIONS,
    });
    const idle = generateScript([rule], undefined, {
      includeVacation: true, vacationAudience: audience('internal'), vacationAudienceIdle: true, extensions: EXTENSIONS,
    });
    expect(replyBlock(idle)).toBe(['# Vacation auto-reply', INCLUDE].join('\n'));
    expect(parseScript(idle)).toMatchObject({ vacationAudience: audience('internal'), vacationAudienceIdle: true });
    expect(write(parseScript(idle))).toBe(idle);

    // Narrowed from it, and read back as narrowed.
    const narrowed = write({ ...parseScript(idle), vacationAudienceIdle: false });
    expect(replyBlock(narrowed)).toContain('if envelope :domain :is "from" ["example.com", "example.org"] {');
    expect(parseScript(narrowed).vacationAudienceIdle).toBeUndefined();
    // Nothing waits where everyone gets the auto-reply.
    expect(parseScript(generate(null)).vacationAudienceIdle).toBeUndefined();
  });

  it('treats a choice it cannot read as a hand-edited script', () => {
    const script = generate({ ...audience('internal'), activeUntil: '2027-01-06T17:30:00Z' });
    for (const [from, to] of [
      ['"only":"internal"', '"only":"intern"'],
      ['"domains":["example.com","example.org"]', '"domains":[]'],
      ['"domains":["example.com","example.org"]', '"domains":["example com"]'],
      ['"activeUntil":"2027-01-06T17:30:00Z"', '"activeUntil":"2027-01-06"'],
    ]) {
      expect(script).toContain(from);
      expect(parseScript(script.replace(from, to)).isOpaque).toBe(true);
    }
  });
});

describe('ownDomains', () => {
  it('takes each domain of the addresses once, lower-cased, skipping what is not one', () => {
    expect(ownDomains(['Max@Example.com', 'info@example.com', 'shop@example.org', 'broken', 'x@localhost'])).toEqual([
      'example.com',
      'example.org',
    ]);
  });
});
