import { afterEach, describe, expect, it } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { generateScript } from '@/lib/sieve/generator';
import { parseScript } from '@/lib/sieve/parser';
import { mockStalwartAccount, stalwartVacationScript } from '@/lib/filters/__tests__/sieve-mock';
import { useFilterStore } from '../filter-store';
import { useVacationStore } from '../vacation-store';

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

describe('Stalwart 1.2: who the auto-reply is for, and forwarding', () => {
  const vacation = () => useVacationStore.getState();
  const AUDIENCE = 'if not envelope :domain :is "from" ["example.com"] {';

  it('keeps the include of "managed" through changes made while the auto-reply is off', async () => {
    const server = mockStalwartAccount('b', [
      { name: 'filters', content: filters([rule('a')]), isActive: true },
    ], EXTENSIONS, { managedScript: true, vacation: { textBody: '' } });
    const card = async () => {
      await vacation().fetchVacationResponse(server.client, 'b');
      const { isEnabled, notRunning, audience, forward } = vacation();
      return { isEnabled, notRunning, audience, forwarding: !!forward?.enabled };
    };
    const external = { only: 'external' as const, domains: ['example.com'] };

    // On, for senders from outside only, with forwarding.
    await vacation().updateVacationResponse(server.client, {
      isEnabled: true,
      audience: external,
      forward: { enabled: true, to: 'kollege@example.com', keepCopy: true },
    }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(`${AUDIENCE}\n    ${include('managed')}\n}`);
    expect(server.content('filters')).toContain('redirect :copy "kollege@example.com";');
    expect(await card()).toEqual({ isEnabled: true, notRunning: false, audience: external, forwarding: true });

    // Off: the script stays as it is, forwarding goes on.
    const writes = server.writes();
    await vacation().updateVacationResponse(server.client, { isEnabled: false }, 'b');
    expect(server.writes()).toBe(writes);
    expect(server.active()).toBe('filters');
    expect(await card()).toEqual({ isEnabled: false, notRunning: false, audience: external, forwarding: true });

    // For everyone again and forwarding off, still while off: the include stays, without its test.
    await vacation().updateVacationResponse(server.client, {
      isEnabled: false,
      audience: null,
      forward: { enabled: false, to: 'kollege@example.com', keepCopy: true },
    }, 'b');
    expect(server.active()).toBe('filters');
    expect(server.content('filters')).toContain(`\n${include('managed')}\n`);
    expect(server.content('filters')).not.toContain(AUDIENCE);
    expect(server.content('filters')).not.toContain('redirect');
    expect(ruleIds(server.content('filters'))).toEqual(['a']);
    expect(await card()).toEqual({ isEnabled: false, notRunning: false, audience: null, forwarding: false });

    // On again changes the auto-reply only.
    const before = server.writes();
    await vacation().updateVacationResponse(server.client, { isEnabled: true }, 'b');
    expect(server.writes()).toBe(before);
    expect(await card()).toEqual({ isEnabled: true, notRunning: false, audience: null, forwarding: false });
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
