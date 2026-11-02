import { test, expect, type Browser, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  ENT, ENT_SERVER, adminContext, getPolicy, jmapAs, putPolicy, rawMessage, requireEntEnv, shot, userPage, withPolicy,
} from './helpers/ent';
import { calendarItem, expandSharedFolders, folderRow, openCalendar } from './helpers/app';

/**
 * Enterprise pack, package B (calendar) against the VM 106 test Stalwarts:
 * Suggest times (6), answering for someone else (#634, 7), out-of-office
 * blocks the calendar (8), company calendars (9) and the free/busy sharing
 * the admin sets. Setup goes through the admin API and JMAP, so the spec
 * also runs against a build of main to show where it fails there.
 */

requireEntEnv();
test.describe.configure({ mode: 'serial' });

const CORE = 'urn:ietf:params:jmap:core';
const CAL = 'urn:ietf:params:jmap:calendars';
const PRINC = 'urn:ietf:params:jmap:principals';
const MAIL = 'urn:ietf:params:jmap:mail';
const VAC = 'urn:ietf:params:jmap:vacationresponse';
const USING = [CORE, CAL, PRINC];
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TS = Date.now().toString(36);
const READ_WRITE = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
  mayUpdatePrivate: true, mayRSVP: true, mayShare: false, mayDelete: false,
};

type J = Awaited<ReturnType<typeof jmapAs>>;

const pad = (n: number) => String(n).padStart(2, '0');
/** A local wall clock as a JSCalendar LocalDateTime. */
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

function nextWorkingDay(from = new Date()): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

async function call(j: J, calls: [string, Record<string, unknown>, string][], using = USING) {
  const res = await j.request(calls, using);
  for (const [name, result] of res.methodResponses) {
    if (name === 'error') throw new Error(`JMAP error: ${JSON.stringify(result)}`);
  }
  return res.methodResponses as [string, Record<string, unknown>, string][];
}

async function defaultCalendar(j: J, accountId = j.accountId): Promise<{ id: string; name: string; shareWith: Record<string, unknown> | null }> {
  const [[, r]] = await call(j, [['Calendar/get', { accountId, properties: ['name', 'isDefault', 'shareWith'] }, '0']]);
  const list = r.list as Array<{ id: string; name: string; isDefault: boolean; shareWith: Record<string, unknown> | null }>;
  return list.find((c) => c.isDefault) ?? list[0];
}

async function share(j: J, principalId: string, rights: Record<string, boolean> | null) {
  const cal = await defaultCalendar(j);
  await call(j, [['Calendar/set', { accountId: j.accountId, update: { [cal.id]: { [`shareWith/${principalId}`]: rights } } }, '0']]);
}

async function createEvent(j: J, event: Record<string, unknown>, send = false, accountId = j.accountId): Promise<{ id: string; uid: string }> {
  const cal = await defaultCalendar(j, accountId);
  const [[, r]] = await call(j, [['CalendarEvent/set', {
    accountId, create: { e: { '@type': 'Event', calendarIds: { [cal.id]: true }, timeZone: ZONE, ...event } }, sendSchedulingMessages: send,
  }, '0']]);
  const created = (r.created as Record<string, { id: string }> | undefined)?.e;
  if (!created) throw new Error(`event not created: ${JSON.stringify(r)}`);
  const [[, got]] = await call(j, [['CalendarEvent/get', { accountId, ids: [created.id], properties: ['uid'] }, '0']]);
  return { id: created.id, uid: (got.list as Array<{ uid: string }>)[0].uid };
}

async function findByUid(j: J, uid: string, accountId = j.accountId): Promise<string | null> {
  const [[, r]] = await call(j, [['CalendarEvent/query', { accountId, filter: { uid } }, '0']]);
  return ((r.ids as string[]) ?? [])[0] ?? null;
}

async function getEvent(j: J, id: string, accountId = j.accountId) {
  const [[, r]] = await call(j, [['CalendarEvent/get', { accountId, ids: [id] }, '0']]);
  return (r.list as Array<Record<string, unknown>>)[0];
}

async function destroyEvents(j: J, ids: Array<string | null | undefined>, accountId = j.accountId) {
  const list = ids.filter((id): id is string => !!id);
  if (list.length) await call(j, [['CalendarEvent/set', { accountId, destroy: list, sendSchedulingMessages: false }, '0']]).catch(() => {});
}

const participant = (name: string, email: string, owner = false) => ({
  '@type': 'Participant', name, email, calendarAddress: `mailto:${email}`, kind: 'individual', scheduleAgent: 'server',
  roles: owner ? { owner: true } : { attendee: true },
  participationStatus: owner ? 'accepted' : 'needs-action', expectReply: !owner,
});

/** Carol invites `attendees` to an hour starting `hoursAhead` from now; returns her event and its uid. */
async function carolInvites(title: string, attendees: Array<[string, string]>, hoursAhead = 26) {
  const carol = await jmapAs(ENT.carol);
  const start = new Date(Date.now() + hoursAhead * 3600_000);
  start.setMinutes(0, 0, 0);
  const participants: Record<string, unknown> = { carol: participant('Ent Carol', ENT.carol, true) };
  attendees.forEach(([name, email], i) => { participants[`a${i}`] = participant(name, email); });
  const created = await createEvent(carol, {
    title, start: local(start), duration: 'PT1H', organizerCalendarAddress: `mailto:${ENT.carol}`, participants,
  }, true);
  return { ...created, carol };
}

async function statusIn(j: J, eventId: string, email: string): Promise<string | undefined> {
  const event = await getEvent(j, eventId);
  const p = Object.values((event?.participants ?? {}) as Record<string, { email: string; participationStatus: string }>).find((x) => x.email === email);
  return p?.participationStatus;
}

async function waitForCopy(j: J, uid: string, accountId = j.accountId): Promise<string> {
  let id: string | null = null;
  await expect.poll(async () => (id = await findByUid(j, uid, accountId)), { timeout: 30_000 }).not.toBeNull();
  return id!;
}

/** Mail in carol's account whose text carries `marker`, newest first. */
async function carolMail(marker: string) {
  const carol = await jmapAs(ENT.carol);
  const [, [, got]] = await call(carol, [
    ['Email/query', { accountId: carol.accountId, filter: { text: marker }, sort: [{ property: 'receivedAt', isAscending: false }] }, 'q'],
    ['Email/get', { accountId: carol.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['subject', 'from', 'blobId'] }, 'g'],
  ], [CORE, MAIL]);
  return got.list as Array<{ id: string; subject: string; blobId: string; from: Array<{ email: string }> }>;
}

async function destroyMail(email: string, marker: string) {
  const j = await jmapAs(email);
  const [[, r]] = await call(j, [['Email/query', { accountId: j.accountId, filter: { text: marker } }, '0']], [CORE, MAIL]).catch(() => [[null, { ids: [] }]] as never);
  const ids = (r as { ids?: string[] }).ids ?? [];
  if (ids.length) await call(j, [['Email/set', { accountId: j.accountId, destroy: ids }, '0']], [CORE, MAIL]).catch(() => {});
}

/** The agenda view: the tab on phones, the "a" shortcut elsewhere. */
async function showAgenda(page: Page) {
  const tab = page.getByRole('button', { name: 'Agenda', exact: true }).locator('visible=true');
  if (await tab.count()) await tab.first().click();
  else await page.locator('body').press('a');
}

/** Agenda view (lists what is coming up) and the event detail of `title`. */
async function openEventInAgenda(page: Page, title: string, calendarHint?: string) {
  await openCalendar(page);
  await showAgenda(page);
  // An agenda row names the event and its calendar.
  const rows = page.locator('button', { hasText: title });
  const card = (calendarHint ? rows.filter({ hasText: calendarHint }) : rows).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function closePage(page: Page) {
  await page.context().close().catch(() => {});
}

// ── 6. Suggest times ─────────────────────────────────────────────────

async function startEventWith(page: Page, attendees: string[]) {
  await openCalendar(page);
  // Toolbar on wide screens, the round + button on phones.
  await page.locator('[data-tour="create-event-button"]').locator('visible=true').first().click();
  await page.getByLabel('Title').fill(`B find ${TS}`);
  const input = page.getByPlaceholder('Add email address or search contacts');
  for (const email of attendees) {
    await input.fill(email);
    await input.press('Enter');
  }
}

test('Suggest times proposes a slot free for every attendee whose free/busy is shared', async ({ browser }) => {
  test.setTimeout(240_000);
  const bob = await jmapAs(ENT.bob);
  const carol = await jmapAs(ENT.carol);
  const alice = await jmapAs(ENT.alice);
  const teamId = await bob.principalIdByEmail(ENT.team);
  // Free/busy shares, the way the docs tell users and admins to set them up:
  // bob with the group alice is in, carol with alice by name.
  await share(bob, teamId, { mayReadFreeBusy: true });
  await share(carol, alice.accountId, { mayReadFreeBusy: true });
  const day = nextWorkingDay();
  const at = (h: number) => { const d = new Date(day); d.setHours(h, 0, 0, 0); return d; };
  const now = new Date();
  now.setMinutes(0, 0, 0);
  // Bob is busy from now until 11:00 on the next working day, carol 11 to 12.
  const bobBusy = await createEvent(bob, { title: `B busy ${TS}`, start: local(now), duration: `PT${Math.round((at(11).getTime() - now.getTime()) / 60000)}M`, freeBusyStatus: 'busy' });
  const carolBusy = await createEvent(carol, { title: `B busy ${TS}`, start: local(at(11)), duration: 'PT1H', freeBusyStatus: 'busy' });
  const page = await userPage(browser, ENT.alice);
  try {
    await startEventWith(page, [ENT.bob, ENT.carol, ENT.dave]);
    await page.getByTestId('find-a-time-button').click();
    const slots = page.getByTestId('find-a-time-slots').locator('button');
    await expect(slots.first()).toBeVisible({ timeout: 30_000 });
    const first = new Date((await slots.first().getAttribute('data-slot-start'))!);
    // Free for bob and carol: not before 12:00 on the next working day.
    expect(first.getTime()).toBeGreaterThanOrEqual(at(12).getTime());
    expect(first.getTime()).toBeLessThan(at(20).getTime());
    for (const [j, who] of [[bob, 'bob'], [carol, 'carol']] as const) {
      const [[, r]] = await call(alice, [['Principal/getAvailability', {
        accountId: alice.accountId, id: j.accountId, utcStart: new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z'),
        utcEnd: new Date(at(23).getTime()).toISOString().replace(/\.\d+Z$/, 'Z'),
      }, '0']], [CORE, PRINC, 'urn:ietf:params:jmap:principals:availability', CAL]);
      const busy = r.list as Array<{ utcStart: string; utcEnd: string }>;
      expect(busy.length, `${who} has busy time visible to alice`).toBeGreaterThan(0);
      for (const p of busy) {
        const overlaps = Date.parse(p.utcStart) < first.getTime() + 3600_000 && Date.parse(p.utcEnd) > first.getTime();
        expect(overlaps, `${who} busy ${p.utcStart}-${p.utcEnd}`).toBe(false);
      }
    }
    // Dave shared nothing and has nothing on: never counted as free.
    const note = page.getByTestId('find-a-time-not-checked');
    await expect(note).toContainText(ENT.dave);
    await expect(note).toContainText('busy times unknown');
    await expect(page.getByTestId('free-busy-share')).toBeVisible();
    await shot(page, 'b-find-a-time');
    // Picking the slot moves the event there.
    await slots.first().click();
    await expect(page.getByTestId('find-a-time-panel')).toContainText('Event moved to');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('find-a-time-panel')).toHaveCount(0);
    await expect(page.getByTestId('find-a-time-button')).toBeFocused();
  } finally {
    await closePage(page);
    await destroyEvents(bob, [bobBusy.id]);
    await destroyEvents(carol, [carolBusy.id]);
    await share(bob, teamId, null).catch(() => {});
    await share(carol, alice.accountId, null).catch(() => {});
  }
});

test('the suggestion list fits a phone', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await userPage(browser, ENT.alice, true);
  try {
    await startEventWith(page, [ENT.bob]);
    await page.getByTestId('find-a-time-button').click();
    await expect(page.getByTestId('find-a-time-panel')).toBeVisible();
    await expect(page.getByTestId('find-a-time-panel').getByRole('status')).not.toContainText('Looking', { timeout: 30_000 });
    await page.getByTestId('find-a-time-panel').scrollIntoViewIfNeeded();
    await noHorizontalScroll(page);
    await shot(page, 'b-find-a-time-phone');
  } finally {
    await closePage(page);
  }
});

// ── Free/busy sharing set by the admin ───────────────────────────────

test('the admin\'s free/busy group is shared from a user\'s default calendar at sign-in', async ({ browser }) => {
  test.setTimeout(180_000);
  const admin = await adminContext(browser);
  const carol = await jmapAs(ENT.carol);
  const teamId = await carol.principalIdByEmail(ENT.team);
  await share(carol, teamId, null).catch(() => {});
  await withPolicy(admin, { organisation: { calendars: { feeds: [], freeBusyGroup: ENT.team } } }, async () => {
    const page = await userPage(browser, ENT.carol);
    try {
      await expect.poll(async () => {
        const cal = await defaultCalendar(carol);
        return (cal.shareWith?.[teamId] as { mayReadFreeBusy?: boolean } | undefined)?.mayReadFreeBusy ?? false;
      }, { timeout: 45_000 }).toBe(true);
      // Only free/busy, and it shows in the user's sharing list.
      const cal = await defaultCalendar(carol);
      expect(cal.shareWith?.[teamId]).toMatchObject({ mayReadFreeBusy: true, mayReadItems: false, mayWriteAll: false });
      await openCalendar(page);
      await expect(calendarItem(page, cal.name).getByTestId('calendar-shared-indicator')).toBeVisible({ timeout: 30_000 });
    } finally {
      await closePage(page);
      await share(carol, teamId, null).catch(() => {});
    }
  });
  await admin.close();
});

// ── 7. Answering for someone else (#634) ─────────────────────────────

test('a delegate answers for the calendar\'s owner: the organiser gets a REPLY with SENT-BY', async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await jmapAs(ENT.alice);
  const bob = await jmapAs(ENT.bob);
  const title = `B sentby ${TS}`;
  const invite = await carolInvites(title, [['Ent Alice', ENT.alice]]);
  const aliceCopy = await waitForCopy(alice, invite.uid);
  await share(alice, bob.accountId, READ_WRITE);
  const page = await userPage(browser, ENT.bob);
  try {
    await openEventInAgenda(page, title);
    const bar = page.getByTestId('answer-for-owner');
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(bar).toContainText('Answer for');
    await shot(page, 'b-answer-for');
    await bar.getByRole('button', { name: 'Accept' }).click();

    // Carol's inbox: the REPLY from alice with bob in SENT-BY.
    let raw = '';
    await expect.poll(async () => {
      for (const m of await carolMail(title)) {
        const text = (await rawMessage(ENT.carol, m.blobId)).replace(/\r?\n[ \t]/g, '');
        if (/METHOD:REPLY/.test(text)) { raw = text; return true; }
      }
      return false;
    }, { timeout: 60_000 }).toBe(true);
    const attendee = raw.split(/\r?\n/).find((l) => l.startsWith('ATTENDEE') && /ent-alice@example\.org/i.test(l)) ?? '';
    expect(attendee).toMatch(/PARTSTAT=ACCEPTED/);
    expect(attendee).toMatch(/SENT-BY="mailto:ent-bob@example\.org"/i);
    expect(raw).toMatch(/^From:.*ent-alice@example\.org/im);
    // Her copy changes alice.
    await expect.poll(async () => {
      const event = await getEvent(invite.carol, invite.id);
      const p = Object.values(event.participants as Record<string, { email: string; participationStatus: string }>).find((x) => x.email === ENT.alice);
      return p?.participationStatus;
    }, { timeout: 30_000 }).toBe('accepted');
    // Alice's own view says who answered.
    const ownerView = await getEvent(alice, aliceCopy);
    const aliceP = Object.values(ownerView.participants as Record<string, { email: string; sentBy?: string }>).find((x) => x.email === ENT.alice);
    expect(aliceP?.sentBy).toBe(`mailto:${ENT.bob}`);
  } finally {
    await closePage(page);
    await share(alice, bob.accountId, null).catch(() => {});
    await destroyEvents(invite.carol, [invite.id]);
    await destroyEvents(alice, [aliceCopy]);
    await destroyMail(ENT.carol, title);
    await destroyMail(ENT.alice, title);
  }
});

test('with the delegate invited too: both answers on 1.0, the owner\'s refused on 0.16', async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await jmapAs(ENT.alice);
  const bob = await jmapAs(ENT.bob);
  const title = `B both ${TS}`;
  const invite = await carolInvites(title, [['Ent Alice', ENT.alice], ['Ent Bob', ENT.bob]], 28);
  const aliceCopy = await waitForCopy(alice, invite.uid);
  const bobCopy = await waitForCopy(bob, invite.uid);
  await share(alice, bob.accountId, READ_WRITE);
  const page = await userPage(browser, ENT.bob);
  try {
    // The copy in alice's calendar; bob's own is listed too.
    await openEventInAgenda(page, title, ENT.alice);
    if (ENT_SERVER === '0.16') {
      await expect(page.getByTestId('answer-note-also_invited')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('answer-for-owner')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('answer-for-owner')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('answer-self')).toBeVisible();
    }
    await shot(page, 'b-answer-both-invited');
    if (ENT_SERVER !== '0.16') {
      // Both answers: alice accepts through bob, bob declines for himself.
      await page.getByTestId('answer-for-owner').getByRole('button', { name: 'Accept' }).click();
      await expect.poll(async () => statusIn(invite.carol, invite.id, ENT.alice), { timeout: 60_000 }).toBe('accepted');
      await openEventInAgenda(page, title, ENT.alice);
      await page.getByTestId('answer-self').getByRole('button', { name: 'Decline' }).click();
      // Carol's copy changed the right attendee each time.
      await expect.poll(async () => statusIn(invite.carol, invite.id, ENT.bob), { timeout: 60_000 }).toBe('declined');
      expect(await statusIn(invite.carol, invite.id, ENT.alice)).toBe('accepted');
    }
  } finally {
    await closePage(page);
    await share(alice, bob.accountId, null).catch(() => {});
    await destroyEvents(invite.carol, [invite.id]);
    await destroyEvents(alice, [aliceCopy]);
    await destroyEvents(bob, [bobCopy]);
    await destroyMail(ENT.carol, title);
  }
});

test('a member answers for a group mailbox as the group, without SENT-BY', async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await jmapAs(ENT.alice);
  const title = `B group ${TS}`;
  const teamAccount = alice.accountIdByName(ENT.team);
  const invite = await carolInvites(title, [['Ent Team', ENT.team]], 30);
  const teamCopy = await waitForCopy(alice, invite.uid, teamAccount);
  const page = await userPage(browser, ENT.alice);
  try {
    await openEventInAgenda(page, title);
    const bar = page.getByTestId('answer-for-owner');
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await bar.getByRole('button', { name: 'Accept' }).click();
    let raw = '';
    await expect.poll(async () => {
      for (const m of await carolMail(title)) {
        const text = (await rawMessage(ENT.carol, m.blobId)).replace(/\r?\n[ \t]/g, '');
        if (/METHOD:REPLY/.test(text)) { raw = text; return true; }
      }
      return false;
    }, { timeout: 60_000 }).toBe(true);
    const attendee = raw.split(/\r?\n/).find((l) => l.startsWith('ATTENDEE') && /ent-team@example\.org/i.test(l)) ?? '';
    expect(attendee).toMatch(/PARTSTAT=ACCEPTED/);
    expect(attendee).not.toMatch(/SENT-BY/i);
    expect(raw).toMatch(/^From:.*ent-team@example\.org/im);
  } finally {
    await closePage(page);
    await destroyEvents(invite.carol, [invite.id]);
    await destroyEvents(alice, [teamCopy], teamAccount);
    await destroyMail(ENT.carol, title);
  }
});

test('an invitation in the team mailbox is answered from the banner as the team, with no copy in the member\'s own calendar', async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await jmapAs(ENT.alice);
  const title = `B banner ${TS}`;
  const teamAccount = alice.accountIdByName(ENT.team);
  const invite = await carolInvites(title, [['Ent Team', ENT.team]], 34);
  const teamCopy = await waitForCopy(alice, invite.uid, teamAccount);
  const page = await userPage(browser, ENT.alice);
  try {
    await expandSharedFolders(page, ENT.team);
    await folderRow(page, { role: 'inbox', shared: true }).first().click();
    const row = page.locator('[data-testid="email-list-item"]', { hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click();
    await page.getByRole('button', { name: 'Accept', exact: true }).first().click();
    let raw = '';
    await expect.poll(async () => {
      for (const m of await carolMail(title)) {
        const text = (await rawMessage(ENT.carol, m.blobId)).replace(/\r?\n[ \t]/g, '');
        if (/METHOD:REPLY/.test(text)) { raw = text; return true; }
      }
      return false;
    }, { timeout: 60_000 }).toBe(true);
    const attendee = raw.split(/\r?\n/).find((l) => l.startsWith('ATTENDEE') && /ent-team@example\.org/i.test(l)) ?? '';
    expect(attendee).toMatch(/PARTSTAT=ACCEPTED/);
    expect(attendee).not.toMatch(/SENT-BY/i);
    expect(raw).toMatch(/^From:.*ent-team@example\.org/im);
    // No duplicate in alice's own calendar (#634).
    expect(await findByUid(alice, invite.uid)).toBeNull();
  } finally {
    await closePage(page);
    await destroyEvents(invite.carol, [invite.id]);
    await destroyEvents(alice, [teamCopy], teamAccount);
    const stray = await findByUid(alice, invite.uid).catch(() => null);
    await destroyEvents(alice, [stray]);
    await destroyMail(ENT.carol, title);
  }
});

test('the answer bars fit a phone', async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await jmapAs(ENT.alice);
  const bob = await jmapAs(ENT.bob);
  const title = `B phone ${TS}`;
  const invite = await carolInvites(title, [['Ent Alice', ENT.alice]], 32);
  const aliceCopy = await waitForCopy(alice, invite.uid);
  await share(alice, bob.accountId, READ_WRITE);
  const page = await userPage(browser, ENT.bob, true);
  try {
    await openEventInAgenda(page, title);
    await expect(page.getByTestId('answer-for-owner')).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    const box = await page.getByTestId('answer-for-owner').boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(390);
    await shot(page, 'b-answer-for-phone');
  } finally {
    await closePage(page);
    await share(alice, bob.accountId, null).catch(() => {});
    await destroyEvents(invite.carol, [invite.id]);
    await destroyEvents(alice, [aliceCopy]);
    await destroyMail(ENT.carol, title);
  }
});

// ── 8. Out-of-office blocks the calendar ─────────────────────────────

async function oooEvent(alice: J) {
  const id = await findByUid(alice, `bulwark-ooo-${alice.accountId}`);
  return id ? getEvent(alice, id) : null;
}

const datetimeLocal = (d: Date) => local(d).slice(0, 16);

test('the out-of-office busy event appears, moves with the dates and goes away when switched off', async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await jmapAs(ENT.alice);
  const resetReply = () => call(alice, [['VacationResponse/set', { accountId: alice.accountId, update: { singleton: { isEnabled: false, fromDate: null, toDate: null } } }, '0']], [CORE, VAC]);
  await resetReply();
  const leftover = await findByUid(alice, `bulwark-ooo-${alice.accountId}`);
  await destroyEvents(alice, [leftover]);
  const from = new Date(); from.setDate(from.getDate() + 10); from.setHours(9, 0, 0, 0);
  const to = new Date(); to.setDate(to.getDate() + 12); to.setHours(17, 0, 0, 0);
  const later = new Date(to); later.setDate(later.getDate() + 2);
  const page = await userPage(browser, ENT.alice);
  try {
    await page.goto('/settings/vacation');
    const dates = page.locator('input[type="datetime-local"]');
    await dates.nth(0).fill(datetimeLocal(from));
    await dates.nth(1).fill(datetimeLocal(to));
    const block = page.getByTestId('vacation-block-calendar');
    await expect(block).toBeChecked();
    await page.locator('[data-settings-section="reply"]').getByRole('switch').first().click();

    await expect.poll(async () => (await oooEvent(alice))?.start ?? null, { timeout: 45_000 }).toBe(local(from));
    const event = (await oooEvent(alice))!;
    expect(event.freeBusyStatus).toBe('busy');
    expect(event.participants ?? null).toBeNull();
    await shot(page, 'b-ooo-settings');

    // New end date: the event moves along.
    await dates.nth(1).fill(datetimeLocal(later));
    await expect.poll(async () => (await oooEvent(alice))?.duration ?? null, { timeout: 45_000 }).toBe('P4DT8H');

    // Reply off before it started: the event goes away.
    await page.locator('[data-settings-section="reply"]').getByRole('switch').first().click();
    await expect.poll(async () => await oooEvent(alice), { timeout: 45_000 }).toBeNull();
  } finally {
    await closePage(page);
    await resetReply().catch(() => {});
    const left = await findByUid(alice, `bulwark-ooo-${alice.accountId}`).catch(() => null);
    await destroyEvents(alice, [left]);
  }
});

test('the out-of-office checkbox fits a phone', async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await jmapAs(ENT.alice);
  const from = new Date(); from.setDate(from.getDate() + 20); from.setHours(9, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 1);
  await call(alice, [['VacationResponse/set', { accountId: alice.accountId, update: { singleton: {
    isEnabled: false, fromDate: from.toISOString().replace(/\.\d+Z$/, 'Z'), toDate: to.toISOString().replace(/\.\d+Z$/, 'Z'),
  } } }, '0']], [CORE, VAC]);
  const page = await userPage(browser, ENT.alice, true);
  try {
    await page.goto('/settings/vacation');
    // Phone width opens the settings list first.
    const tab = page.getByRole('button', { name: /Vacation|Out of office/i }).first();
    if (await tab.isVisible().catch(() => false)) await tab.click();
    const block = page.getByTestId('vacation-block-calendar');
    await expect(block).toBeVisible({ timeout: 30_000 });
    await block.scrollIntoViewIfNeeded();
    await noHorizontalScroll(page);
    await shot(page, 'b-ooo-phone');
  } finally {
    await closePage(page);
    await call(alice, [['VacationResponse/set', { accountId: alice.accountId, update: { singleton: { isEnabled: false, fromDate: null, toDate: null } } }, '0']], [CORE, VAC]).catch(() => {});
  }
});

test('an organisation lock that never blocks the calendar shows locked and creates no event', async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await jmapAs(ENT.alice);
  const admin = await adminContext(browser);
  const from = new Date(); from.setDate(from.getDate() + 15); from.setHours(9, 0, 0, 0);
  const to = new Date(from); to.setDate(to.getDate() + 2);
  const resetReply = () => call(alice, [['VacationResponse/set', { accountId: alice.accountId, update: { singleton: { isEnabled: false, fromDate: null, toDate: null } } }, '0']], [CORE, VAC]);
  await destroyEvents(alice, [await findByUid(alice, `bulwark-ooo-${alice.accountId}`)]);
  await call(alice, [['VacationResponse/set', { accountId: alice.accountId, update: { singleton: {
    isEnabled: false, fromDate: from.toISOString().replace(/\.\d+Z$/, 'Z'), toDate: to.toISOString().replace(/\.\d+Z$/, 'Z'),
  } } }, '0']], [CORE, VAC]);
  try {
    await withPolicy(admin, { restrictions: { vacationBlockCalendar: { locked: true, value: false } } }, async () => {
      const page = await userPage(browser, ENT.alice);
      try {
        await page.goto('/settings/vacation');
        const block = page.getByTestId('vacation-block-calendar');
        await expect(block).toBeVisible({ timeout: 30_000 });
        await expect(block).not.toBeChecked();
        await expect(page.getByText('Set by your organisation').first()).toBeVisible();
        await page.locator('[data-settings-section="reply"]').getByRole('switch').first().click();
        await expect.poll(async () => (await call(alice, [['VacationResponse/get', { accountId: alice.accountId, ids: ['singleton'] }, '0']], [CORE, VAC]))[0][1].list[0].isEnabled, { timeout: 30_000 }).toBe(true);
        // Well past the sync's pause: still no busy event.
        await page.waitForTimeout(6000);
        expect(await findByUid(alice, `bulwark-ooo-${alice.accountId}`)).toBeNull();
        await shot(page, 'b-ooo-locked');
      } finally {
        await closePage(page);
      }
    });
  } finally {
    await admin.close();
    await resetReply().catch(() => {});
    await destroyEvents(alice, [await findByUid(alice, `bulwark-ooo-${alice.accountId}`).catch(() => null)]);
  }
});

// ── 9. Company calendars ─────────────────────────────────────────────
// The feed is served from this PC's intranet address, the case of a feed on
// the company intranet.

function icsServer(title: string): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0;
  const day = nextWorkingDay();
  const ymd = `${day.getFullYear()}${pad(day.getMonth() + 1)}${pad(day.getDate())}`;
  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bulwark spec//EN',
    'BEGIN:VEVENT', `UID:b-company-${TS}@example.org`, `DTSTAMP:${ymd}T000000Z`, `DTSTART;VALUE=DATE:${ymd}`, `SUMMARY:${title}`, 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/calendar' });
    res.end(body);
  });
  // An intranet address of this PC: the server reaches admin feeds on the
  // intranet, never on loopback.
  const lan = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal && /^(10.|192.168.|172.(1[6-9]|2d|3[01]).)/.test(i.address))?.address;
  if (!lan) throw new Error('no intranet IPv4 address on this PC for the feed server');
  return new Promise((resolve) => server.listen(0, lan, () => {
    const { port } = server.address() as AddressInfo;
    resolve({ server, url: `http://${lan}:${port}/team.ics`, hits: () => hits });
  }));
}

test('a company calendar scoped to a group shows for its members only, and its address stays on the server', async ({ browser }) => {
  test.setTimeout(240_000);
  const title = `B company ${TS}`;
  const feed = await icsServer(title);
  const admin = await adminContext(browser);
  const scopes = [{
    id: 'b-team', label: 'B team', match: { groups: [ENT.team] },
    policy: { organisation: { calendars: { feeds: [{ id: 'b-team-feed', name: 'B Team calendar', url: feed.url, color: '#16a34a', refreshMinutes: 60 }] } } },
  }];
  try {
    await withPolicy(admin, { scopes }, async () => {
      const alicePage = await userPage(browser, ENT.alice);
      try {
        await openCalendar(alicePage);
        await expect(alicePage.getByTestId('company-calendars-section')).toBeVisible({ timeout: 30_000 });
        await expect(calendarItem(alicePage, 'B Team calendar')).toBeVisible();
        await showAgenda(alicePage);
        await expect(alicePage.getByText(title).first()).toBeVisible({ timeout: 45_000 });
        expect(feed.hits()).toBeGreaterThan(0);
        // The policy alice's browser gets has no address.
        const policy = await (await alicePage.context().request.get('/api/admin/policy')).text();
        expect(policy).not.toContain(feed.url);
        expect(policy).toContain('B Team calendar');
        await shot(alicePage, 'b-company-calendar');
        // Hiding it takes its events off the grid.
        await calendarItem(alicePage, 'B Team calendar').click();
        await expect(alicePage.getByText(title)).toHaveCount(0);
        await calendarItem(alicePage, 'B Team calendar').click();
      } finally {
        await closePage(alicePage);
      }
      const carolPage = await userPage(browser, ENT.carol);
      try {
        await openCalendar(carolPage);
        await expect(carolPage.locator('[data-testid="calendar-item"]').first()).toBeVisible();
        await expect(calendarItem(carolPage, 'B Team calendar')).toHaveCount(0);
        await expect(carolPage.getByTestId('company-calendars-section')).toHaveCount(0);
        // Not by id either: the server resolves carol's scopes itself.
        const res = await carolPage.context().request.post('/api/fetch-ical', {
          data: { feedId: 'b-team-feed' }, headers: { Origin: new URL(carolPage.url()).origin },
        });
        expect(res.status()).toBe(404);
      } finally {
        await closePage(carolPage);
      }
    });
  } finally {
    await admin.close();
    feed.server.close();
  }
});

// ── The admin page ───────────────────────────────────────────────────

async function adminPage(browser: Browser, phone: boolean): Promise<Page> {
  const context = await adminContext(browser, phone);
  const page = await context.newPage();
  await page.goto('/admin/org-calendars');
  await expect(page.getByText('Company calendars').first()).toBeVisible({ timeout: 30_000 });
  return page;
}

test('Organisation > Calendars saves company calendars, the free/busy group and the out-of-office lock', async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await adminPage(browser, false);
  const saved = await getPolicy(page.context());
  try {
    await page.getByTestId('org-feed-add').click();
    await page.getByTestId('org-feed-name').last().fill('B Holidays');
    await page.getByTestId('org-feed-url').last().fill('webcal://calendar.example.org/holidays.ics');
    await page.getByLabel('Share free/busy with (group address)').fill(ENT.team);
    await page.getByLabel('Out-of-office blocks the calendar').selectOption('never');
    await page.getByRole('button', { name: 'Save' }).last().click();
    await expect.poll(async () => {
      const policy = await getPolicy(page.context()) as {
        organisation?: { calendars?: { feeds?: Array<{ name: string; url: string }>; freeBusyGroup?: string } };
        restrictions?: Record<string, unknown>;
      };
      return {
        feed: policy.organisation?.calendars?.feeds?.find((f) => f.name === 'B Holidays')?.url,
        group: policy.organisation?.calendars?.freeBusyGroup,
        lock: policy.restrictions?.vacationBlockCalendar,
      };
    }, { timeout: 20_000 }).toEqual({
      feed: 'https://calendar.example.org/holidays.ics',
      group: ENT.team,
      lock: { locked: true, value: false },
    });
    await shot(page, 'b-admin-calendars');
  } finally {
    await putPolicy(page.context(), saved);
    await page.context().close();
  }
});

test('Organisation > Calendars fits a phone', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await adminPage(browser, true);
  try {
    await noHorizontalScroll(page);
    await shot(page, 'b-admin-calendars-phone');
  } finally {
    await page.context().close();
  }
});
