import { test, expect, type Page } from '@playwright/test';
import { ACCOUNTS, GROUP } from './helpers/config';
import { login, openCalendar, seedSettings } from './helpers/app';
import { JmapClient } from './helpers/jmap';

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:calendars'];
async function exerciseCalendarMove({ page }: { page: Page }) {
  const uid = crypto.randomUUID();
  const title = `Calendar move ${uid.slice(0, 8)}`;
  const account = ACCOUNTS.carol;
  const api = await JmapClient.connect(account.email, account.password);
  const teamAccountId = api.accountIdByName(GROUP.team.email);
  const calendar = async (accountId: string): Promise<{ id: string; name: string }> => {
    const response = await api.request([['Calendar/get', { accountId, properties: ['id', 'name', 'isDefault'] }, '0']], USING);
    return response.methodResponses[0][1].list.find((c: { isDefault: boolean }) => c.isDefault);
  };
  const personal = await calendar(api.accountId);
  const team = await calendar(teamAccountId);
  expect(personal.id).toBe(team.id);

  const event = {
    '@type': 'Event', uid, title,
    start: '2026-04-15T10:00:00', timeZone: 'Etc/UTC', duration: 'PT1H',
    calendarIds: { [personal.id]: true }, description: 'Synthetic calendar move fixture',
    organizerCalendarAddress: `mailto:${GROUP.team.email}`,
    participants: {
      owner: { '@type': 'Participant', calendarAddress: `mailto:${GROUP.team.email}`, roles: { owner: true }, participationStatus: 'accepted' },
      guest: { '@type': 'Participant', calendarAddress: `mailto:${ACCOUNTS.alice.email}`, roles: { attendee: true }, participationStatus: 'accepted' },
    },
  };
  const created = await api.request([['CalendarEvent/set', { accountId: api.accountId, create: { fixture: event }, sendSchedulingMessages: false }, '0']], USING);
  const sourceId = created.methodResponses[0][1].created?.fixture?.id;
  expect(sourceId).toBeTruthy();
  const events = async (accountId: string) => {
    const response = await api.request([
      ['CalendarEvent/query', { accountId, filter: { uid: event.uid } }, 'query'],
      ['CalendarEvent/get', { accountId, '#ids': { resultOf: 'query', name: 'CalendarEvent/query', path: '/ids' } }, 'get'],
    ], USING);
    expect(response.methodResponses[1][0]).toBe('CalendarEvent/get');
    return response.methodResponses[1][1].list as Array<Record<string, unknown> & { id: string }>;
  };
  const participants = (value: Record<string, unknown>) => Object.values(value.participants as Record<string, { calendarAddress: string }>).map(p => p.calendarAddress).sort();
  const writes: Array<[string, Record<string, unknown>]> = [];
  try {
    await expect.poll(async () => (await events(api.accountId)).length).toBe(1);
    const before = (await events(api.accountId))[0];
    expect(participants(before)).toEqual([`mailto:${GROUP.team.email}`, `mailto:${ACCOUNTS.alice.email}`].sort());
    await page.clock.setFixedTime(new Date('2026-04-15T08:00:00Z'));
    await seedSettings(page, { timeZone: 'Etc/UTC' });
    await login(page, account);
    await openCalendar(page);
    await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().includes('/jmap')) return;
      const body = request.postDataJSON();
      for (const [method, args] of body?.methodCalls ?? []) {
        if (method.endsWith('/set') || method.endsWith('/copy')) writes.push([method, args]);
      }
    });
    const edit = async () => {
      await page.getByText(title, { exact: true }).first().click();
      const selector = page.getByLabel('Calendar', { exact: true });
      await expect(async () => {
        if (!(await selector.isVisible())) await page.getByRole('button', { name: 'Edit event', exact: true }).click();
        await expect(selector).toBeVisible();
      }).toPass();
      return selector;
    };
    const notice = 'Moving preserves the organizer, participants and RSVP responses without sending invitations or cancellations. Save attendee changes separately before moving.';
    const selector = await edit();
    await page.getByRole('button', { name: `Remove ${ACCOUNTS.alice.email}`, exact: true }).click();
    await selector.selectOption({ label: team.name });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(notice, { exact: true })).toHaveCount(2);
    expect(writes.some(([method]) => method === 'CalendarEvent/copy')).toBe(false);
    await page.locator('[role="status"][aria-live="polite"]').getByRole('button').last().click();
    await page.getByRole('dialog', { name: 'Edit event', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).first().click();

    await (await edit()).selectOption({ label: team.name });
    await expect(page.getByRole('dialog', { name: 'Edit event', exact: true }).getByText(notice)).toBeVisible();
    await page.getByRole('dialog', { name: 'Edit event', exact: true }).getByText(notice).scrollIntoViewIfNeeded();
    await page.getByRole('dialog', { name: 'Edit event', exact: true }).screenshot({ path: test.info().outputPath('calendar-move-notice.png') });
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => (await events(api.accountId)).length).toBe(0);
    await expect.poll(async () => (await events(teamAccountId)).length).toBe(1);
    const moved = await events(teamAccountId);
    expect(moved[0]).toMatchObject({ uid: event.uid, title, start: event.start, duration: event.duration, timeZone: before.timeZone, description: event.description, calendarIds: { [team.id]: true }, organizerCalendarAddress: event.organizerCalendarAddress });
    expect(moved[0].participants).toEqual(before.participants);
    expect(writes.some(([method, args]) => method === 'CalendarEvent/copy' && args.fromAccountId === api.accountId && args.accountId === teamAccountId)).toBe(true);
    expect(writes.some(([method, args]) => method === 'CalendarEvent/set' && args.accountId === api.accountId && args.sendSchedulingMessages === false && (args.destroy as string[] | undefined)?.includes(sourceId))).toBe(true);
    expect(writes.some(([method, args]) => method === 'EmailSubmission/set' || args.sendSchedulingMessages === true)).toBe(false);
    await page.screenshot({ path: test.info().outputPath('calendar-move.png') });
  } finally {
    for (const accountId of [api.accountId, teamAccountId]) {
      const fixtures = await events(accountId);
      if (fixtures.length) await api.request([['CalendarEvent/set', { accountId, destroy: fixtures.map(e => e.id), sendSchedulingMessages: false }, 'cleanup']], USING);
    }
  }
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test.describe(`calendar move at ${viewport.width}px`, () => {
    test.use({ viewport });
    test('editing the calendar moves an event across accounts with colliding calendar ids', exerciseCalendarMove);
  });
}
