// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NOTES, PassStoppedError, SOURCE_RETRY_DELAYS_MS, newAccountState, runAccountPass, type AccountSources, type AccountState } from '../engine';
import type { CopyWhat } from '../types';
import { FakeDavSource, FakeMailSource, FakeSieveSource, FakeTarget, MemoryEngineStore, fakeClock, type FakeFolder } from './fakes';

const ALL: CopyWhat = { mail: true, contacts: true, calendars: true, filters: true };
const MAIL: CopyWhat = { mail: true, contacts: false, calendars: false, filters: false };

function folder(messages: FakeFolder['messages'], extra: Partial<FakeFolder> = {}): FakeFolder {
  return { delimiter: '/', noselect: false, uidValidity: '1', messages, ...extra };
}

function setup(opts: { folders?: Record<string, FakeFolder>; sources?: Partial<AccountSources>; target?: FakeTarget } = {}) {
  const mail = new FakeMailSource(opts.folders ?? {
    INBOX: folder([
      { uid: 1, flags: ['\\Seen', '\\Flagged'], messageId: 'a@x', internalDate: new Date('2019-05-01T08:00:00Z') },
      { uid: 2, flags: ['\\Answered', '$Forwarded', '\\Recent'], messageId: 'b@x' },
    ]),
    'INBOX/Sent Items': folder([{ uid: 7, flags: ['\\Seen'], messageId: 'c@x' }]),
    Projects: folder([], { noselect: true }),
    'Projects/2026': folder([{ uid: 3, messageId: 'd@x' }]),
  });
  const target = opts.target ?? new FakeTarget();
  const store = new MemoryEngineStore();
  const clock = fakeClock();
  const state: AccountState = newAccountState();
  const sources: AccountSources = { mail: async () => mail, ...opts.sources };
  const run = (what: CopyWhat = MAIL, signal = new AbortController().signal) =>
    runAccountPass({ what, sources, target: async () => target, state, store, signal, clock });
  return { mail, target, store, clock, state, run };
}

describe('mail', () => {
  it('copies with the folder hierarchy, roles, dates and flags', async () => {
    const { target, state, run } = setup();
    await run();
    expect(state.status).toBe('done');
    const byMailbox = (id: string) => target.emails.filter((e) => e.mailboxId === id);
    expect(byMailbox('mb-inbox')).toHaveLength(2);
    // INBOX/Sent Items is the sent folder, by name.
    expect(byMailbox('mb-sent')).toHaveLength(1);
    const projects = target.mailboxes.find((m) => m.name === 'Projects')!;
    const year = target.mailboxes.find((m) => m.name === '2026')!;
    expect(projects.parentId).toBeNull();
    expect(year.parentId).toBe(projects.id);
    expect(byMailbox(year.id)).toHaveLength(1);
    const first = target.emails.find((e) => e.content.includes('<a@x>'))!;
    expect(first.receivedAt).toBe('2019-05-01T08:00:00.000Z');
    expect(first.keywords).toEqual({ $seen: true, $flagged: true });
    expect(target.emails.find((e) => e.content.includes('<b@x>'))!.keywords).toEqual({ $answered: true, $forwarded: true });
    expect(state.report.counts.messages.copied).toBe(4);
    expect(state.report.counts.folders.copied).toBe(2);
    expect(state.progress).toEqual({ messagesDone: 4, messagesTotal: 4 });
  });

  it('copies nothing on a second pass, and only a new UID on a third', async () => {
    const { mail, target, state, run } = setup();
    await run();
    const after = target.emails.length;
    state.status = 'queued';
    await run();
    expect(target.emails.length).toBe(after);
    expect(state.progress).toEqual({ messagesDone: 0, messagesTotal: 0 });
    expect(target.mailboxes.filter((m) => m.name === 'Projects')).toHaveLength(1);

    mail.folders.INBOX.messages.push({ uid: 9, messageId: 'new@x' });
    state.status = 'queued';
    await run();
    expect(target.emails.length).toBe(after + 1);
    expect(target.emails.at(-1)!.content).toContain('<new@x>');
  });

  it('creates a folder new on the source in a later pass', async () => {
    const { mail, target, state, run } = setup();
    await run();
    mail.folders['Projects/2027'] = folder([{ uid: 1, messageId: 'e@x' }]);
    state.status = 'queued';
    await run();
    expect(target.mailboxes.filter((m) => m.name === '2027')).toHaveLength(1);
    expect(target.emails.at(-1)!.content).toContain('<e@x>');
  });

  it('dedupes by Message-ID hash when UIDVALIDITY changed', async () => {
    const { mail, target, state, store, run } = setup();
    await run();
    const before = target.emails.length;
    // The server renumbered INBOX: same messages, new UIDs, plus one new one.
    mail.folders.INBOX = folder([
      { uid: 101, messageId: 'a@x' },
      { uid: 102, messageId: 'b@x' },
      { uid: 103, messageId: 'fresh@x' },
    ], { uidValidity: '2' });
    state.status = 'queued';
    await run();
    expect(target.emails.length).toBe(before + 1);
    expect(target.emails.at(-1)!.content).toContain('<fresh@x>');
    expect(state.copyMap.folders.INBOX).toMatchObject({ uidValidity: '2', lastUid: 103 });
    // Hashes are kept, not the Message-IDs themselves.
    expect(JSON.stringify([...store.hashes.values()])).not.toContain('a@x');
  });

  it('skips messages over the upload limit and lists them by folder and UID', async () => {
    const { state, target, run } = setup({ folders: { INBOX: folder([{ uid: 5, size: 50_000, messageId: 'big@x' }, { uid: 6, messageId: 'ok@x' }]) } });
    await run();
    expect(target.emails).toHaveLength(1);
    expect(state.status).toBe('done_with_problems');
    expect(state.report.counts.messages.skipped).toBe(1);
    expect(state.report.problems[0]).toMatchObject({ phase: 'mail', item: 'INBOX UID 5' });
    expect(state.report.problems[0].reason).toContain(NOTES.tooLarge);
  });

  it('pauses on a 429 until Retry-After and goes on by itself', async () => {
    const { target, state, store, clock, run } = setup();
    target.rateLimitUploads = 1;
    target.rateLimitRetryMs = 90_000;
    const start = clock.time;
    await run();
    expect(store.saved.some((s) => s.status === 'paused' && s.pausedUntil === start + 90_000)).toBe(true);
    expect(clock.time).toBeGreaterThanOrEqual(start + 90_000);
    expect(state.status).toBe('done');
    expect(target.emails).toHaveLength(4);
  });

  it('retries a dropped source 3 times, then fails the account', async () => {
    const ok = setup();
    ok.mail.failNext = 3;
    await ok.run();
    expect(ok.state.status).toBe('done');
    expect(ok.clock.sleeps.slice(0, 3)).toEqual(SOURCE_RETRY_DELAYS_MS);

    const bad = setup();
    bad.mail.failNext = 4;
    await bad.run();
    expect(bad.state.status).toBe('failed');
    expect(bad.state.error).toBe('Connection reset');
    expect(bad.target.emails).toHaveLength(0);
  });

  it('cancel stops after the current batch and keeps what was copied', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ uid: i + 1, messageId: `m${i}@x` }));
    const { target, store, state, run } = setup({ folders: { INBOX: folder(messages) } });
    target.onImport = () => { store.cancelled = true; };
    await run();
    expect(state.status).toBe('cancelled');
    expect(target.emails).toHaveLength(20);
    expect(state.copyMap.folders.INBOX.lastUid).toBe(20);
  });

  it('a stopped pass resumes without importing the cut-off batch twice', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ uid: i + 1, messageId: `m${i}@x` }));
    const { target, store, state, run } = setup({ folders: { INBOX: folder(messages) } });
    const controller = new AbortController();
    // Stopped right after the first Email/import, before its checkpoint was written:
    // the stored state still has the batch in flight.
    target.onImport = () => { store.frozen = true; controller.abort(); };
    await run(MAIL, controller.signal).catch(() => {});
    const stored = store.saved.at(-1)!;
    expect(stored.inflight?.messageIds).toHaveLength(20);
    // The emails did land, the checkpoint didn't.
    target.onImport = undefined;
    store.frozen = false;
    Object.assign(state, structuredClone(stored), { status: 'mail', phase: 'mail' });
    await run();
    expect(state.status).toBe('done');
    expect(target.emails).toHaveLength(30);
    expect(new Set(target.emails.map((e) => e.content)).size).toBe(30);
  });

  it('throws PassStoppedError when the job stops, leaving the state to resume', async () => {
    const { state, run } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(run(MAIL, controller.signal)).rejects.toBeInstanceOf(PassStoppedError);
    expect(state.status).not.toBe('done');
  });
});

describe('contacts and calendars', () => {
  const vcard = (uid: string, name: string) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${name}\r\nN:${name};;;;\r\nEND:VCARD\r\n`;
  const ics = (uid: string, title: string) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

  function davSetup() {
    const contacts = new FakeDavSource([
      { href: '/carddav/Contacts/', name: 'Contacts', isDefault: true, objects: [{ href: '/carddav/Contacts/1.vcf', etag: '"1"', data: vcard('c1', 'Ada') }] },
      { href: '/carddav/32/', name: 'Suppliers', objects: [{ href: '/carddav/32/2.vcf', etag: '"1"', data: vcard('c2', 'Bob') }] },
    ]);
    const calendars = new FakeDavSource([
      { href: '/caldav/work/', name: 'Work', color: '#ff2968', components: ['VEVENT'], objects: [{ href: '/caldav/work/e1.ics', etag: '"a"', data: ics('e1', 'Standup') }] },
      { href: '/caldav/tasks/', name: 'Tasks', components: ['VTODO'], objects: [] },
    ]);
    const ctx = setup({ folders: {}, sources: { contacts: async () => contacts, calendars: async () => calendars } });
    return { ...ctx, contacts, calendars };
  }

  it('lands in matching address books and calendars, without scheduling messages', async () => {
    const { target, state, run } = davSetup();
    await run(ALL);
    const suppliers = target.addressBooks.find((b) => b.name === 'Suppliers')!;
    const cards = [...target.contacts.values()];
    expect(cards.find((c) => c.uid === 'c1')!.addressBookIds).toEqual({ 'ab-default': true });
    expect(cards.find((c) => c.uid === 'c2')!.addressBookIds).toEqual({ [suppliers.id]: true });
    const work = target.calendars.find((c) => c.name === 'Work') as { id: string; color?: string };
    expect(work.color).toBe('#ff2968');
    const event = [...target.events.values()][0];
    expect(event).toMatchObject({ uid: 'e1', title: 'Standup', calendarIds: { [work.id]: true } });
    expect(target.eventSets.every((s) => s.extra.sendSchedulingMessages === false)).toBe(true);
    expect(state.report.problems.some((p) => p.item === 'Tasks' && p.reason === NOTES.taskList)).toBe(true);
    expect(target.calendars.some((c) => c.name === 'Tasks')).toBe(false);
  });

  it('a second pass changes nothing, a changed ETag updates the target object', async () => {
    const { target, contacts, calendars, state, run } = davSetup();
    await run(ALL);
    const contactCount = target.contacts.size;
    state.status = 'queued';
    await run(ALL);
    expect(target.contacts.size).toBe(contactCount);
    expect(target.eventSets).toHaveLength(1);

    contacts.collections[0].objects[0] = { href: '/carddav/Contacts/1.vcf', etag: '"2"', data: vcard('c1', 'Ada Lovelace') };
    calendars.collections[0].objects[0] = { href: '/caldav/work/e1.ics', etag: '"b"', data: ics('e1', 'Daily standup') };
    state.status = 'queued';
    await run(ALL);
    expect(target.contacts.size).toBe(contactCount);
    expect([...target.contacts.values()].find((c) => c.uid === 'c1')!.name).toMatchObject({ full: 'Ada Lovelace' });
    expect(target.eventSets.at(-1)).toMatchObject({ create: 0, update: 1 });
    expect([...target.events.values()][0].title).toBe('Daily standup');
  });

  it('skips calendars and contacts with the reason when there is no user password', async () => {
    const { state, run } = setup({ folders: {}, sources: { skipReasons: { contacts: NOTES.davNeedsPassword, calendars: NOTES.davNeedsPassword } } });
    await run(ALL);
    expect(state.report.problems.filter((p) => p.reason === NOTES.davNeedsPassword)).toHaveLength(2);
  });
});

describe('filters', () => {
  it('activates the source active script on an empty target and reports refusals', async () => {
    const sieve = new FakeSieveSource([
      { name: 'main', active: true, content: 'require "fileinto";' },
      { name: 'broken', active: false, content: 'require "x-unknown";' },
    ]);
    const target = new FakeTarget();
    target.refusedScripts.set('broken', 'Unsupported extension x-unknown');
    const { state, run } = setup({ folders: {}, target, sources: { sieve: async () => sieve } });
    await run(ALL);
    expect(target.scripts).toEqual([expect.objectContaining({ name: 'main', isActive: true })]);
    expect(state.report.problems).toContainEqual({ phase: 'filters', item: 'broken', reason: 'Unsupported extension x-unknown' });
    expect(state.report.counts.scripts).toEqual({ copied: 1, skipped: 0, failed: 1 });
  });

  it('imports inactive next to an active script, renames a clash, and copies only changes later', async () => {
    const sieve = new FakeSieveSource([{ name: 'main', active: true, content: 'keep;' }]);
    const target = new FakeTarget();
    target.scripts.push({ id: 's0', name: 'main', isActive: true, content: 'stop;' });
    const { state, run } = setup({ folders: {}, target, sources: { sieve: async () => sieve } });
    await run(ALL);
    const migrated = target.scripts.find((s) => s.name === 'main (migrated)')!;
    expect(migrated.isActive).toBe(false);
    expect(target.scripts.find((s) => s.id === 's0')!.isActive).toBe(true);
    expect(state.report.problems.some((p) => p.reason === NOTES.inactive)).toBe(true);

    state.status = 'queued';
    await run(ALL);
    expect(target.scripts).toHaveLength(2);
    sieve.scripts[0].content = 'discard;';
    state.status = 'queued';
    await run(ALL);
    expect(target.scripts).toHaveLength(2);
    expect(migrated.content).toBe('discard;');
  });

  it('says why filters were not copied when the source has no ManageSieve', async () => {
    const { state, run } = setup({ folders: {} });
    await run(ALL);
    expect(state.report.problems).toContainEqual({ phase: 'filters', reason: NOTES.noSieve, note: true });
    expect(state.status).toBe('done');
  });
});
