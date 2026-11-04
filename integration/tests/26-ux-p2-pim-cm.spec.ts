import { test, expect, type Page } from '@playwright/test';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability pass 2, pim-p2-11, p2-14 and p2-15, against a VM 106 Stalwart
 * (1.0 and 0.16). Every write is checked on the server.
 *
 * - Contacts and Files name the account they show by its address, and switch from there.
 * - A CSV with the same address on two rows imports one card, and the import ends in a toast.
 * - The merge preview lays out the address as the card does and lists the birthday it keeps.
 *
 * Accounts: dso-ux-pim (A) and dso-ux-pim-b (B), password IT_DSO_PASSWORD. The spec
 * makes its own cards, named "UXP2-cm <run> …", and removes them again.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const B = 'dso-ux-pim-b@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const CONTACTS = 'urn:ietf:params:jmap:contacts';
const RUN = Date.now().toString(36);
const PREFIX = `UXP2-cm ${RUN}`;

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Card = Record<string, unknown> & {
  id: string;
  kind?: string;
  name?: { full?: string; components?: Array<{ kind: string; value: string }> };
  emails?: Record<string, { address: string }>;
  addressBookIds?: Record<string, boolean>;
};

const nameOf = (c: Card) => c.name?.full || (c.name?.components ?? []).filter((p) => p.kind !== 'separator').map((p) => p.value).join(' ');

async function defaultBook(c: JmapClient): Promise<string> {
  const r = await c.request([['AddressBook/get', { accountId: c.accountId }, '0']], [CORE, CONTACTS]);
  const list = r.methodResponses[0][1].list as Array<{ id: string; isDefault?: boolean }>;
  return (list.find((b) => b.isDefault) ?? list[0]).id;
}

async function cards(c: JmapClient): Promise<Card[]> {
  const r = await c.request([
    ['ContactCard/query', { accountId: c.accountId, limit: 2000 }, 'q'],
    ['ContactCard/get', { accountId: c.accountId, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' } }, 'g'],
  ], [CORE, CONTACTS]);
  return (r.methodResponses[1][1].list as Card[]).filter((card) => nameOf(card).includes(PREFIX));
}

async function destroyOurs(c: JmapClient): Promise<void> {
  const ids = (await cards(c)).map((card) => card.id);
  if (ids.length) await c.request([['ContactCard/set', { accountId: c.accountId, destroy: ids }, '0']], [CORE, CONTACTS]);
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

/** The account the app has active, by its address, from the switcher. */
async function activeEmail(page: Page): Promise<string | null> {
  const id = await accountSwitcher(page).getAttribute('data-active-account-id');
  if (!id) return null;
  await accountSwitcher(page).click();
  const email = await page.locator(`[data-testid="account-option"][data-account-id="${id}"]`).first().getAttribute('data-account-email');
  await page.keyboard.press('Escape');
  return email;
}

test.describe('Which account Contacts and Files show (pim-p2-11)', () => {
  test('the address under the title names the account and switches it', async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);
    await accountSwitcher(page).click();
    await page.locator('[data-testid="add-account"]').click();
    await signIn(page, B);
    await expect.poll(() => activeEmail(page), { timeout: 60000 }).toBe(B);

    await page.goto('/contacts');
    const scope = page.getByTestId('account-scope');
    await expect(scope).toHaveText(B, { timeout: 60000 });
    await scope.click();
    const options = page.getByRole('menuitem');
    await expect(options.filter({ hasText: A })).toBeVisible();
    await expect(options.filter({ hasText: B })).toBeVisible();
    await options.filter({ hasText: A }).click();
    await expect(scope).toHaveText(A, { timeout: 60000 });
    await expect.poll(() => activeEmail(page), { timeout: 60000 }).toBe(A);

    await page.goto('/files');
    await expect(scope).toHaveText(A, { timeout: 60000 });
    await scope.click();
    await page.getByRole('menuitem').filter({ hasText: B }).click();
    await expect(scope).toHaveText(B, { timeout: 60000 });
    await expect.poll(() => activeEmail(page), { timeout: 60000 }).toBe(B);
    await context.close();
  });
});

test.describe('Contacts import and merge, pass 2 (pim-p2-14, pim-p2-15)', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    await destroyOurs(await JmapClient.connect(A, PASSWORD));
  });

  test('a CSV with one person twice imports one card, and a toast says how many went in', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);
    await page.goto('/contacts');
    await page.getByRole('button', { name: 'New', exact: true }).first().click();
    await page.getByRole('menuitem', { name: /^Import contacts/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const csv = [
      'First Name,Last Name,E-mail Address',
      `Anna,${PREFIX} Twice,twice-${RUN}@example.org`,
      `Bob,${PREFIX} Once,once-${RUN}@example.org`,
      `Anna,${PREFIX} Twice,TWICE-${RUN}@example.org`,
      '',
    ].join('\r\n');
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'contacts-export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8') });
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect(dialog.getByText(`Bob ${PREFIX} Once`)).toBeVisible();
    // The second Anna is marked and left out.
    await expect(dialog.getByText('Duplicate', { exact: true })).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();

    const toastRegion = page.getByRole('region', { name: 'Notifications' });
    await expect(toastRegion.getByText('2 contacts imported')).toBeVisible({ timeout: 30000 });
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await cards(a)).length, { timeout: 30000 }).toBe(2);
    const imported = await cards(a);
    expect(imported.flatMap((c) => Object.values(c.emails ?? {}).map((e) => e.address.toLowerCase())).sort())
      .toEqual([`once-${RUN}@example.org`, `twice-${RUN}@example.org`]);
    // Show opens where they went.
    await toastRegion.getByRole('button', { name: 'Show' }).click();
    await page.getByPlaceholder(/Search contacts/).first().fill(PREFIX);
    await expect(page.getByRole('option').filter({ hasText: PREFIX })).toHaveCount(2, { timeout: 30000 });
    await context.close();
  });

  test('the merge preview shows the address as the card does and the birthday it keeps; Merge with is by name', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const book = await defaultBook(a);
    const surname = `${PREFIX} Merge`;
    const made = await a.request([['ContactCard/set', {
      accountId: a.accountId,
      create: {
        one: {
          '@type': 'Card', version: '1.0', kind: 'individual', addressBookIds: { [book]: true },
          name: { '@type': 'Name', components: [{ kind: 'given', value: 'Anna' }, { kind: 'surname', value: surname }], isOrdered: true },
          emails: { e0: { '@type': 'EmailAddress', address: `merge-a-${RUN}@example.org` } },
          addresses: {
            a0: {
              '@type': 'Address', countryCode: 'DE', isOrdered: true, defaultSeparator: ', ', contexts: { private: true },
              components: [
                { kind: 'name', value: 'Hauptstraße' }, { kind: 'separator', value: ' ' }, { kind: 'number', value: '5' },
                { kind: 'locality', value: 'Berlin' }, { kind: 'postcode', value: '10115' }, { kind: 'country', value: 'Germany' },
              ],
            },
          },
        },
        two: {
          '@type': 'Card', version: '1.0', kind: 'individual', addressBookIds: { [book]: true },
          name: { '@type': 'Name', components: [{ kind: 'given', value: 'Anna' }, { kind: 'surname', value: surname }], isOrdered: true },
          emails: { e0: { '@type': 'EmailAddress', address: `merge-b-${RUN}@example.org` } },
          anniversaries: { b0: { '@type': 'Anniversary', kind: 'birth', date: { '@type': 'PartialDate', year: 1990, month: 3, day: 14 } } },
        },
        zed: {
          '@type': 'Card', version: '1.0', kind: 'individual', addressBookIds: { [book]: true },
          name: { '@type': 'Name', full: `Zed ${PREFIX} Picker` },
        },
      },
    }, '0']], [CORE, CONTACTS]);
    const created = made.methodResponses[0][1].created ?? {};
    expect(Object.keys(created).sort(), JSON.stringify(made.methodResponses[0][1].notCreated)).toEqual(['one', 'two', 'zed']);

    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page, A);
    await page.goto('/contacts');
    await page.getByPlaceholder(/Search contacts/).first().fill(surname);
    const rows = page.getByRole('option').filter({ hasText: surname });
    await expect(rows).toHaveCount(2, { timeout: 60000 });

    // Merge with…: the list to pick from goes by name.
    await rows.first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Merge with…' }).click();
    const pickList = page.getByTestId('merge-pick-list');
    await expect(pickList).toBeVisible();
    // The suggested ones come first, in their own block; "All contacts" is the last block.
    const all = (await pickList.locator(':scope > div').last().getByRole('button').allInnerTexts()).map((t) => t.split('\n')[0].trim());
    expect(all.length).toBeGreaterThan(1);
    expect(all).toEqual([...all].sort((x, y) => x.localeCompare(y, 'en', { sensitivity: 'base', numeric: true })));
    await page.getByRole('button', { name: 'Cancel' }).click();

    await rows.nth(0).click();
    await rows.nth(1).click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: 'Merge…' }).first().click();
    const preview = page.getByTestId('merge-preview');
    await expect(preview).toBeVisible();
    const address = preview.locator('dd').filter({ hasText: 'Hauptstraße' });
    // Street, then postcode and city, then the country, each on its own line.
    expect(await address.innerText()).toBe('Hauptstraße 5\n10115 Berlin\nGermany');
    const birthdayRow = preview.locator('div').filter({ has: page.locator('dt', { hasText: 'Birthday' }) }).last();
    await expect(birthdayRow.locator('dd')).toContainText('1990');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(preview).toBeHidden();
    // Nothing merged: both cards are still there.
    expect((await cards(a)).filter((c) => nameOf(c).includes(surname))).toHaveLength(2);
    await context.close();
  });
});
