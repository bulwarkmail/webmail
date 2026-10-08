import { describe, expect, it } from 'vitest';
import type { FilterRule, VacationForward } from '@/lib/jmap/sieve-types';
import { generateScript } from '../generator';
import { parseScript } from '../parser';
import { periodTests } from '../period';

const EXTENSIONS = ['fileinto', 'imap4flags', 'include', 'copy', 'date', 'relational', 'spamtestplus', 'comparator-i;ascii-numeric'];
const SPAM_GUARD = 'not spamtest :percent :value "ge" :comparator "i;ascii-numeric" "50"';

const forward = (extra: Partial<VacationForward> = {}): VacationForward => ({
  enabled: true,
  to: 'kollege@example.com',
  keepCopy: false,
  activeFrom: '2026-10-05T06:00:00.000Z',
  activeUntil: '2026-10-16T16:00:00.000Z',
  ...extra,
});

const rule: FilterRule = {
  id: 'r1',
  name: 'Boersen',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'autoscout24' }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
};

const generate = (vacationForward: VacationForward | null, includeVacation = true, extensions = EXTENSIONS) =>
  generateScript([rule], undefined, { includeVacation, vacationForward, extensions });

/** The lines of the forwarding block, from its marker to its closing brace. */
function forwardBlock(script: string): string[] | null {
  const lines = script.split('\n');
  const start = lines.indexOf('# Vacation forwarding');
  if (start === -1) return null;
  return lines.slice(start, lines.indexOf('}', start) + 1);
}

describe('vacation forwarding (generator)', () => {
  it('forwards ahead of the rules, within the period, without spam, and stops', () => {
    const script = generate(forward());
    const [from, until] = periodTests(forward())!;
    expect(forwardBlock(script)).toEqual([
      '# Vacation forwarding',
      `if allof(${from}, ${until}, ${SPAM_GUARD}) {`,
      '    redirect "kollege@example.com";',
      '    stop;',
      '}',
    ]);
    // After the auto-reply runs, before any rule can file the message.
    expect(script.indexOf('include :personal :optional "vacation";')).toBeLessThan(script.indexOf('# Vacation forwarding'));
    expect(script.indexOf('# Vacation forwarding')).toBeLessThan(script.indexOf('# Rule: Boersen'));
    expect(script).toMatch(/^require \["comparator-i;ascii-numeric", "date", "imap4flags", "include", "relational", "spamtestplus"\];$/m);
  });

  it('keeps a copy and lets the rules run when asked to', () => {
    const script = generate(forward({ keepCopy: true }));
    const block = forwardBlock(script)!;
    expect(block).toContain('    redirect :copy "kollege@example.com";');
    expect(block).not.toContain('    stop;');
    expect(script).toMatch(/^require \[.*"copy".*\];$/m);
  });

  it('forwards without a period when the vacation has none', () => {
    expect(forwardBlock(generate(forward({ activeFrom: undefined, activeUntil: undefined })))![1]).toBe(`if ${SPAM_GUARD} {`);
    const noSpamTest = generate(forward({ activeFrom: undefined, activeUntil: undefined }), true, ['include']);
    expect(forwardBlock(noSpamTest)![1]).toBe('if true {');
  });

  it('forwards without the auto-reply too', () => {
    const script = generate(forward(), false);
    expect(script).not.toContain('include');
    expect(forwardBlock(script)).toEqual(forwardBlock(generate(forward())));
    expect(script.indexOf('# Vacation forwarding')).toBeLessThan(script.indexOf('# Rule: Boersen'));
    expect(parseScript(script).vacationForward).toEqual(forward());
  });

  it('does not forward while forwarding is switched off', () => {
    const script = generate(forward({ enabled: false }));
    expect(forwardBlock(script)).toBeNull();
    expect(script).not.toContain('redirect');
    expect(parseScript(script).vacationForward).toEqual(forward({ enabled: false }));
  });

  it('never writes forwarding it cannot read back, and never forwards without its period', () => {
    for (const unusable of [
      forward({ to: 'not an address' }),
      forward({ activeUntil: '16.10.2026' }),
      { ...forward(), keepCopy: 'yes' } as unknown as VacationForward,
    ]) {
      const script = generate(unusable);
      expect(forwardBlock(script)).toBeNull();
      expect(script).not.toContain('redirect');
      expect(script).not.toContain('vacationForward');
    }
  });

  it('writes no forwarding when there is none', () => {
    // Byte for byte as before forwarding existed: see generator-compat.test.ts.
    const script = generate(null);
    expect(forwardBlock(script)).toBeNull();
    expect(script).not.toContain('redirect');
    expect(script).not.toContain('vacationForward');
  });
});

describe('vacation forwarding (parser)', () => {
  it('reads its own block back as its own, not as an external rule', () => {
    const external = '# Hand\nif header :contains "subject" "hand" {\n    keep;\n}\n';
    const readAndWrite = (script: string) => {
      const parsed = parseScript(script);
      return {
        parsed,
        script: generateScript(parsed.rules, parsed.vacation, {
          includeVacation: parsed.includeVacation,
          vacationForward: parsed.vacationForward,
          externalRequires: parsed.externalRequires,
          extensions: EXTENSIONS,
        }),
      };
    };
    const first = readAndWrite(`${generate(forward())}\n${external}`);
    expect(first.parsed.isOpaque).toBe(false);
    expect(first.parsed.vacationForward).toEqual(forward());
    expect(first.parsed.rules.map((r) => r.origin ?? 'bulwark')).toEqual(['bulwark', 'external']);
    // Read and written again, nothing is lost or doubled. (Each pass adds two
    // blank lines before the external rules; that is older than forwarding.)
    const second = readAndWrite(first.script);
    const blankRuns = (script: string) => script.replace(/\n{3,}/g, '\n\n');
    expect(blankRuns(second.script)).toBe(blankRuns(first.script));
    expect(second.parsed.vacationForward).toEqual(forward());
    expect(second.script.split('# Vacation forwarding').length).toBe(2);
    expect(second.script.split('if header :contains "subject" "hand"').length).toBe(2);
  });

  it('treats forwarding it cannot read as a hand-edited script', () => {
    const script = generate(forward());
    for (const [from, to] of [
      ['"to":"kollege@example.com"', '"to":"kollege"'],
      ['"activeUntil":"2026-10-16T16:00:00.000Z"', '"activeUntil":"bald"'],
      ['"enabled":true', '"enabled":"true"'],
    ]) {
      expect(script).toContain(from);
      expect(parseScript(script.replace(from, to)).isOpaque).toBe(true);
    }
  });

  it('keeps a block with the marker as an external rule when the metadata has no forwarding', () => {
    const handWritten = '# Vacation forwarding\nif true {\n    redirect "x@example.com";\n}\n';
    const parsed = parseScript(`${generate(null)}\n${handWritten}`);
    expect(parsed.vacationForward).toBeUndefined();
    // Kept as someone else's block (it reads as neither rule nor Bulwark's).
    expect(parsed.rules.some((r) => r.origin === 'opaque' && r.rawBlock?.includes('redirect "x@example.com"'))).toBe(true);
  });

  it('keeps a block of someone else that only looks like its own', () => {
    const team = '# Vacation forwarding of the team inbox (set up by IT)\nif address :is "to" "team@example.com" {\n    redirect :copy "archive@example.com";\n}\n';
    const exact = '# Vacation forwarding\nif true {\n    redirect "x@example.com";\n}\n';
    const kept = (script: string, raw: string) =>
      parseScript(script).rules.some((r) => r.origin !== undefined && r.origin !== 'bulwark' && r.rawBlock?.includes(raw));
    // A comment that only begins like the marker, while forwarding is on.
    expect(kept(`${generate(forward())}\n${team}`, 'archive@example.com')).toBe(true);
    // The exact marker while forwarding is off: Bulwark wrote no block then.
    expect(kept(`${generate(forward({ enabled: false }))}\n${exact}`, 'x@example.com')).toBe(true);
    // Its own block it still takes back, and writes once.
    const own = parseScript(generate(forward()));
    expect(own.rules.every((r) => (r.origin ?? 'bulwark') === 'bulwark')).toBe(true);
  });
});
