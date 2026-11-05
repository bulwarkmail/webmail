import { test, expect, type Page } from '@playwright/test';
import { addDays, format } from 'date-fns';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability fixes pim-1, pim-8, pim-12 and pim-24 (cal), against a VM 106
 * Stalwart (1.0 and 0.16). Every UI step is checked on the server.
 *
 * Both Stalwarts keep tasks as CalendarEvent objects of @type "Task" in an
 * ordinary calendar, with no tasks capability of their own; the seeded
 * "To-do" list holds only tasks.
 *
 * Accounts: dso-ux-pim and dso-ux-pim-b (password IT_DSO_PASSWORD), and
 * ent-alice (IT_ENT_PASSWORD) as an outside organiser. The spec makes its
 * own items, titled "UXFIX-cal …", and removes them again.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const ENT_PASSWORD = process.env.IT_ENT_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const B = 'dso-ux-pim-b@example.org';
const ALICE = 'ent-alice@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const CAL = 'urn:ietf:params:jmap:calendars';
const RUN = Date.now().toString(36);
const TZ = 'Europe/Berlin';

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Obj = Record<string, unknown> & { id: string; title?: string; calendarIds?: Record<string, boolean>; progress?: string };

async function calendars(c: JmapClient): Promise<Array<{ id: string; name: string; isDefault?: boolean }>> {
  const r = await c.request([['Calendar/get', { accountId: c.accountId, properties: ['id', 'name', 'isDefault'] }, '0']], [CORE, CAL]);
  return r.methodResponses[0][1].list;
}

/** Calendar objects whose title starts with `prefix`, with the properties the checks need. */
async function objects(c: JmapClient, prefix: string): Promise<Obj[]> {
  const r = await c.request([
    ['CalendarEvent/query', { accountId: c.accountId, limit: 1000 }, 'q'],
    ['CalendarEvent/get', {
      accountId: c.accountId,
      '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
      properties: ['id', '@type', 'title', 'calendarIds', 'progress', 'due', 'start', 'participants', 'uid'],
    }, 'g'],
  ], [CORE, CAL]);
  return (r.methodResponses[1][1].list as Obj[]).filter((o) => typeof o.title === 'string' && o.title.startsWith(prefix));
}

async function destroyAll(c: JmapClient, prefix: string): Promise<void> {
  const ids = (await objects(c, prefix)).map((o) => o.id);
  if (ids.length) await c.request([['CalendarEvent/set', { accountId: c.accountId, destroy: ids }, '0']], [CORE, CAL]);
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60000 });
  await page.fill('#username', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
}

async function login(page: Page, email: string): Promise<void> {
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await signIn(page, email);
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
}

async function activeEmail(page: Page): Promise<string | null> {
  const id = await accountSwitcher(page).getAttribute('data-active-account-id');
  if (!id) return null;
  await accountSwitcher(page).click();
  const email = await page.locator(`[data-testid="account-option"][data-account-id="${id}"]`).first().getAttribute('data-account-email');
  await page.keyboard.press('Escape');
  return email;
}

test.describe('Tasks (pim-1, pim-8, pim-24)', () => {
  test.describe.configure({ mode: 'serial' });
  const prefix = `UXFIX-cal ${RUN}`;

  test.afterAll(async () => {
    const a = await JmapClient.connect(A, PASSWORD);
    await destroyAll(a, prefix);
  });

  test('tasks show without switching them on, and every move keeps the task on screen and on the server', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const cals = await calendars(a);
    const todo = cals.find((c) => c.name === 'To-do');
    const home = cals.find((c) => c.isDefault);
    expect(todo, 'seeded To-do list').toBeTruthy();
    expect(home).toBeTruthy();

    // A task in the event calendar, to move into To-do and back.
    const made = await a.request([['CalendarEvent/set', {
      accountId: a.accountId,
      create: { t: { '@type': 'Task', title: `${prefix} move`, calendarIds: { [home!.id]: true }, uid: `uxfix-cal-${RUN}`, progress: 'needs-action' } },
    }, '0']], [CORE, CAL]);
    expect(made.methodResponses[0][1].created?.t?.id).toBeTruthy();

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ });
    const page = await context.newPage();
    await login(page, A);

    // pim-8: Tasks is in the sidebar without visiting Settings.
    await page.goto('/calendar');
    const tasksEntry = page.getByRole('button', { name: /^Tasks/ }).first();
    await expect(tasksEntry).toBeVisible({ timeout: 60000 });
    await tasksEntry.click();
    await expect(page).toHaveURL(/\/calendar\/tasks/);

    // pim-1: the seeded tasks of the task-only list show, under All and Pending.
    await expect(page.getByText('Renew passport').first()).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Pending', exact: true }).click();
    await expect(page.getByText('Renew passport').first()).toBeVisible();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    const lists = page.getByTestId('task-lists-section');
    await expect(lists.getByRole('checkbox', { name: /To-do/ })).toHaveAttribute('aria-checked', 'true');

    // pim-24 and pim-8: a quick task with "tomorrow" goes to To-do, due tomorrow.
    const quick = page.getByLabel('Add a task…');
    await quick.fill(`${prefix} quick tomorrow`);
    await expect(page.getByTestId('quick-task-due')).toBeVisible();
    await quick.press('Enter');
    await expect(page.getByText(`${prefix} quick`, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect.poll(async () => {
      const [t] = await objects(a, `${prefix} quick`);
      return t ? { title: t.title, lists: Object.keys(t.calendarIds ?? {}), due: String(t.due).slice(0, 10), progress: t.progress } : null;
    }, { timeout: 30000 }).toEqual({
      title: `${prefix} quick`, lists: [todo!.id], due: format(addDays(new Date(), 1), 'yyyy-MM-dd'), progress: 'needs-action',
    });

    // Move into To-do: the task stays listed and the server has it there.
    const moveRow = page.getByText(`${prefix} move`, { exact: true });
    await expect(moveRow).toBeVisible({ timeout: 30000 });
    const moveTo = async (calendarName: string, calendarId: string) => {
      await moveRow.click();
      const form = page.getByRole('dialog', { name: 'Edit task' });
      // pim-19: plain status words.
      await expect(form.getByLabel('Status').locator('option:checked')).toHaveText('Not started');
      // The field is "List" since 109866dd4 (tasks live in task lists).
      await form.getByLabel('List', { exact: true }).selectOption({ label: calendarName });
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden({ timeout: 30000 });
      await expect(moveRow).toBeVisible();
      await expect.poll(async () => {
        const [t] = await objects(a, `${prefix} move`);
        return t ? Object.keys(t.calendarIds ?? {}) : null;
      }, { timeout: 30000 }).toEqual([calendarId]);
    };
    await moveTo('To-do', todo!.id);
    await moveTo(home!.name, home!.id);
    await moveTo('To-do', todo!.id);

    // Complete it from the list.
    const row = page.locator('div.cursor-pointer', { has: page.getByText(`${prefix} move`, { exact: true }) });
    await row.getByRole('button', { name: 'Mark as complete' }).click();
    await expect.poll(async () => (await objects(a, `${prefix} move`))[0]?.progress, { timeout: 30000 }).toBe('completed');
    await expect(moveRow).toBeVisible();

    // Unticking the list hides its tasks; ticking it shows them again.
    await lists.getByRole('checkbox', { name: /To-do/ }).click();
    await expect(page.getByText('Renew passport')).toHaveCount(0);
    await lists.getByRole('checkbox', { name: /To-do/ }).click();
    await expect(page.getByText('Renew passport').first()).toBeVisible();
    await context.close();
  });
});

test.describe('Two signed-in logins in one calendar (pim-12)', () => {
  test.describe.configure({ mode: 'serial' });
  const prefix = `UXFIX-cal ${RUN} B`;

  test.afterAll(async () => {
    const b = await JmapClient.connect(B, PASSWORD);
    await destroyAll(b, prefix);
    if (ENT_PASSWORD) {
      const alice = await JmapClient.connect(ALICE, ENT_PASSWORD);
      await destroyAll(alice, prefix);
    }
  });

  test('shows both logins\' calendars and changes the other login\'s events in its own account', async ({ browser }) => {
    test.setTimeout(300_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const b = await JmapClient.connect(B, PASSWORD);
    const bCals = await calendars(b);
    const bHome = bCals.find((c) => c.isDefault)!;
    const aCals = await calendars(a);

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ });
    const page = await context.newPage();
    await login(page, A);
    await accountSwitcher(page).click();
    await page.locator('[data-testid="add-account"]').click();
    await signIn(page, B);
    await expect.poll(() => activeEmail(page), { timeout: 60000 }).toBe(B);
    // Back to A: B is the other login now.
    await accountSwitcher(page).click();
    await page.locator(`[data-testid="account-option"][data-account-email="${A}"]`).first().click();
    await expect.poll(() => activeEmail(page), { timeout: 60000 }).toBe(A);

    await page.goto(`/calendar/month/${format(new Date(), 'yyyy-MM-dd')}`);
    // Both logins' calendars, each ticked.
    await expect(page.locator(`[data-testid="calendar-item"][data-calendar-name="${bHome.name}"]`).first()).toBeVisible({ timeout: 60000 });
    for (const name of [aCals.find((c) => c.name === 'Work')!.name, bHome.name]) {
      await expect(page.locator(`[data-testid="calendar-item"][data-calendar-name="${name}"]`).first()).toHaveAttribute('aria-checked', 'true');
    }

    // Each has its own checkbox: hiding A's calendars leaves B's in the grid,
    // so B's events don't fold under "+n more".
    const aItems = page.locator(`[data-testid="calendar-item"][data-account="${A}"]`);
    const aCount = await aItems.count();
    expect(aCount).toBeGreaterThan(0);
    for (let i = 0; i < aCount; i++) await aItems.nth(i).click();
    for (let i = 0; i < aCount; i++) await expect(aItems.nth(i)).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator(`[data-testid="calendar-item"][data-calendar-name="${bHome.name}"]`).first()).toHaveAttribute('aria-checked', 'true');

    // Create in B's calendar from A's session.
    await page.locator(`[data-testid="calendar-item"][data-calendar-name="${bHome.name}"]`).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New event in this calendar' }).click();
    const title = page.getByLabel('Title', { exact: true });
    await title.fill(`${prefix} made`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await objects(b, `${prefix} made`)).map((o) => Object.keys(o.calendarIds ?? {})), { timeout: 30000 })
      .toEqual([[bHome.id]]);
    expect(await objects(a, prefix)).toEqual([]);

    // Edit it.
    // Event chips are buttons named "<title>, <time>, <calendar>".
    const card = (t: string) => page.locator(`button[aria-label^="${t},"]`).first();
    await card(`${prefix} made`).click();
    await page.getByRole('button', { name: 'Edit event' }).click();
    const editTitle = page.getByLabel('Title', { exact: true });
    await expect(editTitle).toHaveValue(`${prefix} made`);
    // The editor fills its fields once it has the event: typing before that is lost.
    await page.waitForTimeout(2000);
    await editTitle.fill(`${prefix} edited`);
    await expect(editTitle).toHaveValue(`${prefix} edited`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await objects(b, prefix)).map((o) => o.title), { timeout: 30000 }).toEqual([`${prefix} edited`]);

    // Move it two days on by dragging it in the month grid.
    const before = (await objects(b, `${prefix} edited`))[0];
    const target = format(addDays(new Date(String(before.start)), 2), 'yyyy-MM-dd');
    await card(`${prefix} edited`).dragTo(page.locator(`[data-day-button="${target}"]`).first());
    await expect.poll(async () => String((await objects(b, `${prefix} edited`))[0]?.start).slice(0, 10), { timeout: 30000 }).toBe(target);
    expect(await objects(a, prefix)).toEqual([]);

    // Delete it, from a fresh load: a moved occurrence can come back under a new id.
    await page.reload();
    await expect(card(`${prefix} edited`)).toBeVisible({ timeout: 60000 });
    await card(`${prefix} edited`).click();
    await page.getByRole('button', { name: 'Delete event' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /Delete/ }).click();
    await expect.poll(async () => (await objects(b, prefix)).length, { timeout: 30000 }).toBe(0);

    // Answer an invitation B got from someone else.
    test.skip(!ENT_PASSWORD, 'IT_ENT_PASSWORD for the outside organiser');
    const alice = await JmapClient.connect(ALICE, ENT_PASSWORD);
    const aliceHome = (await calendars(alice)).find((c) => c.isDefault)!;
    const start = `${format(addDays(new Date(), 1), 'yyyy-MM-dd')}T15:00:00`;
    const invite = await alice.request([['CalendarEvent/set', {
      accountId: alice.accountId,
      sendSchedulingMessages: true,
      create: {
        i: {
          '@type': 'Event', title: `${prefix} invite`, uid: `uxfix-cal-inv-${RUN}`, start, duration: 'PT1H', timeZone: TZ,
          calendarIds: { [aliceHome.id]: true },
          participants: {
            o: { '@type': 'Participant', calendarAddress: `mailto:${ALICE}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
            p: { '@type': 'Participant', calendarAddress: `mailto:${B}`, roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true },
          },
        },
      },
    }, '0']], [CORE, CAL]);
    expect(invite.methodResponses[0][1].created?.i?.id, JSON.stringify(invite.methodResponses[0][1].notCreated ?? {})).toBeTruthy();
    await expect.poll(async () => (await objects(b, `${prefix} invite`)).length, { timeout: 90000 }).toBe(1);

    // The day view lists every event of the day (the month may fold it under "+n more").
    await page.goto(`/calendar/day/${start.slice(0, 10)}`);
    await expect(card(`${prefix} invite`)).toBeVisible({ timeout: 60000 });
    await card(`${prefix} invite`).click();
    await page.getByRole('button', { name: 'Accept', exact: true }).first().click();
    await expect.poll(async () => {
      const [ev] = await objects(b, `${prefix} invite`);
      const parts = Object.values((ev?.participants ?? {}) as Record<string, { calendarAddress?: string; participationStatus?: string }>);
      return parts.find((p) => p.calendarAddress?.toLowerCase() === `mailto:${B}`)?.participationStatus;
    }, { timeout: 30000 }).toBe('accepted');
    // Nothing of it in A's account.
    expect(await objects(a, prefix)).toEqual([]);
    await context.close();
  });
});
