import { test, expect, type Page } from '@playwright/test';
import { contextOptions } from './helpers/ent';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, neutralizeDevOverlay } from './helpers/app';

/**
 * Usability fixes pim-11 (CSV import into a chosen address book) and pim-14
 * (merging duplicate contacts), against a VM 106 Stalwart (1.0 and 0.16).
 * Every UI step is checked on the server through JMAP.
 *
 * Account: dso-ux-pim (password IT_DSO_PASSWORD). The spec makes its own
 * cards, named "UXFIX-cimport …", and removes them again; the seeded "Work"
 * address book is only written to with those cards.
 */

const PASSWORD = process.env.IT_DSO_PASSWORD ?? '';
const A = 'dso-ux-pim@example.org';
const CORE = 'urn:ietf:params:jmap:core';
const CONTACTS = 'urn:ietf:params:jmap:contacts';
const RUN = Date.now().toString(36);
const PREFIX = 'UXFIX-cimport';
const SHOTS = 'C:/Users/info/Downloads/jmap-webmail/local-data/usability-2026-11-04/shots';
// Shots once, from the 1.0 run.
const TAKE_SHOTS = process.env.IT_ENT_SERVER === '1.0';

test.skip(!PASSWORD, 'Set IT_DSO_PASSWORD (vault "Stalwart test – dso-* throwaway accounts")');

type Card = Record<string, unknown> & {
  id: string;
  uid?: string;
  kind?: string;
  name?: { full?: string; components?: Array<{ kind: string; value: string }> };
  addressBookIds?: Record<string, boolean>;
  members?: Record<string, boolean>;
  emails?: Record<string, { address: string }>;
  phones?: Record<string, { number: string; features?: Record<string, boolean>; contexts?: Record<string, boolean> }>;
  addresses?: Record<string, { components?: Array<{ kind: string; value: string }>; contexts?: Record<string, boolean>; isOrdered?: boolean }>;
  notes?: Record<string, { note: string }>;
  organizations?: Record<string, { name?: string }>;
  titles?: Record<string, { name: string }>;
  anniversaries?: Record<string, { kind: string; date: Record<string, unknown> }>;
};

const nameOf = (c: Card) => c.name?.full || (c.name?.components ?? []).filter((p) => p.kind !== 'separator').map((p) => p.value).join(' ');

async function books(c: JmapClient): Promise<Array<{ id: string; name: string; isDefault?: boolean }>> {
  const r = await c.request([['AddressBook/get', { accountId: c.accountId }, '0']], [CORE, CONTACTS]);
  return r.methodResponses[0][1].list;
}

async function cards(c: JmapClient, prefix: string): Promise<Card[]> {
  const r = await c.request([
    ['ContactCard/query', { accountId: c.accountId, limit: 2000 }, 'q'],
    ['ContactCard/get', { accountId: c.accountId, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' } }, 'g'],
  ], [CORE, CONTACTS]);
  return (r.methodResponses[1][1].list as Card[]).filter((card) => nameOf(card).includes(prefix));
}

async function destroyAll(c: JmapClient): Promise<void> {
  const ids = (await cards(c, PREFIX)).map((card) => card.id);
  if (ids.length) await c.request([['ContactCard/set', { accountId: c.accountId, destroy: ids }, '0']], [CORE, CONTACTS]);
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

/** German Outlook's export: `;` between fields, Windows-1252 bytes. */
function outlookDeCsv(rows: Array<Record<string, string>>): Buffer {
  const headers = ['Anrede', 'Vorname', 'Weitere Vornamen', 'Nachname', 'Firma', 'Abteilung', 'Position',
    'Straße geschäftlich', 'Ort geschäftlich', 'Postleitzahl geschäftlich', 'Land/Region geschäftlich',
    'Telefon geschäftlich', 'Mobiltelefon', 'E-Mail-Adresse', 'E-Mail-Typ', 'E-Mail: Angezeigter Name',
    'Geburtstag', 'Jahrestag', 'Kategorien', 'Notizen', 'Privat'];
  const line = (cells: string[]) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(';');
  const text = [line(headers), ...rows.map((r) => line(headers.map((h) => r[h] ?? '')))].join('\r\n') + '\r\n';
  const high: Record<string, number> = { '€': 0x80, '„': 0x84, '“': 0x93, '”': 0x94, '–': 0x96 };
  return Buffer.from([...text].map((ch) => {
    if (high[ch]) return high[ch];
    const code = ch.charCodeAt(0);
    if (code > 0xff) throw new Error(`not in Windows-1252: ${ch}`);
    return code;
  }));
}

test.describe('Contacts import and merge (pim-11, pim-14)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await destroyAll(await JmapClient.connect(A, PASSWORD));
  });
  test.afterAll(async () => {
    await destroyAll(await JmapClient.connect(A, PASSWORD));
  });

  test('a German Outlook CSV goes through the column step into the address book that is open', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const work = (await books(a)).find((b) => b.name === 'Work');
    expect(work, 'seeded Work address book').toBeTruthy();
    expect(work!.isDefault).toBeFalsy();

    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page);
    await page.goto('/contacts');
    await page.getByText('Work', { exact: true }).first().click();
    await page.getByRole('button', { name: 'New', exact: true }).first().click();
    await page.getByRole('menuitem', { name: /^Import contacts/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'Outlook-Kontakte.csv',
      mimeType: 'text/csv',
      buffer: outlookDeCsv([
        {
          Anrede: 'Frau', Vorname: 'Jürgen', Nachname: `${PREFIX} Import1 ${RUN}`, Firma: 'Muster & Söhne GmbH', Position: 'Leiterin',
          'Straße geschäftlich': 'Hauptstraße 1', 'Ort geschäftlich': 'Köln', 'Postleitzahl geschäftlich': '50667',
          'Land/Region geschäftlich': 'Deutschland', Mobiltelefon: '+49 170 1234567',
          'E-Mail-Adresse': `import1-${RUN}@example.org`, 'E-Mail-Typ': 'SMTP', 'E-Mail: Angezeigter Name': 'Jürgen',
          Geburtstag: '12.04.1985', Jahrestag: '0.0.00', Notizen: 'Rabatt 10 €, „Stammkunde“', Privat: 'Aus',
        },
        { Vorname: 'Ana', Nachname: `${PREFIX} Import2 ${RUN}`, 'E-Mail-Adresse': `import2-${RUN}@example.org`, Privat: 'Aus' },
      ]),
    });

    const columns = dialog.getByTestId('csv-columns');
    await expect(columns).toBeVisible();
    await expect(columns.getByRole('combobox', { name: 'Vorname', exact: true })).toHaveValue('name.given');
    await expect(columns.getByRole('combobox', { name: 'Straße geschäftlich', exact: true })).toHaveValue('adr.work.street');
    await expect(columns.getByRole('combobox', { name: 'E-Mail-Typ', exact: true })).toHaveValue('skip');
    await expect(columns.getByRole('row', { name: /^Vorname/ }).getByText('Jürgen', { exact: true })).toBeVisible();
    if (TAKE_SHOTS) await page.screenshot({ path: `${SHOTS}/pim-fix-11-after.png` });
    await dialog.getByRole('button', { name: 'Continue' }).click();

    await expect(dialog.getByText(`Jürgen ${PREFIX} Import1 ${RUN}`)).toBeVisible();
    const into = dialog.getByRole('combobox');
    await expect(into).toHaveValue(work!.id);
    if (TAKE_SHOTS) await page.screenshot({ path: `${SHOTS}/pim-fix-11-after-preview.png` });
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByText('2 contacts imported')).toBeVisible({ timeout: 30000 });

    await expect.poll(async () => (await cards(a, `${PREFIX} Import`)).length, { timeout: 30000 }).toBe(2);
    const imported = await cards(a, `${PREFIX} Import`);
    for (const card of imported) expect(Object.keys(card.addressBookIds ?? {})).toEqual([work!.id]);
    const jurgen = imported.find((c) => nameOf(c).includes('Import1'))!;
    expect(jurgen.name?.components?.filter((p) => p.kind !== 'separator')).toEqual([
      { kind: 'title', value: 'Frau' }, { kind: 'given', value: 'Jürgen' }, { kind: 'surname', value: `${PREFIX} Import1 ${RUN}` },
    ]);
    expect(Object.values(jurgen.emails ?? {}).map((e) => e.address)).toEqual([`import1-${RUN}@example.org`]);
    expect(Object.values(jurgen.phones ?? {}).map((p) => [p.number, p.features])).toEqual([['+49 170 1234567', { mobile: true }]]);
    const address = Object.values(jurgen.addresses ?? {})[0];
    expect(address?.contexts).toEqual({ work: true });
    expect(address?.components?.filter((p) => p.kind !== 'separator').map((p) => [p.kind, p.value])).toEqual([
      ['name', 'Hauptstraße 1'], ['locality', 'Köln'], ['postcode', '50667'], ['country', 'Deutschland'],
    ]);
    expect(Object.values(jurgen.organizations ?? {}).map((o) => o.name)).toEqual(['Muster & Söhne GmbH']);
    expect(Object.values(jurgen.titles ?? {}).map((t) => t.name)).toEqual(['Leiterin']);
    expect(Object.values(jurgen.notes ?? {}).map((n) => n.note)).toEqual(['Rabatt 10 €, „Stammkunde“']);
    const birthday = Object.values(jurgen.anniversaries ?? {}).find((x) => x.kind === 'birth');
    expect(birthday?.date).toMatchObject({ year: 1985, month: 4, day: 12 });
    await context.close();
  });

  test('two cards merge into one: everything kept, the group moves, the other card is gone', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await JmapClient.connect(A, PASSWORD);
    const home = (await books(a)).find((b) => b.isDefault) ?? (await books(a))[0];
    const surname = `${PREFIX} Merge ${RUN}`;
    // The address the way a server card has it: parts and separators in order.
    const berlin = {
      '@type': 'Address',
      components: [
        { '@type': 'AddressComponent', kind: 'name', value: 'Hauptstraße' },
        { '@type': 'AddressComponent', kind: 'separator', value: ' ' },
        { '@type': 'AddressComponent', kind: 'number', value: '1' },
        { '@type': 'AddressComponent', kind: 'postcode', value: '10115' },
        { '@type': 'AddressComponent', kind: 'locality', value: 'Berlin' },
      ],
      isOrdered: true,
      defaultSeparator: ', ',
      contexts: { private: true },
    };
    const made = await a.request([['ContactCard/set', {
      accountId: a.accountId,
      create: {
        one: {
          '@type': 'Card', version: '1.0', uid: `urn:uuid:uxfix-cimport-one-${RUN}`, addressBookIds: { [home.id]: true },
          name: { '@type': 'Name', components: [{ '@type': 'NameComponent', kind: 'given', value: 'Anna' }, { '@type': 'NameComponent', kind: 'surname', value: surname }], isOrdered: true },
          emails: { e0: { '@type': 'EmailAddress', address: `merge-a-${RUN}@example.org` } },
          addresses: { a0: berlin },
          notes: { n0: { '@type': 'Note', note: 'Met at the fair' } },
        },
        two: {
          '@type': 'Card', version: '1.0', uid: `urn:uuid:uxfix-cimport-two-${RUN}`, addressBookIds: { [home.id]: true },
          name: { '@type': 'Name', components: [{ '@type': 'NameComponent', kind: 'given', value: 'Anna' }, { '@type': 'NameComponent', kind: 'surname', value: surname }], isOrdered: true },
          emails: { e0: { '@type': 'EmailAddress', address: `merge-b-${RUN}@example.org` } },
          phones: { p0: { '@type': 'Phone', number: '+49 30 5550000' } },
        },
        group: {
          '@type': 'Card', version: '1.0', kind: 'group', uid: `urn:uuid:uxfix-cimport-group-${RUN}`, addressBookIds: { [home.id]: true },
          name: { '@type': 'Name', full: `${PREFIX} Group ${RUN}` },
          members: { [`urn:uuid:uxfix-cimport-one-${RUN}`]: true },
        },
      },
    }, '0']], [CORE, CONTACTS]);
    const created = made.methodResponses[0][1].created ?? {};
    expect(Object.keys(created).sort(), JSON.stringify(made.methodResponses[0][1].notCreated)).toEqual(['group', 'one', 'two']);
    const [before] = (await cards(a, surname)).filter((c) => c.id === created.one.id);
    const beforeAddress = Object.values(before.addresses ?? {})[0];

    const context = await browser.newContext({ ...contextOptions(), viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page);
    await page.goto('/contacts');
    const search = page.getByPlaceholder(/Search contacts/).first();
    await search.fill(surname);
    const rows = page.getByRole('option').filter({ hasText: surname });
    await expect(rows).toHaveCount(2, { timeout: 60000 });

    // The single-contact menu offers Merge with…, not Duplicate.
    await rows.first().click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Merge with…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Duplicate' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await rows.nth(0).click();
    await rows.nth(1).click({ modifiers: ['Control'] });
    await page.getByRole('button', { name: 'Merge…' }).first().click();
    const preview = page.getByTestId('merge-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByText(`merge-a-${RUN}@example.org`)).toBeVisible();
    await expect(preview.getByText(`merge-b-${RUN}@example.org`)).toBeVisible();
    await expect(preview.getByText('Hauptstraße 1, 10115, Berlin')).toBeVisible();
    await expect(preview.getByText(`${PREFIX} Group ${RUN}`)).toBeVisible();
    if (TAKE_SHOTS) await page.screenshot({ path: `${SHOTS}/pim-fix-14-after.png` });
    await page.getByRole('button', { name: 'Merge', exact: true }).click();
    const toastRegion = page.getByRole('region', { name: 'Notifications' });
    await expect(toastRegion.getByText('Contacts merged')).toBeVisible({ timeout: 30000 });

    // On the server: one card with everything, the address untouched, the group pointing at it.
    await expect.poll(async () => (await cards(a, surname)).filter((c) => c.kind !== 'group').length, { timeout: 30000 }).toBe(1);
    const all = await cards(a, PREFIX);
    const [kept] = all.filter((c) => nameOf(c).includes(surname) && c.kind !== 'group');
    const goneId = kept.id === created.one.id ? created.two.id : created.one.id;
    expect(all.some((c) => c.id === goneId)).toBe(false);
    const gone = await a.request([['ContactCard/get', { accountId: a.accountId, ids: [goneId] }, '0']], [CORE, CONTACTS]);
    expect(gone.methodResponses[0][1].notFound).toEqual([goneId]);
    expect(Object.values(kept.emails ?? {}).map((e) => e.address).sort()).toEqual([`merge-a-${RUN}@example.org`, `merge-b-${RUN}@example.org`]);
    expect(Object.values(kept.phones ?? {}).map((p) => p.number)).toEqual(['+49 30 5550000']);
    expect(Object.values(kept.notes ?? {}).map((n) => n.note)).toEqual(['Met at the fair']);
    const keptAddresses = Object.values(kept.addresses ?? {});
    expect(keptAddresses).toHaveLength(1);
    expect(keptAddresses[0].components).toEqual(beforeAddress?.components);
    expect(keptAddresses[0].contexts).toEqual({ private: true });
    const group = all.find((c) => c.kind === 'group');
    const members = Object.keys(group?.members ?? {}).filter((k) => group?.members?.[k]);
    expect(members).toEqual([kept.uid]);

    // Undo: the other card is back under its own uid, the group and the kept card as before.
    await toastRegion.getByRole('button', { name: 'Undo' }).click();
    await expect(toastRegion.getByText('Merge undone')).toBeVisible({ timeout: 30000 });
    const after = await cards(a, PREFIX);
    const back = after.filter((c) => nameOf(c).includes(surname) && c.kind !== 'group');
    expect(back.map((c) => c.uid).sort()).toEqual([`urn:uuid:uxfix-cimport-one-${RUN}`, `urn:uuid:uxfix-cimport-two-${RUN}`]);
    for (const card of back) expect(Object.keys(card.emails ?? {})).toHaveLength(1);
    const groupAfter = after.find((c) => c.kind === 'group');
    expect(Object.keys(groupAfter?.members ?? {}).filter((k) => groupAfter?.members?.[k])).toEqual([`urn:uuid:uxfix-cimport-one-${RUN}`]);
    const one = back.find((c) => c.uid === `urn:uuid:uxfix-cimport-one-${RUN}`);
    expect(Object.values(one?.addresses ?? {})[0]?.components).toEqual(beforeAddress?.components);
    await context.close();
  });

  test('the contact menu says Merge with… in German too', async ({ browser }) => {
    test.skip(!TAKE_SHOTS, 'Shot only from the 1.0 run');
    test.setTimeout(180_000);
    const context = await browser.newContext({ ...contextOptions(), locale: 'de-DE', viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page);
    await page.goto('/contacts');
    await page.getByRole('option').filter({ hasText: 'Anna Example' }).first().click();
    await page.getByRole('button', { name: 'Weitere Aktionen' }).first().click();
    await expect(page.getByRole('menuitem', { name: 'Zusammenführen mit…' })).toBeVisible();
    await expect(page.getByText(/Mögliche Duplikate \(\d+\)/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/pim-fix-14-after-de.png` });
    await context.close();
  });
});
