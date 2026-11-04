import { test, expect, type Page } from '@playwright/test';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability fix pim-4: saving a contact never rewrites an address the user
 * didn't touch, and an edited address is saved in its country's order.
 * Against a VM 106 Stalwart (1.0 and 0.16, which converts cards through
 * vCard), every UI step is checked on the server.
 *
 * Account: dso-ux-pim (password IT_DSO_PASSWORD). The spec makes its own
 * card, named "UXFIX-contact …", and removes it again.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const CONTACTS = 'urn:ietf:params:jmap:contacts';
const RUN = Date.now().toString(36);
const PREFIX = 'UXFIX-contact';

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Address = Record<string, unknown> & { components?: Array<{ kind: string; value: string }> };
type Card = Record<string, unknown> & {
  id: string;
  name?: { full?: string; components?: Array<{ kind: string; value: string }> };
  nicknames?: Record<string, { name: string }>;
  addresses?: Record<string, Address>;
};

async function defaultBook(c: JmapClient): Promise<string> {
  const r = await c.request([['AddressBook/get', { accountId: c.accountId }, '0']], [CORE, CONTACTS]);
  const list = r.methodResponses[0][1].list as Array<{ id: string; isDefault?: boolean }>;
  return (list.find((b) => b.isDefault) ?? list[0]).id;
}

async function cards(c: JmapClient): Promise<Card[]> {
  const r = await c.request([
    ['ContactCard/query', { accountId: c.accountId, limit: 1000 }, 'q'],
    ['ContactCard/get', { accountId: c.accountId, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' } }, 'g'],
  ], [CORE, CONTACTS]);
  const named = (card: Card) => card.name?.full ?? card.name?.components?.map((x) => x.value).join(' ') ?? '';
  return (r.methodResponses[1][1].list as Card[]).filter((card) => named(card).startsWith(PREFIX));
}

async function getCard(c: JmapClient, id: string): Promise<Card> {
  const r = await c.request([['ContactCard/get', { accountId: c.accountId, ids: [id] }, '0']], [CORE, CONTACTS]);
  return r.methodResponses[0][1].list[0] as Card;
}

async function login(page: Page): Promise<void> {
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.locator('#username').waitFor({ state: 'visible', timeout: 60000 });
  await page.fill('#username', A);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
}

test.describe('Saving a contact keeps its address (pim-4)', () => {
  test.afterAll(async () => {
    const a = await JmapClient.connect(A, PASSWORD);
    const ids = (await cards(a)).filter((card) => JSON.stringify(card.name).includes(RUN)).map((card) => card.id);
    if (ids.length) await a.request([['ContactCard/set', { accountId: a.accountId, destroy: ids }, '0']], [CORE, CONTACTS]);
  });

  test('a nickname edit leaves a German address as stored, an address edit saves it in German order', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const surname = `Adresse ${RUN}`;
    const created = await a.request([['ContactCard/set', {
      accountId: a.accountId,
      create: {
        c: {
          '@type': 'Card',
          version: '1.0',
          kind: 'individual',
          addressBookIds: { [await defaultBook(a)]: true },
          name: { '@type': 'Name', components: [{ kind: 'given', value: PREFIX }, { kind: 'surname', value: surname }], isOrdered: true },
          phones: { p1: { '@type': 'Phone', number: '+49 30 123456', features: { voice: true }, contexts: { private: true } } },
          addresses: {
            home: {
              '@type': 'Address',
              contexts: { private: true },
              countryCode: 'DE',
              isOrdered: true,
              defaultSeparator: ', ',
              components: [
                { kind: 'name', value: 'Hauptstraße' },
                { kind: 'separator', value: ' ' },
                { kind: 'number', value: '1' },
                { kind: 'apartment', value: '3. OG' },
                { kind: 'postcode', value: '10000' },
                { kind: 'locality', value: 'Berlin' },
                { kind: 'country', value: 'Germany' },
              ],
            },
          },
        },
      },
    }, '0']], [CORE, CONTACTS]);
    const id = created.methodResponses[0][1].created?.c?.id as string | undefined;
    expect(id, JSON.stringify(created.methodResponses[0][1].notCreated ?? {})).toBeTruthy();
    // The address as this server keeps it (0.16 goes through vCard).
    const stored = (await getCard(a, id!)).addresses!;
    expect(Object.keys(stored)).toHaveLength(1);

    const context = await browser.newContext(contextOptions());
    const page = await context.newPage();
    await login(page);
    await page.goto('/contacts');
    await page.getByPlaceholder('Search contacts...').fill(RUN);
    await page.locator('[data-contact-id]', { hasText: surname }).first().click();

    // The contact page lays the address out the German way, one line per part.
    const addressLines = page.getByTestId('contact-address').first().locator('[data-address-line]');
    await expect(addressLines).toHaveText(['Hauptstraße 1, 3. OG', '10000 Berlin', 'Germany']);
    await expect(page.getByText('Home · Phone', { exact: true })).toBeVisible();

    // 1. Only the nickname changes: the server's address stays exactly as it was.
    await page.getByRole('button', { name: 'Edit contact' }).click();
    await expect(page.getByLabel('Street')).toHaveValue('Hauptstraße 1');
    await page.getByLabel('Nickname').fill('Adi');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Contact updated')).toBeVisible({ timeout: 30000 });
    await expect.poll(async () => Object.values((await getCard(a, id!)).nicknames ?? {})[0]?.name, { timeout: 30000 }).toBe('Adi');
    expect((await getCard(a, id!)).addresses).toEqual(stored);

    // 2. The address is edited: saved in German order, apartment and context kept.
    await page.getByRole('button', { name: 'Edit contact' }).click();
    await page.getByLabel('Street').fill('Hauptstraße 12a');
    await page.getByLabel('Postal code').fill('10115');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => {
      const address = Object.values((await getCard(a, id!)).addresses ?? {})[0];
      return address?.components?.map((x) => `${x.kind}:${x.value}`);
    }, { timeout: 30000 }).toEqual([
      'name:Hauptstraße', 'separator: ', 'number:12a', 'apartment:3. OG', 'postcode:10115', 'separator: ', 'locality:Berlin', 'country:Germany',
    ]);
    const edited = Object.values((await getCard(a, id!)).addresses!)[0];
    expect(edited).toMatchObject({ countryCode: 'DE', contexts: { private: true }, isOrdered: true });
    await expect(addressLines).toHaveText(['Hauptstraße 12a, 3. OG', '10115 Berlin', 'Germany']);

    // A reload reads the card back from the server, not from the app's memory.
    await page.reload();
    await page.getByPlaceholder('Search contacts...').fill(RUN);
    await page.locator('[data-contact-id]', { hasText: surname }).first().click();
    await expect(addressLines).toHaveText(['Hauptstraße 12a, 3. OG', '10115 Berlin', 'Germany']);
    await context.close();
  });
});
