import { describe, it, expect } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { parseScript } from '@/lib/sieve/parser';
import {
  FiltersChangedError,
  OpaqueFiltersError,
  readAccountFilters,
  restoreAccountFilters,
  updateAccountFilters,
} from '../account-filters';
import { applyQuickRule, insertRuleAtTop } from '../quick-rules';
import { mockSieveAccount } from './sieve-mock';

function rule(id: string, overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id,
    name: `Rule ${id}`,
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'address_is', value: `${id}@acme.com` }],
    actions: [{ type: 'move', value: 'News', mailboxId: 'mb-news' }],
    stopProcessing: true,
    ...overrides,
  };
}

const EXTERNAL = [
  '# rule:[Roundcube spam]',
  'if header :contains "X-Spam" "yes" {',
  '    fileinto "Junk";',
  '}',
].join('\n');

function bulwarkScript(rules: FilterRule[], withExternal = false): string {
  const base = generateScript(rules);
  return withExternal ? `${base}\n${EXTERNAL}\n` : base;
}

describe('updateAccountFilters', () => {
  it('reads the script right before writing, and writes to the named account only', async () => {
    const account = mockSieveAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);

    const change = await updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('new')));

    expect(change).not.toBeNull();
    expect(account.client.getSieveScripts).toHaveBeenCalledWith('b');
    const parsed = parseScript(account.content('filters'));
    expect(parsed.rules.map((r) => r.id)).toEqual(['new', 'old']);
    expect(change!.previous.content).toBe(bulwarkScript([rule('old')]));
  });

  it('keeps external blocks verbatim after the Bulwark section', async () => {
    const account = mockSieveAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')], true), isActive: true }]);

    await updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('new')));

    const written = account.content('filters');
    expect(written).toContain(EXTERNAL.split('\n').slice(1).join('\n'));
    expect(written.indexOf('# Rule: Rule new')).toBeLessThan(written.indexOf('# Rule: Rule old'));
    expect(written.indexOf('# Rule: Rule old')).toBeLessThan(written.indexOf('X-Spam'));
  });

  it('refuses a hand-edited script and writes nothing', async () => {
    const account = mockSieveAccount('b', [{ name: 'filters', content: 'require "fileinto";', isActive: true }]);
    expect((await readAccountFilters(account.client, 'b')).parsed.isOpaque).toBe(true);

    await expect(updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('new'))))
      .rejects.toBeInstanceOf(OpaqueFiltersError);
    expect(account.writes()).toBe(0);
  });

  it('creates and activates a filters script when there is none', async () => {
    const account = mockSieveAccount('b');
    const change = await updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('new')));
    expect(account.active()).toBe('filters');
    expect(change!.previous.scriptId).toBeNull();
    expect(parseScript(account.content('filters')).rules[0].id).toBe('new');
  });

  it('writes nothing when modify returns null', async () => {
    const account = mockSieveAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    expect(await updateAccountFilters(account.client, 'b', () => null)).toBeNull();
    expect(account.writes()).toBe(0);
  });

  it('keeps an active vacation script running through an include', async () => {
    const account = mockSieveAccount('b', [
      { name: 'filters', content: bulwarkScript([rule('old')]), isActive: false },
      { name: 'vacation', content: 'require "vacation"; vacation "away";', isActive: true },
    ]);
    await updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('new')));
    expect(account.active()).toBe('filters');
    expect(account.content('filters')).toContain('include :personal :optional "vacation";');
  });
});

describe('restoreAccountFilters (Undo)', () => {
  it('puts a merged rule back exactly as it was', async () => {
    const before = bulwarkScript([rule('a', { actions: [{ type: 'mark_read' }] }), rule('target', { name: 'Newsletters' })], true);
    const account = mockSieveAccount('b', [{ name: 'filters', content: before, isActive: true }]);

    const change = await updateAccountFilters(account.client, 'b', (rules) => {
      const outcome = applyQuickRule(rules, rule('new', { conditions: [{ field: 'from', comparator: 'address_is', value: 'target2@acme.com' }] }));
      return outcome.kind === 'covered' ? null : outcome.rules;
    });
    expect(parseScript(account.content('filters')).rules.find((r) => r.id === 'target')?.conditions[0].value)
      .toEqual(['target@acme.com', 'target2@acme.com']);

    await restoreAccountFilters(account.client, change!);
    expect(account.content('filters')).toBe(before);
    expect(account.active()).toBe('filters');
  });

  it('switches the vacation script back on when the write had taken over from it', async () => {
    const account = mockSieveAccount('b', [
      { name: 'filters', content: bulwarkScript([rule('old')]), isActive: false },
      { name: 'vacation', content: 'require "vacation"; vacation "away";', isActive: true },
    ]);
    const change = await updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('new')));
    await restoreAccountFilters(account.client, change!);
    expect(account.active()).toBe('vacation');
    expect(account.content('filters')).toBe(bulwarkScript([rule('old')]));
  });

  it('removes a script the write created, after switching back', async () => {
    const account = mockSieveAccount('b', [{ name: 'vacation', content: 'require "vacation"; vacation "x";', isActive: true }]);
    const change = await updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('new')));
    await restoreAccountFilters(account.client, change!);
    expect(account.scripts.map((s) => s.name)).toEqual(['vacation']);
    expect(account.active()).toBe('vacation');
  });

  it('leaves no script active when there was none', async () => {
    const account = mockSieveAccount('b');
    const change = await updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('new')));
    await restoreAccountFilters(account.client, change!);
    expect(account.scripts).toEqual([]);
  });

  it('refuses when the script changed after the write', async () => {
    const account = mockSieveAccount('b', [{ name: 'filters', content: bulwarkScript([rule('old')]), isActive: true }]);
    const change = await updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('new')));
    await updateAccountFilters(account.client, 'b', (rules) => insertRuleAtTop(rules, rule('later')));

    await expect(restoreAccountFilters(account.client, change!)).rejects.toBeInstanceOf(FiltersChangedError);
    expect(parseScript(account.content('filters')).rules.map((r) => r.id)).toEqual(['later', 'new', 'old']);
  });
});
