import { afterEach, describe, expect, it } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { parseScript } from '@/lib/sieve/parser';
import { updateAccountFilters } from '@/lib/filters/account-filters';
import { insertRuleAtTop } from '@/lib/filters/quick-rules';
import { STALWART_MANAGED_IDLE, mockStalwartAccount, stalwartVacationScript } from '@/lib/filters/__tests__/sieve-mock';
import { syncVacationWithFilters, useFilterStore } from '../filter-store';
import { VacationFiltersError, useVacationStore } from '../vacation-store';

const EXTENSIONS = ['fileinto', 'mailbox', 'mailboxid', 'imap4flags', 'include', 'envelope', 'copy', 'date', 'relational', 'spamtestplus'];

const rule = (id: string): FilterRule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: `${id}@example.net` }],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
});

const filters = (rules: FilterRule[]) => generateScript(rules, undefined, { extensions: EXTENSIONS });
const include = (name: string) => `include :personal :optional "${name}";`;
const ruleIds = (content: string) => parseScript(content).rules.map((r) => r.id);

const initialVacation = useVacationStore.getState();
const initialFilters = useFilterStore.getState();
afterEach(() => {
  useVacationStore.setState(initialVacation, true);
  useFilterStore.setState(initialFilters, true);
});

// Up to 1.1 Stalwart runs the auto-reply from its "vacation" script. From
// 1.2 it runs it from "managed", which takes no client write and which
// VacationResponse/set activates over the filters only while nothing
// includes it. An include of "vacation" goes when the auto-reply is turned
// off; one of "managed" stays, which answers nobody while it is off.
describe.each([
  { server: 'Stalwart up to 1.1', name: 'vacation', managedScript: false, keptWhenOff: false },
  { server: 'Stalwart 1.2', name: 'managed', managedScript: true, keptWhenOff: true },
])('$server: the auto-reply next to the filters', ({ name, managedScript, keptWhenOff }) => {
  const account = (initial: Parameters<typeof mockStalwartAccount>[1]) =>
    mockStalwartAccount('b', initial, EXTENSIONS, { managedScript });
  const vacation = () => useVacationStore.getState();
  const filterStore = () => useFilterStore.getState();
  const cardShowsOn = async (server: ReturnType<typeof account>) => {
    await vacation().fetchVacationResponse(server.client, 'b');
    return vacation().isEnabled;
  };
  const neverWritten = (server: ReturnType<typeof account>) => {
    const own = server.scripts.find((s) => s.name === name);
    expect(own).toBeDefined();
    expect(server.client.updateSieveScript.mock.calls.some(([id]) => id === own?.id)).toBe(false);
    expect(server.client.createSieveScript.mock.calls.some(([scriptName]) => scriptName === name)).toBe(false);
  };

  it('keeps the filters running through auto-reply on, a filter save, auto-reply off and on again', async () => {
    const server = account([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);

    // On: the server's script took over, the filters come back with an include of it.
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include(name));
    expect(ruleIds(server.content('filters'))).toEqual(['a']);
    expect(await cardShowsOn(server)).toBe(true);

    // The filters page lists no server script, and its save keeps the include.
    await filterStore().fetchFilters(server.client, 'b');
    expect(filterStore().activeScriptId).toBe(server.scripts.find((s) => s.name === 'filters')?.id);
    expect(filterStore().rules.map((r) => r.id)).toEqual(['a']);
    filterStore().addRule(rule('b'));
    await filterStore().saveFilters(server.client);
    expect(filterStore().error).toBeNull();
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include(name));
    expect(ruleIds(server.content('filters'))).toEqual(['a', 'b']);
    expect(await cardShowsOn(server)).toBe(true);

    // Off: the filters stay on.
    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters').includes('include')).toBe(keptWhenOff);
    expect(ruleIds(server.content('filters'))).toEqual(['a', 'b']);
    expect(await cardShowsOn(server)).toBe(false);

    // On again: with the include still there, nothing but the auto-reply changes.
    const writes = server.writes();
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include(name));
    expect(ruleIds(server.content('filters'))).toEqual(['a', 'b']);
    expect(server.writes() - writes).toBe(keptWhenOff ? 0 : 1);
    expect(await cardShowsOn(server)).toBe(true);
    neverWritten(server);
  });

  it('puts the first rule next to an auto-reply that runs alone, and keeps it after the auto-reply', async () => {
    const server = account([]);

    // No filter needs the filters script: the auto-reply runs on its own.
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.active()).toBe(name);
    expect(await cardShowsOn(server)).toBe(true);

    await filterStore().fetchFilters(server.client, 'b');
    expect(filterStore().activeScriptId).toBeNull();
    expect(filterStore().rules).toEqual([]);
    filterStore().addRule(rule('a'));
    await filterStore().saveFilters(server.client);
    expect(filterStore().error).toBeNull();
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include(name));
    expect(await cardShowsOn(server)).toBe(true);

    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters').includes('include')).toBe(keptWhenOff);
    expect(ruleIds(server.content('filters'))).toEqual(['a']);
    expect(await cardShowsOn(server)).toBe(false);
    neverWritten(server);
  });
});

// "managed" also runs the mail rules and sender lists a user sets in Stalwart
// itself. While it has any, the server keeps it active without the auto-reply
// and activates it over filters that do not include it.
describe('Stalwart 1.2 with rules of its own in "managed"', () => {
  const vacation = () => useVacationStore.getState();
  const filterStore = () => useFilterStore.getState();

  it('lets the filters take over from "managed" and keeps including it, auto-reply on or off', async () => {
    const server = mockStalwartAccount('b', [
      { name: 'filters', content: filters([rule('a')]), isActive: false },
      { name: 'managed', content: '# Rules set in Stalwart\n', isActive: true },
    ], EXTENSIONS, { managedScript: true, managedRules: true, vacation: { textBody: '' } });
    const cardShowsOn = async () => {
      await vacation().fetchVacationResponse(server.client, 'b');
      return vacation().isEnabled;
    };
    expect(await cardShowsOn()).toBe(false);

    // Saved while off: the filters come back, and "managed" runs from them.
    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include('managed'));
    expect(ruleIds(server.content('filters'))).toEqual(['a']);

    // On and off again change the auto-reply only.
    const writes = server.writes();
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(await cardShowsOn()).toBe(true);
    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(await cardShowsOn()).toBe(false);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include('managed'));
    expect(server.writes()).toBe(writes);

    // A save of the rules keeps it as well.
    await filterStore().fetchFilters(server.client, 'b');
    filterStore().addRule(rule('b'));
    await filterStore().saveFilters(server.client);
    expect(filterStore().error).toBeNull();
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include('managed'));
    expect(ruleIds(server.content('filters'))).toEqual(['a', 'b']);
    const managed = server.scripts.find((s) => s.name === 'managed');
    expect(server.client.updateSieveScript.mock.calls.some(([id]) => id === managed?.id)).toBe(false);
  });
});

// The chosen senders are told apart around the include of "managed", and that
// script also runs the rules and sender lists a user keeps in Stalwart itself.
// So the include is narrowed only while the auto-reply answers: switched off,
// and before and after its period, "managed" answers nobody and runs for
// every sender.
describe('Stalwart 1.2: who the auto-reply is for, and forwarding', () => {
  const vacation = () => useVacationStore.getState();
  const filterStore = () => useFilterStore.getState();
  const external = { only: 'external' as const, domains: ['example.com'] };
  const AUDIENCE = 'if not envelope :domain :is "from" ["example.com"] {';
  const NARROWED = `# Vacation auto-reply\n${AUDIENCE}\n    ${include('managed')}\n}\n`;
  const FOR_EVERYONE = `# Vacation auto-reply\n${include('managed')}\n`;
  const FORWARD = { enabled: true, to: 'kollege@example.com', keepCopy: true };
  const FROM = '2026-12-24T08:00:00Z';
  const UNTIL = '2027-01-06T17:30:00Z';
  /** The auto-reply block: its marker comment up to the next blank line. */
  const replyBlock = (script: string) => {
    const start = script.indexOf('# Vacation auto-reply');
    return script.slice(start, script.indexOf('\n\n', start));
  };
  type Server = ReturnType<typeof mockStalwartAccount>;
  const account = (initial: Parameters<typeof mockStalwartAccount>[1], managedRules = false) =>
    mockStalwartAccount('b', initial, EXTENSIONS, { managedScript: true, managedRules, vacation: { textBody: '' } });
  const card = async (server: Server) => {
    await vacation().fetchVacationResponse(server.client, 'b');
    const { isEnabled, notRunning, audience, forward } = vacation();
    return { isEnabled, notRunning, audience, forwarding: !!forward?.enabled };
  };
  const saveRule = async (server: Server, id: string) => {
    await filterStore().fetchFilters(server.client, 'b');
    filterStore().addRule(rule(id));
    await filterStore().saveFilters(server.client);
    expect(filterStore().error).toBeNull();
  };
  /** Filters next to an auto-reply for senders from outside that was on and is off again. */
  const offAgain = async () => {
    useVacationStore.setState(initialVacation, true);
    const server = account([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await vacation().updateVacationResponse(server.client, { isEnabled: true, audience: external }, 'b');
    expect(server.content('filters')).toContain(NARROWED);
    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.content('filters')).toContain(FOR_EVERYONE);
    return server;
  };

  it('narrows the include of "managed" only while the auto-reply is on, through every save of the rules', async () => {
    const server = account([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);

    // On, for senders from outside only, with forwarding.
    await vacation().updateVacationResponse(server.client, { isEnabled: true, audience: external, forward: FORWARD }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(NARROWED);
    expect(server.content('filters')).toContain('redirect :copy "kollege@example.com";');
    expect(await card(server)).toEqual({ isEnabled: true, notRunning: false, audience: external, forwarding: true });
    await saveRule(server, 'b');
    expect(server.content('filters')).toContain(NARROWED);

    // Off: "managed" answers nobody and runs for every sender again. The
    // choice waits, forwarding goes on.
    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FOR_EVERYONE);
    expect(server.content('filters')).not.toContain(AUDIENCE);
    expect(server.content('filters')).toContain('redirect :copy "kollege@example.com";');
    expect(await card(server)).toEqual({ isEnabled: false, notRunning: false, audience: external, forwarding: true });

    // It stays that way: a save of the rules, a rule made from a message,
    // and a save of the card, which has nothing more to write.
    await saveRule(server, 'c');
    await updateAccountFilters(server.client, 'b', (rules) => insertRuleAtTop(rules, rule('quick')));
    const writes = server.writes();
    await vacation().updateVacationResponse(server.client, { isEnabled: false, subject: 'Urlaub' }, 'b');
    expect(server.writes()).toBe(writes);
    expect(server.content('filters')).toContain(FOR_EVERYONE);
    expect(server.content('filters')).not.toContain(AUDIENCE);
    expect(ruleIds(server.content('filters'))).toEqual(['quick', 'a', 'b', 'c']);

    // On again: narrowed again, to the choice that waited.
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(NARROWED);
    expect(await card(server)).toEqual({ isEnabled: true, notRunning: false, audience: external, forwarding: true });
    const managed = server.scripts.find((s) => s.name === 'managed');
    expect(server.client.updateSieveScript.mock.calls.some(([id]) => id === managed?.id)).toBe(false);
  });

  it('keeps the test to the period of the auto-reply, so that "managed" runs for every sender before and after it', async () => {
    const server = account([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    const scheduled = { ...external, activeFrom: FROM, activeUntil: UNTIL };

    await vacation().updateVacationResponse(server.client, { isEnabled: true, fromDate: FROM, toDate: UNTIL, audience: external }, 'b');
    expect(server.active()).toBe('filters');
    const block = replyBlock(server.content('filters'));
    // The include runs for the chosen senders, or outside the period.
    expect(block.split('\n')[1]).toMatch(
      /^if anyof\(not envelope :domain :is "from" \["example\.com"\], not allof\(anyof\(currentdate .*"ge" "time" "08:00:00"\)\), anyof\(currentdate .*"le" "time" "17:30:00"\)\)\)\) \{$/,
    );
    expect(block).toContain('"date" "2026-12-24"');
    expect(block).toContain('"date" "2027-01-06"');
    expect(block.split('\n').slice(2)).toEqual([`    ${include('managed')}`, '}']);
    expect(parseScript(server.content('filters')).vacationAudience).toEqual(scheduled);
    expect(await card(server)).toEqual({ isEnabled: true, notRunning: false, audience: scheduled, forwarding: false });

    // A save of the rules keeps it, and a save of the card has nothing to write.
    await saveRule(server, 'b');
    expect(replyBlock(server.content('filters'))).toBe(block);
    const writes = server.writes();
    await vacation().updateVacationResponse(server.client, { isEnabled: true, fromDate: FROM, toDate: UNTIL, subject: 'Urlaub' }, 'b');
    expect(server.writes()).toBe(writes);
    expect(replyBlock(server.content('filters'))).toBe(block);
  });

  it('moves the test to a new period, and turns it on again, without answering anyone else in between', async () => {
    const server = account([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await vacation().updateVacationResponse(server.client, { isEnabled: true, fromDate: FROM, toDate: UNTIL, audience: external }, 'b');
    const filtersAtSet: string[] = [];
    const setVacation = server.client.setVacationResponse.getMockImplementation();
    server.client.setVacationResponse.mockImplementation(async (updates: Record<string, unknown>) => {
      filtersAtSet.push(server.content('filters'));
      await setVacation?.(updates);
    });

    // Next year's dates. When the server takes them, the test holds whatever the period.
    const next = { fromDate: '2027-12-23T08:00:00Z', toDate: '2028-01-07T17:30:00Z' };
    await vacation().updateVacationResponse(server.client, { isEnabled: true, ...next }, 'b');
    expect(filtersAtSet).toHaveLength(1);
    expect(filtersAtSet[0]).toContain(NARROWED);
    expect(parseScript(server.content('filters')).vacationAudience).toEqual({ ...external, activeFrom: next.fromDate, activeUntil: next.toDate });
    expect(replyBlock(server.content('filters'))).toContain('"date" "2027-12-23"');
    expect(replyBlock(server.content('filters'))).not.toContain('"date" "2026-12-24"');

    // Off: for every sender. On again: the test is there before the server answers.
    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.content('filters')).toContain(FOR_EVERYONE);
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(filtersAtSet).toHaveLength(3);
    expect(filtersAtSet[2]).toContain(NARROWED);
    expect(replyBlock(server.content('filters'))).toContain('"date" "2027-12-23"');
    expect(await card(server)).toMatchObject({ isEnabled: true, notRunning: false });
  });

  it('says when another client moved the period of the auto-reply, and follows it with the next save of the card', async () => {
    const server = account([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await vacation().updateVacationResponse(server.client, { isEnabled: true, fromDate: FROM, toDate: UNTIL, audience: external }, 'b');
    const earlier = '2026-12-01T08:00:00Z';
    await server.client.setVacationResponse({ fromDate: earlier });
    expect(await card(server)).toMatchObject({ isEnabled: true, notRunning: true });

    // The card saves what it shows.
    const shown = vacation();
    await shown.updateVacationResponse(server.client, { isEnabled: true, fromDate: shown.fromDate, toDate: shown.toDate }, 'b');
    expect(parseScript(server.content('filters')).vacationAudience).toEqual({ ...external, activeFrom: earlier, activeUntil: UNTIL });
    expect(await card(server)).toMatchObject({ isEnabled: true, notRunning: false });
  });

  it('keeps what is changed while the auto-reply is off, with the include for every sender', async () => {
    const server = await offAgain();
    const internal = { only: 'internal' as const, domains: ['example.com'] };

    // Another choice and forwarding: stored, and nothing is narrowed.
    await vacation().updateVacationResponse(server.client, { isEnabled: false, audience: internal, forward: FORWARD }, 'b');
    expect(server.content('filters')).toContain(FOR_EVERYONE);
    expect(server.content('filters')).not.toContain('envelope :domain');
    expect(server.content('filters')).toContain('redirect :copy "kollege@example.com";');
    expect(await card(server)).toEqual({ isEnabled: false, notRunning: false, audience: internal, forwarding: true });

    // On: narrowed to that choice.
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.content('filters')).toContain(
      `# Vacation auto-reply\nif envelope :domain :is "from" ["example.com"] {\n    ${include('managed')}\n}\n`,
    );
    expect(await card(server)).toEqual({ isEnabled: true, notRunning: false, audience: internal, forwarding: true });

    // For everyone again and forwarding off, while off: the include stays, without a test.
    await vacation().updateVacationResponse(server.client, {
      isEnabled: false,
      audience: null,
      forward: { ...FORWARD, enabled: false },
    }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(FOR_EVERYONE);
    expect(server.content('filters')).not.toContain('envelope :domain');
    expect(server.content('filters')).not.toContain('redirect');
    expect(ruleIds(server.content('filters'))).toEqual(['a']);
    expect(await card(server)).toEqual({ isEnabled: false, notRunning: false, audience: null, forwarding: false });

    // On again changes the auto-reply only.
    const before = server.writes();
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.writes()).toBe(before);
    expect(await card(server)).toEqual({ isEnabled: true, notRunning: false, audience: null, forwarding: false });
  });

  it('says when the auto-reply was turned on elsewhere and answers everyone, and narrows it with the next save', async () => {
    // Another client: the server flips its switch, the include is as it was.
    const byCard = await offAgain();
    await byCard.client.setVacationResponse({ isEnabled: true });
    expect(byCard.content('filters')).toContain(FOR_EVERYONE);
    expect(await card(byCard)).toEqual({ isEnabled: true, notRunning: true, audience: external, forwarding: false });
    await vacation().updateVacationResponse(byCard.client, { isEnabled: true }, 'b');
    expect(byCard.content('filters')).toContain(NARROWED);
    expect(await card(byCard)).toEqual({ isEnabled: true, notRunning: false, audience: external, forwarding: false });

    // A save of the rules does the same: the server tells that it is on.
    const byRules = await offAgain();
    await byRules.client.setVacationResponse({ isEnabled: true });
    await saveRule(byRules, 'b');
    expect(byRules.content('filters')).toContain(NARROWED);
    expect(await card(byRules)).toEqual({ isEnabled: true, notRunning: false, audience: external, forwarding: false });

    // And a rule made from a message.
    const byMessage = await offAgain();
    await byMessage.client.setVacationResponse({ isEnabled: true });
    await updateAccountFilters(byMessage.client, 'b', (rules) => insertRuleAtTop(rules, rule('quick')));
    expect(byMessage.content('filters')).toContain(NARROWED);
  });

  it('asks the server again before a filters page loaded while the auto-reply was off writes the include for every sender', async () => {
    const server = await offAgain();
    await filterStore().fetchFilters(server.client, 'b');
    const loadedWhileOff = useFilterStore.getState();
    expect(loadedWhileOff.vacationAudienceIdle).toBe(true);

    // Turned on from another tab: this page still holds what it loaded.
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.content('filters')).toContain(NARROWED);
    useFilterStore.setState(loadedWhileOff, true);
    expect(filterStore().vacationAudienceIdle).toBe(true);
    filterStore().addRule(rule('b'));
    await filterStore().saveFilters(server.client);
    expect(filterStore().error).toBeNull();
    expect(server.content('filters')).toContain(NARROWED);
    expect(server.content('filters')).not.toContain(FOR_EVERYONE);
    expect(ruleIds(server.content('filters'))).toEqual(['a', 'b']);
  });

  it('narrows the include before it turns the auto-reply on again, so that nobody else is answered in between', async () => {
    const server = await offAgain();
    const filtersAtSet: string[] = [];
    const setVacation = server.client.setVacationResponse.getMockImplementation();
    server.client.setVacationResponse.mockImplementation(async (updates: Record<string, unknown>) => {
      filtersAtSet.push(server.content('filters'));
      await setVacation?.(updates);
    });

    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(filtersAtSet).toHaveLength(1);
    expect(filtersAtSet[0]).toContain(NARROWED);
    expect(await card(server)).toEqual({ isEnabled: true, notRunning: false, audience: external, forwarding: false });

    // Turned off, the server stops answering first.
    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(filtersAtSet[1]).toContain(NARROWED);
    expect(server.content('filters')).toContain(FOR_EVERYONE);
  });

  it('says when turning the auto-reply on could not narrow the include again', async () => {
    const server = await offAgain();
    await card(server);
    // Neither ahead of the auto-reply nor after it.
    server.client.updateSieveScript
      .mockRejectedValueOnce(new Error('server said no'))
      .mockRejectedValueOnce(new Error('server said no'));
    await expect(vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b'))
      .rejects.toBeInstanceOf(VacationFiltersError);
    expect(vacation()).toMatchObject({ isEnabled: true, notRunning: true, audience: external });

    // Saved again, as the card offers.
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.content('filters')).toContain(NARROWED);
    expect(vacation().notRunning).toBe(false);
  });

  it('puts the include back as it was when the server refuses the save it was narrowed for', async () => {
    // Turned on: narrowed ahead of the save, which the server then refuses.
    const off = await offAgain();
    off.client.setVacationResponse.mockRejectedValueOnce(new Error('refused'));
    await expect(vacation().updateVacationResponse(off.client, { isEnabled: true }, 'b')).rejects.toThrow('refused');
    expect(off.active()).toBe('filters');
    expect(off.content('filters')).toContain(FOR_EVERYONE);
    expect(off.content('filters')).not.toContain(AUDIENCE);
    expect(await card(off)).toEqual({ isEnabled: false, notRunning: false, audience: external, forwarding: false });

    // Other dates: the test goes back to the period the server still has.
    const on = account([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await vacation().updateVacationResponse(on.client, { isEnabled: true, fromDate: FROM, toDate: UNTIL, audience: external }, 'b');
    const block = replyBlock(on.content('filters'));
    on.client.setVacationResponse.mockRejectedValueOnce(new Error('refused'));
    await expect(vacation().updateVacationResponse(on.client, { isEnabled: true, fromDate: '2027-12-23T08:00:00Z' }, 'b'))
      .rejects.toThrow('refused');
    expect(replyBlock(on.content('filters'))).toBe(block);
    expect(parseScript(on.content('filters')).vacationAudience).toEqual({ ...external, activeFrom: FROM, activeUntil: UNTIL });
    expect(await card(on)).toMatchObject({ isEnabled: true, notRunning: false });
  });

  it('leaves the include narrowed after a save that failed while the server cannot be asked, until the next save', async () => {
    const server = await offAgain();
    server.client.setVacationResponse.mockRejectedValueOnce(new Error('offline'));
    server.client.getVacationResponse.mockRejectedValueOnce(new Error('offline'));
    await expect(vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b')).rejects.toThrow('offline');
    expect(server.content('filters')).toContain(NARROWED);

    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.content('filters')).toContain(FOR_EVERYONE);
    expect(server.content('filters')).not.toContain(AUDIENCE);
  });

  it('goes by the server, not by the caller, before the include runs for every sender', async () => {
    const server = account([{ name: 'filters', content: filters([rule('a')]), isActive: true }]);
    await vacation().updateVacationResponse(server.client, { isEnabled: true, audience: external }, 'b');
    expect(server.content('filters')).toContain(NARROWED);

    // A store that was never loaded takes the auto-reply for off, and a save
    // that leaves the switch out syncs the filters with that.
    useVacationStore.setState(initialVacation, true);
    await vacation().updateVacationResponse(server.client, { forward: FORWARD }, 'b');
    expect(server.content('filters')).toContain(NARROWED);
    expect(server.content('filters')).toContain('redirect :copy "kollege@example.com";');
    const writes = server.writes();
    await syncVacationWithFilters(server.client, false, 'b');
    expect(server.writes()).toBe(writes);

    // Off, but the server cannot be asked: narrowed until it can.
    await server.client.setVacationResponse({ isEnabled: false });
    server.client.getVacationResponse.mockRejectedValueOnce(new Error('offline'));
    await syncVacationWithFilters(server.client, false, 'b');
    expect(server.content('filters')).toContain(NARROWED);
    await syncVacationWithFilters(server.client, false, 'b');
    expect(server.content('filters')).toContain(FOR_EVERYONE);
    expect(server.content('filters')).toContain('redirect :copy "kollege@example.com";');
  });

  it('lets the filters take over from "managed" with rules of its own for every sender, unless the auto-reply is on', async () => {
    // A choice from an earlier auto-reply, and no include: Stalwart made
    // "managed" the active script for rules set there.
    const stored = generateScript([rule('a')], undefined, { extensions: EXTENSIONS, vacationAudience: external });
    const taken = () => account([
      { name: 'filters', content: stored, isActive: false },
      { name: 'managed', content: '# Rules set in Stalwart\n', isActive: true },
    ], true);

    // Off: that the choice does not run is as it should be.
    const byRules = taken();
    expect(await card(byRules)).toEqual({ isEnabled: false, notRunning: false, audience: external, forwarding: false });
    await saveRule(byRules, 'b');
    expect(byRules.active()).toBe('filters');
    expect(byRules.content('filters')).toContain(FOR_EVERYONE);
    expect(byRules.content('filters')).not.toContain(AUDIENCE);

    const byCard = taken();
    await vacation().updateVacationResponse(byCard.client, { isEnabled: false }, 'b');
    expect(byCard.active()).toBe('filters');
    expect(byCard.content('filters')).toContain(FOR_EVERYONE);
    expect(byCard.content('filters')).not.toContain(AUDIENCE);

    // On (another client), "managed" answers everyone: the card says so, and
    // the filters come back with the include narrowed.
    const on = taken();
    await on.client.setVacationResponse({ isEnabled: true });
    expect(await card(on)).toEqual({ isEnabled: true, notRunning: true, audience: external, forwarding: false });
    await saveRule(on, 'b');
    expect(on.active()).toBe('filters');
    expect(on.content('filters')).toContain(NARROWED);
    expect(await card(on)).toEqual({ isEnabled: true, notRunning: false, audience: external, forwarding: false });
  });

  it('lets an include that was left narrowed while off run for every sender with the next save', async () => {
    const left = () => account([
      {
        name: 'filters',
        content: generateScript([rule('a')], undefined, {
          extensions: EXTENSIONS, includeVacation: true, vacationScriptName: 'managed', vacationAudience: external,
        }),
        isActive: true,
      },
      { name: 'managed', content: STALWART_MANAGED_IDLE, isActive: false },
    ]);

    // Of the card.
    const byCard = left();
    expect(byCard.content('filters')).toContain(NARROWED);
    expect(await card(byCard)).toEqual({ isEnabled: false, notRunning: false, audience: external, forwarding: false });
    await vacation().updateVacationResponse(byCard.client, { isEnabled: false }, 'b');
    expect(byCard.active()).toBe('filters');
    expect(byCard.content('filters')).toContain(FOR_EVERYONE);
    expect(byCard.content('filters')).not.toContain(AUDIENCE);

    // Of the rules: the server tells that the auto-reply is off.
    const byRules = left();
    await saveRule(byRules, 'b');
    expect(byRules.active()).toBe('filters');
    expect(byRules.content('filters')).toContain(FOR_EVERYONE);
    expect(byRules.content('filters')).not.toContain(AUDIENCE);
    expect(ruleIds(byRules.content('filters'))).toEqual(['a', 'b']);
  });

  it('narrows an include that does not run when a save of the rules brings it back', async () => {
    const server = await offAgain();
    // Another client switched every script off. Nothing tells whom "managed"
    // answers once the filters include it again.
    await server.client.deactivateSieveScript('b');
    await saveRule(server, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(NARROWED);

    // The auto-reply is off, and the card's next save says so.
    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.content('filters')).toContain(FOR_EVERYONE);
  });
});

// From 1.2 Stalwart neither writes nor reads its "vacation" script any more.
// One left over from before the update still answers while it runs, and it
// holds the reply that was set back then.
describe('Stalwart 1.2 with a "vacation" script from before the update', () => {
  const FROM = '2026-11-20T07:00:00Z';
  const UNTIL = '2026-11-28T17:00:00Z';
  const OLD_SCRIPT = stalwartVacationScript({
    fromDate: FROM,
    toDate: UNTIL,
    subject: 'Abwesend',
    mimeBody: 'Content-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: 7bit\r\n\r\nIch bin bis 28.11. nicht im Haus.\r\n',
  });
  const oldReply = (isEnabled: boolean) => ({
    isEnabled, subject: 'Abwesend', textBody: 'Ich bin bis 28.11. nicht im Haus.', fromDate: FROM, toDate: UNTIL,
  });
  // Stalwart 1.2 starts "managed" without any reply.
  const account = (initial: Parameters<typeof mockStalwartAccount>[1]) =>
    mockStalwartAccount('b', initial, EXTENSIONS, { managedScript: true, vacation: { textBody: '' } });
  const vacation = () => useVacationStore.getState();
  const filterStore = () => useFilterStore.getState();
  const load = async (server: ReturnType<typeof account>) => {
    await vacation().fetchVacationResponse(server.client, 'b');
    const { isEnabled, subject, textBody, fromDate, toDate } = vacation();
    return { isEnabled, subject, textBody, fromDate, toDate };
  };
  // What the card sends: every field as it shows them.
  const saveCard = (server: ReturnType<typeof account>, isEnabled: boolean) => {
    const card = vacation();
    return card.updateVacationResponse(server.client, {
      isEnabled,
      fromDate: card.fromDate,
      toDate: card.toDate,
      subject: card.subject,
      textBody: card.textBody,
      htmlBody: card.htmlBody,
    }, 'b');
  };
  const untouched = (server: ReturnType<typeof account>) => {
    expect(server.content('vacation')).toBe(OLD_SCRIPT);
    const old = server.scripts.find((s) => s.name === 'vacation');
    expect(server.client.updateSieveScript.mock.calls.some(([id]) => id === old?.id)).toBe(false);
  };

  it('shows a reply the filters still include as on, keeps it through a filter save, and moves it to "managed" on save', async () => {
    const server = account([
      { name: 'filters', content: generateScript([rule('a')], undefined, { extensions: EXTENSIONS, includeVacation: true }), isActive: true },
      { name: 'vacation', content: OLD_SCRIPT, isActive: false },
    ]);
    expect(await load(server)).toEqual(oldReply(true));

    // A save of the rules leaves the old reply running.
    await filterStore().fetchFilters(server.client, 'b');
    filterStore().addRule(rule('b'));
    await filterStore().saveFilters(server.client);
    expect(filterStore().error).toBeNull();
    expect(server.content('filters')).toContain(include('vacation'));
    expect(await load(server)).toEqual(oldReply(true));

    // Saved from the card, the same reply runs from "managed" instead.
    await saveCard(server, true);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include('managed'));
    expect(server.content('filters')).not.toContain(include('vacation'));
    expect(ruleIds(server.content('filters'))).toEqual(['a', 'b']);
    expect(await load(server)).toEqual(oldReply(true));

    // Off: nothing answers any more, and the reply stays for next time.
    await saveCard(server, false);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include('managed'));
    expect(await load(server)).toEqual(oldReply(false));
    untouched(server);
  });

  it('stops a reply the filters still include when it is turned off first', async () => {
    const server = account([
      { name: 'filters', content: generateScript([rule('a')], undefined, { extensions: EXTENSIONS, includeVacation: true }), isActive: true },
      { name: 'vacation', content: OLD_SCRIPT, isActive: false },
    ]);
    expect(await load(server)).toEqual(oldReply(true));

    await saveCard(server, false);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).not.toContain('include');
    expect(ruleIds(server.content('filters'))).toEqual(['a']);
    expect(await load(server)).toEqual(oldReply(false));
    untouched(server);
  });

  it('shows a reply that runs alone as on, and switches it off for good', async () => {
    const server = account([{ name: 'vacation', content: OLD_SCRIPT, isActive: true }]);
    expect(await load(server)).toEqual(oldReply(true));

    await saveCard(server, false);
    expect(server.active()).toBeNull();
    expect(await load(server)).toEqual(oldReply(false));

    await saveCard(server, true);
    expect(server.active()).toBe('managed');
    expect(await load(server)).toEqual(oldReply(true));
    untouched(server);
  });

  it('keeps the reply of an old script that no longer runs for the next time it is turned on', async () => {
    const server = account([
      { name: 'filters', content: filters([rule('a')]), isActive: true },
      { name: 'vacation', content: OLD_SCRIPT, isActive: false },
    ]);
    expect(await load(server)).toEqual(oldReply(false));

    await saveCard(server, true);
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include('managed'));
    expect(await load(server)).toEqual(oldReply(true));
    untouched(server);
  });

  // A plugin turns the reply on with nothing but the switch.
  it('sends the old reply along with a save that only turns it on', async () => {
    const server = account([
      { name: 'filters', content: filters([rule('a')]), isActive: true },
      { name: 'vacation', content: OLD_SCRIPT, isActive: false },
    ]);
    expect(await load(server)).toEqual(oldReply(false));

    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(await server.client.getVacationResponse()).toMatchObject(oldReply(true));
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(include('managed'));
    expect(await load(server)).toEqual(oldReply(true));
    untouched(server);
  });

  // The sidebar's "turn off" sends the switch alone as well.
  it('sends the old reply along with a save that only turns it off, once', async () => {
    const server = account([{ name: 'vacation', content: OLD_SCRIPT, isActive: true }]);
    expect(await load(server)).toEqual(oldReply(true));

    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.active()).toBeNull();
    expect(await server.client.getVacationResponse()).toMatchObject(oldReply(false));
    expect(await load(server)).toEqual(oldReply(false));

    // The reply is the server's own now, so the switch goes alone.
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.client.setVacationResponse).toHaveBeenLastCalledWith({ isEnabled: true }, 'b');
    expect(server.active()).toBe('managed');
    expect(await load(server)).toEqual(oldReply(true));
    untouched(server);
  });

  it('keeps the old reply out of a save for another account', async () => {
    const server = account([{ name: 'vacation', content: OLD_SCRIPT, isActive: false }]);
    expect(await load(server)).toEqual(oldReply(false));

    // The card holds the reply of account "b"; this save names no account.
    await vacation().updateVacationResponse(server.client, { isEnabled: false });
    expect(server.client.setVacationResponse).toHaveBeenLastCalledWith({ isEnabled: false }, undefined);
  });

  it('shows the reply in use once "managed" answers, even an empty one', async () => {
    const server = account([{ name: 'vacation', content: OLD_SCRIPT, isActive: false }]);
    expect(await load(server)).toEqual(oldReply(false));

    // Every field cleared in the card, and turned on.
    await vacation().updateVacationResponse(server.client, {
      isEnabled: true, fromDate: null, toDate: null, subject: '', textBody: '', htmlBody: null,
    }, 'b');
    expect(server.active()).toBe('managed');
    expect(await load(server)).toEqual({ isEnabled: true, subject: '', textBody: '', fromDate: null, toDate: null });
    untouched(server);
  });
});

describe('the script the filters include', () => {
  it('is read back by its name, whoever the reply is for', () => {
    // A domain that reads like the statement itself.
    const script = generateScript([rule('a')], undefined, {
      extensions: EXTENSIONS,
      includeVacation: true,
      vacationScriptName: 'managed',
      vacationAudience: { only: 'internal', domains: ['include.example.com'] },
    });
    expect(script).toContain('["include.example.com"]');
    expect(parseScript(script).vacationScriptName).toBe('managed');
  });
});

describe('Stalwart up to 1.1', () => {
  it('takes the reply from VacationResponse, not from its vacation script', async () => {
    const server = mockStalwartAccount('b', [
      { name: 'vacation', content: stalwartVacationScript({ mimeBody: 'Content-Type: text/plain\r\n\r\nI am away.\r\n' }), isActive: true },
    ], EXTENSIONS, { vacation: { textBody: '' } });
    await useVacationStore.getState().fetchVacationResponse(server.client, 'b');
    expect(useVacationStore.getState().isEnabled).toBe(true);
    expect(useVacationStore.getState().textBody).toBe('');
  });
});
