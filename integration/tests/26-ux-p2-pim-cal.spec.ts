import { test, expect, type Locator, type Page } from '@playwright/test';
import { format } from 'date-fns';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability pass 2, calendar with two accounts: pim-p2-2 (no task list for
 * events), p2-3 (accounts named by address, choosers grouped), p2-4 (new
 * events in the account on screen), p2-13 (task editor's "List") and p2-16
 * (Copy to the other account). Against a VM 106 Stalwart, 1.0 and 0.16;
 * every UI step is checked on the server.
 *
 * Accounts: dso-ux-pim (A, has the seeded task-only "To-do") and
 * dso-ux-pim-b (B), password IT_DSO_PASSWORD. Items are titled
 * "UXP2-cal <run> …" and removed again.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const B = 'dso-ux-pim-b@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const CAL = 'urn:ietf:params:jmap:calendars';
const RUN = Date.now().toString(36);
const TZ = 'Europe/Berlin';
const prefix = `UXP2-cal ${RUN}`;

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Obj = Record<string, unknown> & { id: string; title?: string; calendarIds?: Record<string, boolean>; start?: string };

async function calendars(c: JmapClient): Promise<Array<{ id: string; name: string; isDefault?: boolean }>> {
  const r = await c.request([['Calendar/get', { accountId: c.accountId, properties: ['id', 'name', 'isDefault'] }, '0']], [CORE, CAL]);
  return r.methodResponses[0][1].list;
}

async function objects(c: JmapClient, startsWith: string): Promise<Obj[]> {
  const r = await c.request([
    ['CalendarEvent/query', { accountId: c.accountId, limit: 1000 }, 'q'],
    ['CalendarEvent/get', {
      accountId: c.accountId,
      '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
      properties: ['id', '@type', 'title', 'calendarIds', 'start', 'participants'],
    }, 'g'],
  ], [CORE, CAL]);
  return (r.methodResponses[1][1].list as Obj[]).filter((o) => typeof o.title === 'string' && o.title.startsWith(startsWith));
}

async function destroyAll(c: JmapClient, startsWith: string): Promise<void> {
  const ids = (await objects(c, startsWith)).map((o) => o.id);
  if (ids.length) await c.request([['CalendarEvent/set', { accountId: c.accountId, destroy: ids }, '0']], [CORE, CAL]);
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60000 });
  await page.fill('#username', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
}

async function activeEmail(page: Page): Promise<string | null> {
  const id = await accountSwitcher(page).getAttribute('data-active-account-id');
  if (!id) return null;
  await accountSwitcher(page).click();
  const email = await page.locator(`[data-testid="account-option"][data-account-id="${id}"]`).first().getAttribute('data-account-email');
  await page.keyboard.press('Escape');
  return email;
}

/** The label of the optgroup the selected option sits in, and every option's text by group. */
async function selectState(select: Locator): Promise<{ checkedGroup: string | null; groups: Record<string, string[]> }> {
  return select.evaluate((el) => {
    const select = el as HTMLSelectElement;
    const groups: Record<string, string[]> = {};
    for (const g of Array.from(select.querySelectorAll('optgroup'))) {
      groups[g.label] = Array.from(g.querySelectorAll('option')).map((o) => o.textContent ?? '');
    }
    const checked = select.selectedOptions[0];
    return { checkedGroup: checked?.parentElement instanceof HTMLOptGroupElement ? checked.parentElement.label : null, groups };
  });
}

test.describe('Two accounts in Calendar (pim-p2-2, p2-3, p2-4, p2-13, p2-16)', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    for (const email of [A, B]) {
      const c = await JmapClient.connect(email, PASSWORD);
      await destroyAll(c, prefix);
    }
  });

  test('names accounts by address, starts new events in the account on screen, and copies an event across', async ({ browser }) => {
    test.setTimeout(300_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const b = await JmapClient.connect(B, PASSWORD);
    const aHome = (await calendars(a)).find((c) => c.isDefault)!;
    const bHome = (await calendars(b)).find((c) => c.isDefault)!;
    expect((await calendars(a)).some((c) => c.name === 'To-do'), 'seeded To-do list on A').toBe(true);

    const context = await browser.newContext({ ...contextOptions(), timezoneId: TZ });
    const page = await context.newPage();
    await neutralizeDevOverlay(page);
    await page.goto('/');
    await signIn(page, A);
    await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
    await accountSwitcher(page).click();
    await page.locator('[data-testid="add-account"]').click();
    await signIn(page, B);
    // B is the account on screen from here on.
    await expect.poll(() => activeEmail(page), { timeout: 60000 }).toBe(B);

    const today = format(new Date(), 'yyyy-MM-dd');
    await page.goto(`/calendar/week/${today}`);

    // p2-3: each group is headed by its address, the account on screen first.
    await expect(page.getByTestId('calendar-account-group').first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('calendar-account-group')).toHaveText([B, A]);

    // p2-2, p2-4: the editor starts in B's calendar, groups by address, and offers no task list.
    await page.getByRole('button', { name: 'Create event' }).first().click();
    const editorSelect = page.locator('select[id$="calendar_select"]').first();
    await expect(editorSelect).toBeVisible({ timeout: 30000 });
    const editor = await selectState(editorSelect);
    expect(editor.checkedGroup).toBe(B);
    expect(Object.keys(editor.groups)).toEqual([B, A]);
    expect(Object.values(editor.groups).flat().some((name) => name.startsWith('To-do'))).toBe(false);
    await page.getByLabel('Title', { exact: true }).fill(`${prefix} new`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await objects(b, `${prefix} new`)).map((o) => Object.keys(o.calendarIds ?? {})), { timeout: 30000 })
      .toEqual([[bHome.id]]);
    expect(await objects(a, prefix)).toEqual([]);
    const made = (await objects(b, `${prefix} new`))[0];

    // p2-16: Copy to A, then delete the original from the toast.
    const card = page.locator(`button[aria-label^="${prefix} new,"]`).first();
    await expect(card).toBeVisible({ timeout: 30000 });
    await card.click({ button: 'right' });
    await page.getByRole('menuitem', { name: `Copy to ${A}` }).click();
    await expect.poll(async () => (await objects(a, `${prefix} new`)).map((o) => [Object.keys(o.calendarIds ?? {}), o.start]), { timeout: 30000 })
      .toEqual([[[aHome.id], made.start]]);
    await page.getByRole('button', { name: 'Delete original' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /Delete/ }).click();
    await expect.poll(async () => (await objects(b, `${prefix} new`)).length, { timeout: 30000 }).toBe(0);
    expect((await objects(a, `${prefix} new`)).length).toBe(1);

    // p2-13: the task editor's "List" holds task lists only, grouped by address.
    await page.goto('/calendar/tasks');
    await page.getByRole('button', { name: 'New task' }).first().click();
    const list = page.getByLabel('List', { exact: true });
    await expect(list).toBeVisible({ timeout: 30000 });
    const tasks = await selectState(list);
    expect(tasks.groups[A]).toContain('To-do');
    expect(Object.values(tasks.groups).flat()).not.toContain('Work');
    await page.keyboard.press('Escape');

    // p2-3: Settings lists each account's calendars under its address.
    await page.goto('/settings/calendar');
    await expect(page.getByTestId('calendar-settings-account')).toHaveText([B, A], { timeout: 60000 });
    await context.close();
  });
});
