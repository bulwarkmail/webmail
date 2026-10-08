import { afterEach, describe, expect, it } from 'vitest';
import type { FilterRule, VacationAudience } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { parseScript } from '@/lib/sieve/parser';
import { updateAccountFilters } from '@/lib/filters/account-filters';
import { insertRuleAtTop } from '@/lib/filters/quick-rules';
import { STALWART_VACATION_SCRIPT, mockStalwartAccount } from '@/lib/filters/__tests__/sieve-mock';
import { readVacationFilters, syncVacationWithFilters, useFilterStore } from '../filter-store';
import { VacationFiltersError, useVacationStore } from '../vacation-store';

const EXTENSIONS = ['fileinto', 'imap4flags', 'include', 'envelope'];
const INCLUDE = 'include :personal :optional "vacation";';
const external: VacationAudience = { only: 'external', domains: ['example.com'] };
const NARROWED = 'if not envelope :domain :is "from" ["example.com"] {';

const rule = (id: string): FilterRule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: `${id}@example.net` }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
});

const filters = (rules: FilterRule[], options: Parameters<typeof generateScript>[2] = {}) =>
  generateScript(rules, undefined, { extensions: EXTENSIONS, ...options });
const stalwart = (initial: Parameters<typeof mockStalwartAccount>[1], extensions = EXTENSIONS) =>
  mockStalwartAccount('b', initial, extensions);
const vacationScript = (isActive: boolean) => ({ name: 'vacation', content: STALWART_VACATION_SCRIPT, isActive });

const initialVacation = useVacationStore.getState();
const initialFilters = useFilterStore.getState();
afterEach(() => {
  useVacationStore.setState(initialVacation, true);
  useFilterStore.setState(initialFilters, true);
});

describe('syncVacationWithFilters with a narrowed auto-reply', () => {
  it('runs it from the filters script even without rules: on its own it would answer everyone', async () => {
    const server = stalwart([vacationScript(true)]);
    await syncVacationWithFilters(server.client, true, 'b', undefined, external);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(`${NARROWED}\n    ${INCLUDE}\n}`);
  });

  it('takes over again when Stalwart switched its own script back on', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([], { includeVacation: true, vacationAudience: external }), isActive: false },
      vacationScript(true),
    ]);
    await syncVacationWithFilters(server.client, true, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(NARROWED);
  });

  it('answers everyone again once the choice is cleared', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationAudience: external }), isActive: true },
      vacationScript(false),
    ]);
    await syncVacationWithFilters(server.client, true, 'b', undefined, null);
    const written = server.content('filters');
    expect(written).not.toContain('envelope :domain');
    expect(written).toContain(`# Vacation auto-reply\n${INCLUDE}`);
    expect(parseScript(written).vacationAudience).toBeUndefined();
  });

  it('keeps the choice while the auto-reply is off', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationAudience: external }), isActive: true },
      vacationScript(false),
    ]);
    await syncVacationWithFilters(server.client, false, 'b');
    const written = server.content('filters');
    expect(written).not.toContain('include');
    expect(parseScript(written).vacationAudience).toEqual(external);
  });

  it('refuses a choice it could not read back, rather than answer everyone', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await expect(syncVacationWithFilters(server.client, true, 'b', undefined, { only: 'internal', domains: [] }))
      .rejects.toThrow(/Unusable/);
    expect(server.writes()).toBe(0);
  });
});

describe('readVacationFilters and the other writes', () => {
  it('reports the choice and that it can be made', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationAudience: external }), isActive: true },
    ]);
    expect(await readVacationFilters(server.client, 'b')).toMatchObject({ audience: external, audienceAvailable: true });
    const handEdited = stalwart([{ name: 'filters', content: '/* @metadata:begin\n{\n@metadata:end */\n', isActive: true }]);
    expect((await readVacationFilters(handEdited.client, 'b')).audienceAvailable).toBe(false);
    const noInclude = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }], ['fileinto']);
    expect((await readVacationFilters(noInclude.client, 'b')).audienceAvailable).toBe(false);
    // The sender is judged by the envelope, which the reply goes to.
    const noEnvelope = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }], ['fileinto', 'include']);
    expect((await readVacationFilters(noEnvelope.client, 'b')).audienceAvailable).toBe(false);
  });

  it('says when Stalwart answers everyone although the auto-reply is for some senders only', async () => {
    const read = async (filtersActive: boolean, vacationActive: boolean) => (await readVacationFilters(stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationAudience: external }), isActive: filtersActive },
      vacationScript(vacationActive),
    ]).client, 'b')).notRunning;
    expect(await read(false, true)).toBe(true);
    expect(await read(true, false)).toBe(false);
    // The auto-reply is off: whom it would answer does not matter.
    expect(await read(false, false)).toBe(false);
  });

  it('keeps the choice through a rule made from a message and a save on the filter settings page', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationAudience: external }), isActive: true },
      vacationScript(false),
    ]);
    await updateAccountFilters(server.client, 'b', (rules) => insertRuleAtTop(rules, rule('quick')));
    expect(server.content('filters')).toContain(NARROWED);

    await useFilterStore.getState().fetchFilters(server.client, 'b');
    useFilterStore.getState().addRule(rule('settings'));
    await useFilterStore.getState().saveFilters(server.client);
    const written = server.content('filters');
    expect(written).toContain('# Rule: Rule settings');
    expect(written).toContain(NARROWED);
    expect(written.split(INCLUDE).length).toBe(2);
  });
});

describe('vacation store with a narrowed auto-reply', () => {
  it('loads the choice and saves a new one', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    expect(useVacationStore.getState()).toMatchObject({ audience: null, audienceAvailable: true });

    await useVacationStore.getState().updateVacationResponse(server.client, { isEnabled: true, audience: external });
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(NARROWED);
    expect(server.client.setVacationResponse.mock.calls[0][0]).not.toHaveProperty('audience');
    expect(useVacationStore.getState().audience).toEqual(external);
  });

  it('says when the auto-reply was saved but the choice of who gets it was not', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    server.client.updateSieveScript.mockRejectedValueOnce(new Error('server said no'));
    await expect(
      useVacationStore.getState().updateVacationResponse(server.client, { isEnabled: true, audience: external }),
    ).rejects.toBeInstanceOf(VacationFiltersError);
    expect(useVacationStore.getState().audience).toBeNull();
  });

  it('says when a stored choice could not be cleared', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationAudience: external }), isActive: true },
      vacationScript(false),
    ]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    server.client.updateSieveScript.mockRejectedValueOnce(new Error('server said no'));
    // Only the stored choice tells that the server may now answer everyone.
    await expect(
      useVacationStore.getState().updateVacationResponse(server.client, { isEnabled: true, audience: null }),
    ).rejects.toBeInstanceOf(VacationFiltersError);
    expect(useVacationStore.getState().audience).toEqual(external);
  });
});
