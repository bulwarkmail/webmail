import { describe, it, expect } from 'vitest';
import { parseScript } from '../parser';
import { generateScript } from '../generator';
import { SERVER_RULES_BEGIN, SERVER_RULES_END, extractServerRules } from '../server-rules';
import type { FilterRule } from '@/lib/jmap/sieve-types';

const EXTENSIONS = ['fileinto', 'mailbox', 'include', 'envelope', 'copy', 'relational', 'spamtestplus'];
const SERVER = 'include :personal :optional "host-rules";';
const VACATION = 'include :personal :optional "vacation";';

const rule = (id: string): FilterRule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: `${id}@example.net` }],
  actions: [{ type: 'move', value: 'Archive' }],
  stopProcessing: false,
});

const region = (body = SERVER) => `${SERVER_RULES_BEGIN}\n${body}\n${SERVER_RULES_END}\n`;

describe('server rules region', () => {
  it('is kept first after require, ahead of the vacation include and the rules', () => {
    const script = generateScript([rule('a')], undefined, {
      extensions: EXTENSIONS, includeVacation: true, serverRules: SERVER,
    });
    const requireAt = script.indexOf('require [');
    const regionAt = script.indexOf(SERVER_RULES_BEGIN);
    const vacationAt = script.indexOf(VACATION);
    const ruleAt = script.indexOf('# Rule: Rule a');
    expect(requireAt).toBeGreaterThan(-1);
    expect(regionAt).toBeGreaterThan(requireAt);
    expect(vacationAt).toBeGreaterThan(regionAt);
    expect(ruleAt).toBeGreaterThan(vacationAt);
    expect(script).toMatch(/require \[[^\]]*"include"/);
  });

  it('needs include even with the auto-reply off', () => {
    const script = generateScript([], undefined, { extensions: EXTENSIONS, serverRules: SERVER });
    expect(script).toMatch(/require \[[^\]]*"include"/);
    expect(script).toContain(SERVER);
  });

  it('reads back as the region, not as a rule, and round-trips unchanged', () => {
    const first = generateScript([rule('a')], undefined, {
      extensions: EXTENSIONS, includeVacation: true, serverRules: SERVER,
    });
    const parsed = parseScript(first);
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.serverRules).toBe(SERVER);
    expect(parsed.rules.map(r => r.id)).toEqual(['a']);
    expect(parsed.includeVacation).toBe(true);
    const second = generateScript(parsed.rules, parsed.vacation, {
      extensions: EXTENSIONS,
      externalRequires: parsed.externalRequires,
      includeVacation: parsed.includeVacation,
      serverRules: parsed.serverRules,
    });
    expect(second).toBe(first);
    expect(second.split(SERVER).length).toBe(2);
  });

  it('moves a region found after the rules up to its place, once', () => {
    const base = generateScript([rule('a')], undefined, { extensions: EXTENSIONS });
    const script = `${base.trimEnd().replace('require [', 'require ["include", ')}\n\n${region()}`;
    const parsed = parseScript(script);
    expect(parsed.serverRules).toBe(SERVER);
    expect(parsed.rules.some(r => r.origin && r.origin !== 'bulwark')).toBe(false);
    const written = generateScript(parsed.rules, undefined, {
      extensions: EXTENSIONS, externalRequires: parsed.externalRequires, serverRules: parsed.serverRules,
    });
    expect(written.indexOf(SERVER_RULES_BEGIN)).toBeLessThan(written.indexOf('# Rule: Rule a'));
    expect(written.split(SERVER).length).toBe(2);
  });

  it('keeps external rules after the rules, and the region first', () => {
    const base = generateScript([], undefined, { extensions: EXTENSIONS, serverRules: SERVER });
    const script = `${base}\nif header :contains "subject" "x" {\n    fileinto "X";\n}\n`.replace('require [', 'require ["fileinto", ');
    const parsed = parseScript(script);
    expect(parsed.serverRules).toBe(SERVER);
    expect(parsed.rules.filter(r => r.origin === 'external')).toHaveLength(1);
    const written = generateScript(parsed.rules, undefined, {
      extensions: EXTENSIONS, externalRequires: parsed.externalRequires, serverRules: parsed.serverRules,
    });
    expect(written.indexOf(SERVER_RULES_BEGIN)).toBeLessThan(written.indexOf('External rules'));
  });

  it('is read from a script without Bulwark metadata too', () => {
    const parsed = parseScript(`require ["include"];\n\n${region()}`);
    expect(parsed.isOpaque).toBe(false);
    expect(parsed.serverRules).toBe(SERVER);
    expect(parsed.rules).toHaveLength(0);
  });

  it('without its end marker is not a region', () => {
    const { cleaned, serverRules } = extractServerRules(`${SERVER_RULES_BEGIN}\n${SERVER}\n`);
    expect(serverRules).toBe('');
    expect(cleaned).toContain(SERVER);
  });

  it('needs the markers on lines of their own', () => {
    const inside = `# note: ${SERVER_RULES_BEGIN}\n${SERVER}\n${SERVER_RULES_END}\n`;
    expect(extractServerRules(inside).serverRules).toBe('');
  });
});
