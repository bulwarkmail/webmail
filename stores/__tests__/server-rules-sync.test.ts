import { afterEach, describe, expect, it } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { parseScript } from '@/lib/sieve/parser';
import { SERVER_RULES_BEGIN } from '@/lib/sieve/server-rules';
import { updateAccountFilters } from '@/lib/filters/account-filters';
import { STALWART_VACATION_SCRIPT, mockStalwartAccount } from '@/lib/filters/__tests__/sieve-mock';
import { readVacationFilters, syncVacationWithFilters, useFilterStore } from '../filter-store';

// The host keeps its own rules (a block list, a forward set up in its admin
// panel) in a script of its own, which the filters script includes from the
// server rules region. They must keep running whatever the webmail saves.
const EXTENSIONS = ['fileinto', 'mailbox', 'include', 'envelope', 'copy', 'date', 'relational', 'spamtestplus'];
const SERVER = 'include :personal :optional "host-rules";';
const HOST_SCRIPT = 'require ["fileinto"];\nif address :is "from" "spam@example.net" { discard; stop; }\n';
const INCLUDE = 'include :personal :optional "vacation";';

const rule = (id: string): FilterRule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: `${id}@example.net` }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
});

const filters = (rules: FilterRule[], includeVacation = false) =>
  generateScript(rules, undefined, { extensions: EXTENSIONS, serverRules: SERVER, includeVacation });

const stalwart = (initial: Parameters<typeof mockStalwartAccount>[1]) =>
  mockStalwartAccount('b', initial, EXTENSIONS);

const initialFilters = useFilterStore.getState();
afterEach(() => useFilterStore.setState(initialFilters, true));

describe('server rules next to the auto-reply', () => {
  it('turns the filters back on when the auto-reply took over, though there is no rule', async () => {
    const server = stalwart([
      { name: 'host-rules', content: HOST_SCRIPT, isActive: false },
      { name: 'filters', content: filters([]), isActive: false },
      { name: 'vacation', content: STALWART_VACATION_SCRIPT, isActive: true },
    ]);
    await syncVacationWithFilters(server.client, true, 'b');
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).toContain(INCLUDE);
    expect(written.split(SERVER).length).toBe(2);
    expect(written.indexOf(SERVER_RULES_BEGIN)).toBeLessThan(written.indexOf(INCLUDE));
  });

  it('keeps the filters on when the auto-reply is turned off after running alone', async () => {
    const server = stalwart([
      { name: 'host-rules', content: HOST_SCRIPT, isActive: false },
      { name: 'filters', content: filters([], true), isActive: false },
      { name: 'vacation', content: STALWART_VACATION_SCRIPT, isActive: false },
    ]);
    await syncVacationWithFilters(server.client, false, 'b');
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).not.toContain(INCLUDE);
    expect(written).toContain(SERVER);
    expect(parseScript(written).includeVacation).toBeUndefined();
  });

  it('reports the auto-reply as on while it runs from filters that carry server rules', async () => {
    const server = stalwart([
      { name: 'host-rules', content: HOST_SCRIPT, isActive: false },
      { name: 'filters', content: filters([], true), isActive: true },
      { name: 'vacation', content: STALWART_VACATION_SCRIPT, isActive: false },
    ]);
    expect((await readVacationFilters(server.client, 'b')).includesVacation).toBe(true);
  });
});

describe('every other write keeps the server rules', () => {
  it('a rule made from a message', async () => {
    const server = stalwart([
      { name: 'host-rules', content: HOST_SCRIPT, isActive: false },
      { name: 'filters', content: filters([rule('a')]), isActive: true },
    ]);
    await updateAccountFilters(server.client, 'b', (rules) => [...rules, rule('b')]);
    const written = server.content('filters');
    expect(written.split(SERVER).length).toBe(2);
    expect(parseScript(written).rules.map(r => r.id)).toEqual(['a', 'b']);
    expect(server.content('host-rules')).toBe(HOST_SCRIPT);
  });

  it('a save on the filter settings page', async () => {
    const server = stalwart([
      { name: 'host-rules', content: HOST_SCRIPT, isActive: false },
      { name: 'filters', content: filters([rule('a')]), isActive: true },
    ]);
    const store = useFilterStore.getState();
    await store.fetchFilters(server.client, 'b');
    expect(useFilterStore.getState().rules.map(r => r.id)).toEqual(['a']);
    useFilterStore.getState().addRule(rule('c'));
    await useFilterStore.getState().saveFilters(server.client);
    const written = server.content('filters');
    expect(written.split(SERVER).length).toBe(2);
    expect(server.active()).toBe('filters');
  });
});

describe('the filters script', () => {
  it('is the one named filters when none is active, not the host script made first', async () => {
    const server = stalwart([
      { name: 'host-rules', content: HOST_SCRIPT, isActive: false },
      { name: 'filters', content: filters([rule('a')]), isActive: false },
    ]);
    await updateAccountFilters(server.client, 'b', (rules) => [...rules, rule('b')]);
    expect(server.content('host-rules')).toBe(HOST_SCRIPT);
    expect(parseScript(server.content('filters')).rules.map(r => r.id)).toEqual(['a', 'b']);
  });
});
