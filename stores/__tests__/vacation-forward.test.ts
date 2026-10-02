import { afterEach, describe, expect, it } from 'vitest';
import type { FilterRule, VacationForward } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { parseScript } from '@/lib/sieve/parser';
import { OpaqueFiltersError, updateAccountFilters } from '@/lib/filters/account-filters';
import { insertRuleAtTop } from '@/lib/filters/quick-rules';
import { STALWART_VACATION_SCRIPT, mockStalwartAccount } from '@/lib/filters/__tests__/sieve-mock';
import { readVacationFilters, syncVacationWithFilters, useFilterStore } from '../filter-store';
import { VacationFiltersError, useVacationStore } from '../vacation-store';

const EXTENSIONS = ['fileinto', 'mailbox', 'mailboxid', 'imap4flags', 'include', 'envelope', 'copy', 'date', 'relational', 'spamtestplus', 'comparator-i;ascii-numeric'];
const FORWARD_MARKER = '# Vacation forwarding';
const INCLUDE = 'include :personal :optional "vacation";';

const forward = (extra: Partial<VacationForward> = {}): VacationForward => ({
  enabled: true,
  to: 'kollege@example.com',
  keepCopy: false,
  activeFrom: '2026-10-05T06:00:00.000Z',
  activeUntil: '2026-10-16T16:00:00.000Z',
  ...extra,
});

const rule = (id: string, extra: Partial<FilterRule> = {}): FilterRule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: `${id}@example.net` }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
  ...extra,
});

const filters = (rules: FilterRule[], options: Parameters<typeof generateScript>[2] = {}) =>
  generateScript(rules, undefined, { extensions: EXTENSIONS, ...options });

const VACATION_SCRIPT = STALWART_VACATION_SCRIPT;

const stalwart = (
  initial: Parameters<typeof mockStalwartAccount>[1],
  options: { extensions?: string[]; maxNumberRedirects?: number } = {},
) => mockStalwartAccount('b', initial, options.extensions ?? EXTENSIONS, options);

const initialVacation = useVacationStore.getState();
const initialFilters = useFilterStore.getState();
afterEach(() => {
  useVacationStore.setState(initialVacation, true);
  useFilterStore.setState(initialFilters, true);
});

describe('syncVacationWithFilters with forwarding', () => {
  it('runs forwarding next to the auto-reply even when there is no filter rule', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([]), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await syncVacationWithFilters(server.client, true, 'b', forward());
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).toContain(INCLUDE);
    expect(written).toContain(FORWARD_MARKER);
    expect(parseScript(written).vacationForward).toEqual(forward());
  });

  it('creates the filters script for forwarding when there is none', async () => {
    const server = stalwart([{ name: 'vacation', content: VACATION_SCRIPT, isActive: true }]);
    await syncVacationWithFilters(server.client, true, 'b', forward());
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(INCLUDE);
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('brings the stored forwarding back when the auto-reply took over again', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await syncVacationWithFilters(server.client, true, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('brings the stored forwarding back without any rule when the auto-reply took over again', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([], { includeVacation: true, vacationForward: forward() }), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await syncVacationWithFilters(server.client, true, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('moves the forwarding to new vacation dates', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    const later = forward({ activeFrom: '2026-11-02T07:00:00.000Z', activeUntil: '2026-11-13T17:00:00.000Z' });
    await syncVacationWithFilters(server.client, true, 'b', later);
    const written = server.content('filters');
    expect(parseScript(written).vacationForward).toEqual(later);
    expect(written).toContain('"date" "2026-11-02"');
    expect(written).not.toContain('"date" "2026-10-05"');
  });

  it('keeps forwarding when the auto-reply is turned off', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await syncVacationWithFilters(server.client, false, 'b', forward());
    const written = server.content('filters');
    expect(written).not.toContain(INCLUDE);
    expect(written).toContain(FORWARD_MARKER);
    expect(parseScript(written).vacationForward).toEqual(forward());
    expect(server.active()).toBe('filters');
  });

  it('forwards without any auto-reply, creating the filters script for it', async () => {
    const server = stalwart([]);
    await syncVacationWithFilters(server.client, false, 'b', forward());
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).not.toContain(INCLUDE);
    expect(written).toContain(FORWARD_MARKER);
  });

  it('switches the filters back on for forwarding when the auto-reply was the only active script', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([], { vacationForward: forward() }), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await syncVacationWithFilters(server.client, false, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('leaves switched-off forwarding where nothing else needs the filters script', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([], { vacationForward: forward({ enabled: false }) }), isActive: false },
    ]);
    await syncVacationWithFilters(server.client, false, 'b');
    expect(server.writes()).toBe(0);
    expect(server.active()).toBeNull();
  });

  it('removes forwarding that was cleared', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await syncVacationWithFilters(server.client, true, 'b', null);
    const written = server.content('filters');
    expect(written).toContain(INCLUDE);
    expect(written).not.toContain(FORWARD_MARKER);
    expect(parseScript(written).vacationForward).toBeUndefined();
  });

  it('leaves the auto-reply on its own without rules or forwarding, as before', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([]), isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await syncVacationWithFilters(server.client, true, 'b');
    await syncVacationWithFilters(server.client, true, 'b', null);
    expect(server.writes()).toBe(0);
    expect(server.active()).toBe('vacation');
  });

  it('refuses forwarding on a hand-edited script, and writes nothing', async () => {
    const handEdited = '/* @metadata:begin\n{not json\n@metadata:end */\nkeep;\n';
    const server = stalwart([
      { name: 'filters', content: handEdited, isActive: false },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: true },
    ]);
    await expect(syncVacationWithFilters(server.client, true, 'b', forward())).rejects.toBeInstanceOf(OpaqueFiltersError);
    expect(server.writes()).toBe(0);
  });

  it('refuses forwarding where the server cannot include the auto-reply', async () => {
    const server = stalwart([{ name: 'vacation', content: VACATION_SCRIPT, isActive: true }], { extensions: ['fileinto'] });
    await expect(syncVacationWithFilters(server.client, true, 'b', forward())).rejects.toThrow(/"include"/);
    expect(server.writes()).toBe(0);
  });

  it('moves the stored forwarding to the vacation dates without it being sent again', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await syncVacationWithFilters(server.client, true, 'b', undefined, undefined, {
      from: '2026-11-02T07:00:00.000Z', until: null,
    });
    // Without an end date it forwards until switched off.
    expect(parseScript(server.content('filters')).vacationForward).toEqual({
      enabled: true, to: 'kollege@example.com', keepCopy: false, activeFrom: '2026-11-02T07:00:00.000Z',
    });
  });

  it('takes the same moment, written another way, as no change', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    // The server hands the vacation's dates back without milliseconds.
    await syncVacationWithFilters(server.client, true, 'b', undefined, undefined, {
      from: '2026-10-05T06:00:00Z', until: '2026-10-16T18:00:00+02:00',
    });
    expect(server.writes()).toBe(0);
  });

  it('refuses forwarding it could not read back, and writes nothing', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    // The generator would leave it out, and the save would look done.
    await expect(syncVacationWithFilters(server.client, false, 'b', forward(), undefined, {
      from: null, until: '+010000-01-01T00:59:00.000Z',
    })).rejects.toThrow(/Unusable/);
    await expect(syncVacationWithFilters(server.client, false, 'b', forward({ to: 'kollege' }))).rejects.toThrow(/Unusable/);
    expect(server.writes()).toBe(0);
  });
});

describe('readVacationFilters', () => {
  it('reports the forwarding, that it can be set up, and the forwards in the rules', async () => {
    const forwarding = rule('f', { actions: [{ type: 'forward', value: 'chef@example.com' }] });
    const server = stalwart([
      { name: 'filters', content: filters([forwarding, rule('off', { ...forwarding, enabled: false })], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    expect(await readVacationFilters(server.client, 'b')).toEqual({
      includesVacation: true,
      forward: forward(),
      forwardAvailable: true,
      audience: null,
      audienceAvailable: true,
      notRunning: false,
      otherForwards: 1,
    });
  });

  it('reports the most forwards one message can collect in the rules, not all of them', async () => {
    const forwarding = (id: string, stopProcessing: boolean) =>
      rule(id, { actions: [{ type: 'forward', value: 'chef@example.com' }], stopProcessing });
    const read = async (rules: FilterRule[]) =>
      (await readVacationFilters(stalwart([{ name: 'filters', content: filters(rules), isActive: true }]).client, 'b')).otherForwards;
    // A message the first rule matches stops there.
    expect(await read([forwarding('a', true), forwarding('b', false)])).toBe(1);
    expect(await read([forwarding('a', false), forwarding('b', false)])).toBe(2);
  });

  it('offers no forwarding without include, on a hand-edited script, or without redirects', async () => {
    const plain = (options = {}, content = filters([])) =>
      stalwart([{ name: 'filters', content, isActive: true }], options);
    expect((await readVacationFilters(plain({ extensions: ['fileinto'] }).client, 'b')).forwardAvailable).toBe(false);
    expect((await readVacationFilters(plain({}, '/* @metadata:begin\n{\n@metadata:end */\n').client, 'b')).forwardAvailable).toBe(false);
    expect((await readVacationFilters(plain({ maxNumberRedirects: 0 }).client, 'b')).forwardAvailable).toBe(false);
    expect((await readVacationFilters(plain().client, 'b')).forwardAvailable).toBe(true);
  });

  it('offers no forwarding where the server lacks what the block uses', async () => {
    // Its period, its spam check, and the copy kept here.
    for (const missing of ['date', 'relational', 'spamtestplus', 'copy']) {
      const server = stalwart([{ name: 'filters', content: filters([]), isActive: true }], {
        extensions: EXTENSIONS.filter((e) => e !== missing),
      });
      expect((await readVacationFilters(server.client, 'b')).forwardAvailable, missing).toBe(false);
    }
  });

  it('still offers forwarding that is on, so that it can be switched off', async () => {
    const server = stalwart(
      [{ name: 'filters', content: filters([], { vacationForward: forward() }), isActive: true }],
      { maxNumberRedirects: 0 },
    );
    expect((await readVacationFilters(server.client, 'b')).forwardAvailable).toBe(true);
  });

  it('says when forwarding that is on does not run, and when it does', async () => {
    const read = async (filtersActive: boolean, vacationActive: boolean, f = forward()) => (await readVacationFilters(stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: f }), isActive: filtersActive },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: vacationActive },
    ]).client, 'b')).notRunning;
    // Stalwart's own script took over: it answers, nothing forwards.
    expect(await read(false, true)).toBe(true);
    // No script runs at all.
    expect(await read(false, false)).toBe(true);
    expect(await read(true, false)).toBe(false);
    // Switched off, there is nothing that should run.
    expect(await read(false, true, forward({ enabled: false }))).toBe(false);
  });
});

describe('every other write keeps the forwarding', () => {
  const withForwarding = () => stalwart([
    { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
    { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
  ]);

  it('a rule made from a message', async () => {
    const server = withForwarding();
    await updateAccountFilters(server.client, 'b', (rules) => insertRuleAtTop(rules, rule('new')));
    const written = server.content('filters');
    expect(written).toContain('# Rule: Rule new');
    expect(written.split(FORWARD_MARKER).length).toBe(2);
    expect(parseScript(written).vacationForward).toEqual(forward());
  });

  it('a save on the filter settings page', async () => {
    const server = withForwarding();
    await useFilterStore.getState().fetchFilters(server.client, 'b');
    expect(useFilterStore.getState().vacationForward).toEqual(forward());
    useFilterStore.getState().addRule(rule('new'));
    await useFilterStore.getState().saveFilters(server.client);
    const written = server.content('filters');
    expect(written).toContain('# Rule: Rule new');
    expect(written.split(FORWARD_MARKER).length).toBe(2);
    expect(parseScript(written).vacationForward).toEqual(forward());
  });
});

describe('vacation store', () => {
  it('loads the forwarding along with the auto-reply', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    expect(useVacationStore.getState()).toMatchObject({
      isEnabled: true,
      forward: forward(),
      forwardAvailable: true,
      otherForwards: 0,
    });
  });

  it('forwards in the vacation period it saves, with the auto-reply and after it', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    await useVacationStore.getState().updateVacationResponse(server.client, {
      isEnabled: true,
      fromDate: '2026-10-05T06:00:00.000Z',
      toDate: '2026-10-16T16:00:00.000Z',
      forward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
    });
    // The auto-reply runs from the filters script, which forwards in its period.
    expect(server.active()).toBe('filters');
    const written = server.content('filters');
    expect(written).toContain(INCLUDE);
    expect(parseScript(written).vacationForward).toEqual(forward());
    // VacationResponse itself never sees the forwarding.
    expect(server.client.setVacationResponse.mock.calls[0][0]).not.toHaveProperty('forward');
    expect(useVacationStore.getState().forward).toEqual(forward());

    // Turning the auto-reply off leaves the forwarding running on its own.
    await useVacationStore.getState().updateVacationResponse(server.client, { isEnabled: false });
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).not.toContain(INCLUDE);
    expect(server.content('filters')).toContain(FORWARD_MARKER);
  });

  it('turns the auto-reply off and forwarding on in one save, even when the auto-reply ran alone', async () => {
    const server = stalwart([{ name: 'vacation', content: VACATION_SCRIPT, isActive: true }]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    expect(useVacationStore.getState().isEnabled).toBe(true);
    await useVacationStore.getState().updateVacationResponse(server.client, {
      isEnabled: false,
      fromDate: null,
      toDate: null,
      forward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
    });
    // No auto-reply any more; the filters script forwards on its own.
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).not.toContain(INCLUDE);
    expect(server.content('filters')).toContain('redirect "kollege@example.com";');
  });

  it('says when the auto-reply was saved but its forwarding was not', async () => {
    const server = stalwart([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    server.client.updateSieveScript.mockRejectedValueOnce(new Error('server said no'));
    await expect(useVacationStore.getState().updateVacationResponse(server.client, {
      isEnabled: true,
      forward: { enabled: true, to: 'kollege@example.com', keepCopy: false },
    })).rejects.toBeInstanceOf(VacationFiltersError);
    expect(server.client.setVacationResponse).toHaveBeenCalledTimes(1);
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, forward: null, isSaving: false, error: null });
  });

  it('says when forwarding that is on could not be switched off', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { vacationForward: forward() }), isActive: true },
    ]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    server.client.updateSieveScript.mockRejectedValueOnce(new Error('server said no'));
    // Only the stored forwarding tells that mail is still forwarded.
    await expect(useVacationStore.getState().updateVacationResponse(server.client, {
      isEnabled: false,
      forward: { enabled: false, to: 'kollege@example.com', keepCopy: false },
    })).rejects.toBeInstanceOf(VacationFiltersError);
    expect(server.content('filters')).toContain(FORWARD_MARKER);
    expect(useVacationStore.getState().forward).toEqual(forward());
  });

  it('says when a save cut short leaves the forwarding idle, and the next save sets it right', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    expect(useVacationStore.getState()).toMatchObject({ isEnabled: true, notRunning: false });

    // Only the text changes. Stalwart's own script takes over with the
    // response, and putting the filters back fails.
    server.client.updateSieveScript.mockRejectedValueOnce(new Error('connection lost'));
    await expect(useVacationStore.getState().updateVacationResponse(server.client, {
      isEnabled: true, subject: 'Weg',
    })).rejects.toBeInstanceOf(VacationFiltersError);
    expect(server.active()).toBe('vacation');
    expect(useVacationStore.getState()).toMatchObject({ forward: forward(), notRunning: true });

    await useVacationStore.getState().updateVacationResponse(server.client, { isEnabled: true });
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FORWARD_MARKER);
    expect(useVacationStore.getState().notRunning).toBe(false);
  });

  it('leaves forwarding it was not asked to change as the server has it, in the vacation period', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward({ enabled: false }) }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    // Another tab switched it on since this one loaded.
    await syncVacationWithFilters(server.client, true, 'b', forward());
    await useVacationStore.getState().updateVacationResponse(server.client, {
      isEnabled: true, fromDate: '2026-11-02T07:00:00.000Z', toDate: '2026-11-13T17:00:00.000Z',
    });
    const stored = parseScript(server.content('filters')).vacationForward;
    expect(stored).toEqual(forward({ activeFrom: '2026-11-02T07:00:00.000Z', activeUntil: '2026-11-13T17:00:00.000Z' }));
    expect(useVacationStore.getState().forward).toEqual(stored);
  });

  it('drops what a load finds once a later load or an account switch outdated it', async () => {
    const server = stalwart([
      { name: 'filters', content: filters([rule('a')], { includeVacation: true, vacationForward: forward() }), isActive: true },
      { name: 'vacation', content: VACATION_SCRIPT, isActive: false },
    ]);
    const other = { fromDate: null, toDate: null, subject: 'Other account', textBody: 'x', htmlBody: null, isEnabled: false };
    let answer: (value: typeof other) => void = () => {};
    server.client.getVacationResponse.mockImplementationOnce(() => new Promise<typeof other>((resolve) => { answer = resolve; }));
    const slow = useVacationStore.getState().fetchVacationResponse(server.client);
    await useVacationStore.getState().fetchVacationResponse(server.client);
    answer(other);
    await slow;
    expect(useVacationStore.getState()).toMatchObject({ subject: '', forward: forward(), isLoading: false });

    server.client.getVacationResponse.mockImplementationOnce(() => new Promise<typeof other>((resolve) => { answer = resolve; }));
    const beforeSwitch = useVacationStore.getState().fetchVacationResponse(server.client);
    useVacationStore.getState().clearState();
    answer(other);
    await beforeSwitch;
    expect(useVacationStore.getState()).toMatchObject({ subject: '', forward: null, isLoading: false });
  });
});
