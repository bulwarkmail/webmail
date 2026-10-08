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

  it('never writes a choice it cannot read back', () => {
    for (const unusable of [
      audience('external', []),
      audience('external', ['example.com"; discard; "']),
      { only: 'everyone', domains: ['example.com'] } as unknown as VacationAudience,
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
  });

  it('treats a choice it cannot read as a hand-edited script', () => {
    const script = generate(audience('internal'));
    for (const [from, to] of [
      ['"only":"internal"', '"only":"intern"'],
      ['"domains":["example.com","example.org"]', '"domains":[]'],
      ['"domains":["example.com","example.org"]', '"domains":["example com"]'],
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
