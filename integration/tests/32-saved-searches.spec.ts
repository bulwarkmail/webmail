import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Response } from '@playwright/test';
import { accountSwitcher, addAccount, neutralizeDevOverlay, switchAccount } from './helpers/app';
import { ACCOUNTS, type TestAccount } from './helpers/config';
import { sendMail } from './helpers/smtp';

// Local/CI fixture: IT_SETTINGS_SYNC_ENABLED=true integration/run-tests.sh 32-saved-searches
test.skip(process.env.IT_SETTINGS_SYNC_ENABLED !== 'true', 'Requires the integration stack with settings sync enabled');
test.use({ locale: 'en-US', viewport: { width: 1366, height: 900 } });

const settingsResponse = (method: 'GET' | 'POST', username: string) => (response: Response) => {
  const request = response.request();
  return new URL(response.url()).pathname === '/api/settings' && request.method() === method
    && (method === 'GET' ? request.headers()['x-settings-username'] : request.postDataJSON()?.username) === username;
};

async function sync(page: Page, method: 'GET' | 'POST', username: string, action: () => Promise<unknown>) {
  const [response] = await Promise.all([
    page.waitForResponse(settingsResponse(method, username)),
    action(),
  ]);
  expect(response.ok()).toBe(true);
  return response;
}

const searches = (page: Page) => page.getByRole('region', { name: 'Saved searches' });
const filters = (page: Page) => page.getByRole('button', { name: 'Filters', exact: true });
const searchField = (page: Page) => page.getByPlaceholder('Search mail...', { exact: true });

async function signIn(page: Page, account: TestAccount) {
  await neutralizeDevOverlay(page);
  await page.routeWebSocket('**/_next/webpack-hmr*', ws => ws.close());
  await page.goto('/login');
  await page.locator('#username').fill(account.email);
  await page.locator('#password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(accountSwitcher(page)).toBeVisible({ timeout: 120_000 });
}

async function nameSearch(page: Page, title: string, name: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.getByRole('textbox').fill(name);
  await dialog.getByRole('button', { name: title }).click();
}

test('saved searches replay their criteria and sync create, update, rename and delete per account', async ({ browser, page }) => {
  test.setTimeout(300_000);
  const { alice, bob } = ACCOUNTS;
  const suffix = randomUUID().slice(0, 8);
  const searchName = `Saved invoices ${suffix}`;
  const renamed = `Renamed invoices ${suffix}`;
  const subject = `Invoice ${suffix}`;
  const query = `invoicebody${suffix}`;
  const after = '2020-01-02';
  const before = '2090-02-03';
  const message = { from: bob.email, to: alice.email, authPass: bob.password };
  await sendMail({ ...message, subject, body: query });
  await sendMail({ ...message, subject: `Other ${subject}`, body: 'Does not match the free text' });

  const second = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'en-US' });
  try {
    const other = await second.newPage();
    await sync(page, 'GET', alice.email, () => signIn(page, alice));
    await sync(other, 'GET', alice.email, () => signIn(other, alice));
    await expect(searches(page).getByRole('button', { name: searchName, exact: true })).toHaveCount(0);
    await expect(searches(other).getByRole('button', { name: searchName, exact: true })).toHaveCount(0);

    await searchField(page).fill(query);
    await filters(page).click();
    await page.getByLabel('Subject', { exact: true }).fill(subject);
    await page.getByLabel('Date', { exact: true }).selectOption('custom');
    await page.getByLabel('After', { exact: true }).fill(after);
    await page.getByLabel('Before', { exact: true }).fill(before);
    await page.getByLabel('Search in', { exact: true }).selectOption({ label: 'Inbox' });
    await page.getByRole('button', { name: 'Save search', exact: true }).click();
    const created = await sync(page, 'POST', alice.email, () => nameSearch(page, 'Save search', searchName));
    const entries = Object.values(created.request().postDataJSON().settings.savedSearches) as unknown[][];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContainEqual(expect.objectContaining({
      name: searchName, query, filters: expect.objectContaining({ subject, dateAfter: after, dateBefore: before }),
    }));

    await sync(other, 'GET', alice.email, () => other.reload());
    await searches(other).getByRole('button', { name: searchName, exact: true }).click();
    await expect(searchField(other)).toHaveValue(query);
    await expect(other.getByTestId('email-list-item').filter({ hasText: subject })).toHaveCount(1);
    await expect(other.getByText(`Other ${subject}`, { exact: true })).toHaveCount(0);
    await filters(other).click();
    await expect(other.getByLabel('Subject', { exact: true })).toHaveValue(subject);
    await expect(other.getByLabel('After', { exact: true })).toHaveValue(after);
    await expect(other.getByLabel('Before', { exact: true })).toHaveValue(before);
    await expect(other.getByLabel('Search in', { exact: true }).locator('option:checked')).toHaveText('Inbox');

    await page.getByLabel('Subject', { exact: true }).fill(`Updated ${subject}`);
    await sync(page, 'POST', alice.email, () => page.getByRole('button', { name: 'Update saved search' }).click());
    await page.getByRole('button', { name: `Actions for ${searchName}` }).click();
    await page.getByRole('menuitem', { name: 'Rename saved search' }).click();
    await sync(page, 'POST', alice.email, () => nameSearch(page, 'Rename saved search', renamed));

    await sync(other, 'GET', alice.email, () => other.reload());
    await expect(searches(other).getByRole('button', { name: searchName, exact: true })).toHaveCount(0);
    await searches(other).getByRole('button', { name: renamed, exact: true }).click();
    await filters(other).click();
    await expect(other.getByLabel('Subject', { exact: true })).toHaveValue(`Updated ${subject}`);

    const bobLoad = await sync(page, 'GET', bob.email, () => addAccount(page, bob));
    expect(JSON.stringify(await bobLoad.json())).not.toContain(renamed);
    await expect(searches(page).getByRole('button', { name: renamed, exact: true })).toHaveCount(0);
    await sync(page, 'GET', alice.email, () => switchAccount(page, alice.email));
    await expect(searches(page).getByRole('button', { name: renamed, exact: true })).toBeVisible();

    await page.getByRole('button', { name: `Actions for ${renamed}` }).click();
    await page.getByRole('menuitem', { name: 'Delete saved search' }).click();
    const deleted = await sync(page, 'POST', alice.email, () =>
      page.getByRole('alertdialog', { name: 'Delete saved search' }).getByRole('button', { name: 'Delete saved search' }).click(),
    );
    expect(JSON.stringify(deleted.request().postDataJSON().settings.savedSearches)).not.toContain(renamed);
    const afterDelete = await sync(other, 'GET', alice.email, () => other.reload());
    expect(JSON.stringify(await afterDelete.json())).not.toContain(renamed);
    await expect(searches(other).getByRole('button', { name: renamed, exact: true })).toHaveCount(0);
  } finally {
    await second.close();
  }
});
