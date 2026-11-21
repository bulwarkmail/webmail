import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { JmapClient } from './helpers/jmap';
import { accountSwitcher, emailItem, expandSharedFolders, folderRow, neutralizeDevOverlay } from './helpers/app';
import { adminContext, contextOptions, getPolicy, putPolicy } from './helpers/org';

/**
 * Notes and assignment in team mailboxes, through the real UI on a VM 106
 * test Stalwart with the throwaway tm-* accounts only (never the suite's
 * reset()). Start it with team-mailboxes-rig/scripts/run-spec.sh, which
 * checks the accounts first and sets:
 *   IT_WEBMAIL_URL, IT_JMAP_URL, IT_TM_SERVER (0.16 or 1.0)
 *   IT_TM_PASSWORD     password of the tm-* accounts
 *   IT_ADMIN_PASSWORD  the Bulwark server's admin password
 *   IT_ACCOUNT_USERS   tm-alice,tm-bob,tm-carol (the global setup polls the first)
 *
 * tm-alice, tm-bob and tm-carol are in the group tm-team, tm-reader gets
 * read-only rights on its Inbox, tm-other is in tm-team2. The switch is on
 * for the tm-team group only. Messages are created over JMAP and destroyed
 * at the end, with every note written on them; the policy and the reader's
 * rights are put back.
 */

test.describe.configure({ mode: 'serial', timeout: 240000 });

const PASSWORD = process.env.IT_TM_PASSWORD ?? '';
const SERVER = process.env.IT_TM_SERVER ?? 'unknown';
const TM = {
  alice: 'tm-alice@example.org',
  bob: 'tm-bob@example.org',
  carol: 'tm-carol@example.org',
  reader: 'tm-reader@example.org',
  other: 'tm-other@example.org',
  team: 'tm-team@example.org',
  team2: 'tm-team2@example.org',
} as const;

const RUN = Date.now().toString(36);
const NOTED = `Invoice question ${RUN}`;
const ASSIGNED = `Refund request ${RUN}`;
const OWN = `Alice own mail ${RUN}`;
const TEAM2 = `Team two mail ${RUN}`;
const BOB_NOTE = `Bob checked the invoice ${RUN}`;
const ALICE_NOTE = `please call the customer ${RUN}`;
const BOB_NOTE2 = `customer called back ${RUN}`;

const created: Array<{ account: string; accountId: string; id: string }> = [];
let original: Record<string, unknown> | null = null;
let readerId = '';
const sharedWithReader: string[] = [];

async function connect(email: string): Promise<JmapClient> {
  return JmapClient.connect(email, PASSWORD);
}

/** A received-looking message in the Inbox of `accountName`, created by `account`. */
async function createMessage(account: string, accountName: string, subject: string): Promise<void> {
  const client = await connect(account);
  const accountId = accountName === account ? client.accountId : client.accountIdByName(accountName);
  const inbox = await client.mailboxByRole('inbox', accountId);
  if (!inbox) throw new Error(`${accountName}: no Inbox`);
  const r = await client.request([['Email/set', {
    accountId,
    create: {
      m: {
        mailboxIds: { [inbox.id]: true },
        keywords: {},
        messageId: [`${subject.replace(/\W+/g, '-')}@example.net`],
        from: [{ name: 'Customer', email: 'customer@example.net' }],
        to: [{ email: accountName }],
        subject,
        receivedAt: new Date().toISOString(),
        bodyValues: { b: { value: `A message for the team mailboxes spec (${RUN}).` } },
        textBody: [{ partId: 'b', type: 'text/plain' }],
      },
    },
  }, '0']]);
  const id = r.methodResponses?.[0]?.[1]?.created?.m?.id;
  if (!id) throw new Error(`could not create "${subject}": ${JSON.stringify(r.methodResponses?.[0])}`);
  created.push({ account, accountId, id });
}

/** The team's notes folder, as the server has it (Bulwark hides it). */
async function notesFolderId(client: JmapClient, accountId: string): Promise<string | null> {
  const folders = await client.mailboxes(accountId);
  return folders.find((m) => m.name === 'Team notes' && !m.parentId && !m.role)?.id ?? null;
}

/** The note messages the server keeps for one of this run's messages. */
async function notesOn(subject: string): Promise<Array<{ id: string; subject: string; keywords: Record<string, boolean> }>> {
  const client = await connect(TM.alice);
  const accountId = client.accountIdByName(TM.team);
  const folder = await notesFolderId(client, accountId);
  if (!folder) return [];
  const r = await client.request([
    ['Email/query', { accountId, filter: { inMailbox: folder, subject } }, '0'],
    ['Email/get', { accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'keywords'] }, '1'],
  ]);
  return (r.methodResponses?.[1]?.[1]?.list ?? []).filter((e: { subject?: string }) => e.subject === `Note: ${subject}`);
}

async function keywordsOf(subject: string): Promise<string[]> {
  const client = await connect(TM.alice);
  const accountId = client.accountIdByName(TM.team);
  const found = await client.request([
    ['Email/query', { accountId, filter: { subject } }, '0'],
    ['Email/get', { accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['subject', 'keywords'] }, '1'],
  ]);
  const email = (found.methodResponses?.[1]?.[1]?.list ?? []).find((e: { subject?: string }) => e.subject === subject);
  return Object.keys(email?.keywords ?? {});
}

/** Sign in a fresh context as one of the tm-* accounts. */
async function userPage(browser: Browser, email: string, phone = false): Promise<Page> {
  const context = await browser.newContext(contextOptions(phone));
  const page = await context.newPage();
  await neutralizeDevOverlay(page);
  await page.goto('/');
  await page.fill('#username', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await accountSwitcher(page).waitFor({ state: 'visible', timeout: 60000 });
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.IT_TM_SCREENSHOTS;
  if (!dir) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}-${SERVER}.png`), fullPage: false });
}

async function openTeamFolder(page: Page, group: string = TM.team): Promise<void> {
  await expandSharedFolders(page, group);
  await folderRow(page, { role: 'inbox', shared: true }).first().click();
}

async function openTeamMessage(page: Page, subject: string, group: string = TM.team): Promise<void> {
  await openTeamFolder(page, group);
  const row = emailItem(page, subject).first();
  await row.waitFor({ state: 'visible', timeout: 30000 });
  await openRow(row);
}

/** Opens a row by its left side: its middle has the hover buttons. */
async function openRow(row: Locator): Promise<void> {
  await row.waitFor({ state: "visible", timeout: 30000 });
  await row.click({ position: { x: 90, y: 14 } });
}

const noteCards = (page: Page): Locator => page.locator('[data-team-note]:visible');
const noteCard = (page: Page, text: string): Locator => noteCards(page).filter({ hasText: text }).first();
const noteField = (page: Page): Locator => page.locator('[data-team-note-field] textarea:visible').first();
/** The Note button under the conversation (the toolbar's moves to its More menu when the reader is narrow). */
const noteButton = (page: Page): Locator => page.locator('[data-team-note-button]:visible').first();
/** Any Note button: under the conversation, in the toolbar, in the phone bar. */
const anyNoteButton = (page: Page): Locator => page.locator('[data-team-note-button], [data-team-note-toolbar], [data-team-note-bar]');

/** Right-click a row and wait for its menu. */
async function rowMenu(page: Page, subject: string): Promise<void> {
  const row = emailItem(page, subject).first();
  await row.waitFor({ state: 'visible', timeout: 30000 });
  await expect(async () => {
    await page.keyboard.press('Escape');
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Reply/ }).first().waitFor({ state: 'visible', timeout: 2000 });
  }).toPass({ timeout: 20000 });
}
const filters = (page: Page): Locator => page.locator('[data-testid="team-list-filters"]');
const filterChip = (page: Page, key: 'open' | 'mine' | 'mentions' | 'notes'): Locator => page.locator(`[data-team-filter="${key}"]`);
const toast = (page: Page, text: string | RegExp): Locator => page.locator('.toast-item').filter({ hasText: text });

let browserRef: Browser | null = null;

/** The switch for the tm-team group only, in a scope of the spec's own. */
async function teamPolicy(on: boolean): Promise<void> {
  const admin = await adminContext(browserRef!);
  const current = await getPolicy(admin);
  const scopes = ((current.scopes as Array<Record<string, unknown>> | undefined) ?? []).filter((s) => s.id !== 'tm-team-spec');
  scopes.push({ id: 'tm-team-spec', label: 'TM team (spec)', match: { groups: [TM.team] }, policy: { organisation: { teamMailboxes: { enabled: on } } } });
  await putPolicy(admin, { ...current, scopes });
  await admin.close();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300000);
  browserRef = browser;
  if (!PASSWORD || !process.env.IT_ADMIN_PASSWORD) throw new Error('Use team-mailboxes-rig/scripts/run-spec.sh');
  const users = (process.env.IT_ACCOUNT_USERS ?? '').split(',');
  if (users.some((u) => !u.startsWith('tm-'))) throw new Error('IT_ACCOUNT_USERS must name tm-* accounts only');

  const admin = await adminContext(browser);
  original = await getPolicy(admin);
  await admin.close();
  await teamPolicy(true);

  await createMessage(TM.alice, TM.team, NOTED);
  await createMessage(TM.alice, TM.team, ASSIGNED);
  await createMessage(TM.alice, TM.alice, OWN);
  await createMessage(TM.other, TM.team2, TEAM2);

  // tm-reader may read the team's Inbox, and its notes once they exist.
  readerId = (await connect(TM.reader)).accountId;
  const alice = await connect(TM.alice);
  const accountId = alice.accountIdByName(TM.team);
  const inbox = await alice.mailboxByRole('inbox', accountId);
  const folder = await notesFolderId(alice, accountId);
  for (const id of [inbox!.id, ...(folder ? [folder] : [])]) {
    const r = await alice.request([['Mailbox/set', { accountId, update: { [id]: { [`shareWith/${readerId}`]: { mayReadItems: true } } } }, '0']]);
    if (r.methodResponses?.[0]?.[1]?.updated?.[id] === undefined) throw new Error(`could not share ${id} with tm-reader: ${JSON.stringify(r.methodResponses?.[0])}`);
    sharedWithReader.push(id);
  }
});

test.afterAll(async () => {
  test.setTimeout(180000);
  // IT_TM_KEEP=1 leaves the run's messages and notes for a look (delete them after).
  if (process.env.IT_TM_KEEP === '1') return;
  const alice = await connect(TM.alice).catch(() => null);
  if (alice) {
    const accountId = alice.accountIdByName(TM.team);
    const notes = [...await notesOn(NOTED), ...await notesOn(ASSIGNED)].map((n) => n.id);
    if (notes.length > 0) await alice.request([['Email/set', { accountId, destroy: notes }, '0']]).catch(() => {});
    const folder = await notesFolderId(alice, accountId);
    const ids = new Set([...sharedWithReader, ...(folder ? [folder] : [])]);
    for (const id of ids) {
      await alice.request([['Mailbox/set', { accountId, update: { [id]: { [`shareWith/${readerId}`]: null } } }, '0']]).catch(() => {});
    }
  }
  for (const entry of created) {
    const client = await connect(entry.account);
    await client.request([['Email/set', { accountId: entry.accountId, destroy: [entry.id] }, '0']]).catch(() => {});
  }
  if (original && browserRef) {
    const admin = await adminContext(browserRef);
    await putPolicy(admin, original);
    await admin.close();
  }
  console.log(`team mailboxes spec ran on ${SERVER}`);
});

test('bob adds a note in one click: Enter sends, Shift+Enter makes a new line, Escape closes and keeps the draft', async ({ browser }) => {
  const bob = await userPage(browser, TM.bob);
  await openTeamMessage(bob, NOTED);
  await expect(noteButton(bob)).toBeVisible({ timeout: 30000 });

  // Escape closes the field, nothing is written, the text waits for later.
  await noteButton(bob).click();
  await expect(noteField(bob)).toBeFocused();
  await noteField(bob).fill('not this one');
  await noteField(bob).press('Escape');
  await expect(noteField(bob)).toHaveCount(0);
  await expect(noteButton(bob)).toBeFocused();

  await noteButton(bob).click();
  await expect(noteField(bob)).toHaveValue('not this one');
  await noteField(bob).fill('');
  await noteField(bob).pressSequentially('Bob checked');
  await noteField(bob).press('Shift+Enter');
  await noteField(bob).pressSequentially(`the invoice ${RUN}`);
  await expect(noteField(bob)).toHaveValue(`Bob checked\nthe invoice ${RUN}`);
  await noteField(bob).fill(BOB_NOTE);
  await noteField(bob).press('Enter');

  const card = noteCard(bob, BOB_NOTE);
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(bob.locator('[data-team-only]:visible').first()).toHaveText(/Only your team sees this/);
  await expect(bob.locator('[data-team-note-pending]')).toHaveCount(0, { timeout: 30000 });
  await expect.poll(async () => (await notesOn(NOTED)).length, { timeout: 30000 }).toBe(1);
  expect(await notesOn('not this one')).toHaveLength(0);
  await shot(bob, 'team-note-card');
  await bob.context().close();
});

test('alice sees the note, mentions bob, bob sees it live and is told, carol is not', async ({ browser }) => {
  const bob = await userPage(browser, TM.bob);
  await openTeamMessage(bob, NOTED);
  await expect(noteCard(bob, BOB_NOTE)).toBeVisible({ timeout: 30000 });
  const carol = await userPage(browser, TM.carol);
  await openTeamFolder(carol);

  const alice = await userPage(browser, TM.alice);
  await openTeamFolder(alice);
  // On the first visit, notes from before count as seen.
  const row = emailItem(alice, NOTED).first();
  await expect(row.locator('[data-team-row-notes="1"]')).toBeVisible({ timeout: 30000 });
  await expect(row.locator('[data-team-row-unseen]')).toHaveCount(0);

  // Bob writes another: alice's row counts it and marks it new, live.
  await noteButton(bob).click();
  await noteField(bob).fill(BOB_NOTE2);
  await noteField(bob).press('Enter');
  await expect(noteCard(bob, BOB_NOTE2)).toBeVisible({ timeout: 30000 });
  await expect(row.locator('[data-team-row-notes="2"]')).toBeVisible({ timeout: 60000 });
  await expect(row.locator('[data-team-row-unseen]')).toBeVisible();
  await shot(alice, 'team-row-new-note');
  await openRow(row);
  await expect(noteCard(alice, BOB_NOTE2)).toBeVisible({ timeout: 30000 });
  await expect(row.locator('[data-team-row-unseen]')).toHaveCount(0, { timeout: 20000 });
  await expect(noteCard(alice, BOB_NOTE)).toBeVisible({ timeout: 30000 });
  await expect(noteCard(alice, BOB_NOTE)).toHaveAttribute('aria-label', /^Note from Bob/);
  // Nobody deletes another member's note.
  await expect(noteCard(alice, BOB_NOTE).getByRole('button', { name: 'Delete note' })).toHaveCount(0);

  await noteButton(alice).click();
  await noteField(alice).pressSequentially('@Bo');
  const people = alice.getByRole('listbox', { name: 'People in this team' });
  await expect(people).toBeVisible({ timeout: 20000 });
  await people.getByRole('option').filter({ hasText: /Bob Baker|tm-bob/ }).first().click();
  await noteField(alice).pressSequentially(ALICE_NOTE);
  await shot(alice, 'team-note-mention');
  await noteField(alice).press('Enter');
  await expect(noteCard(alice, ALICE_NOTE)).toBeVisible({ timeout: 30000 });
  await expect(noteCard(alice, ALICE_NOTE).getByRole('link', { name: /Bob/ }).or(noteCard(alice, ALICE_NOTE).getByText(/@Bob/))).toBeVisible();

  // Bob has the message open: the note arrives, and he is told.
  await expect(noteCard(bob, ALICE_NOTE)).toBeVisible({ timeout: 60000 });
  await expect(toast(bob, /mentioned you in/)).toBeVisible({ timeout: 60000 });
  await shot(bob, 'team-mention-toast');
  // Carol, signed in the whole time, is not told.
  await bob.waitForTimeout(5000);
  await expect(toast(carol, /mentioned you/)).toHaveCount(0);
  const notes = await notesOn(NOTED);
  expect(notes).toHaveLength(3);
  expect(notes.some((n) => Object.keys(n.keywords).some((k) => k.startsWith('$bulwark-mention-')))).toBe(true);
  await Promise.all([alice, bob, carol].map((p) => p.context().close()));
});

test('alice deletes her own note and Undo brings it back', async ({ browser }) => {
  const alice = await userPage(browser, TM.alice);
  await openTeamMessage(alice, NOTED);
  const card = noteCard(alice, ALICE_NOTE);
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.hover();
  await card.getByRole('button', { name: 'Delete note' }).click();
  await expect(noteCards(alice).filter({ hasText: ALICE_NOTE })).toHaveCount(0, { timeout: 20000 });
  const undo = toast(alice, 'Note deleted').getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible({ timeout: 20000 });
  await undo.click();
  await expect(noteCard(alice, ALICE_NOTE)).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => (await notesOn(NOTED)).length, { timeout: 30000 }).toBe(3);
  await alice.context().close();
});

test('alice assigns a message to bob; bob finds it, marks it done and reopens it', async ({ browser }) => {
  const alice = await userPage(browser, TM.alice);
  await openTeamMessage(alice, ASSIGNED);
  await rowMenu(alice, ASSIGNED);
  await alice.getByRole('menuitem', { name: 'Assign to…' }).click();
  const dialog = alice.getByTestId('team-assign-dialog');
  await expect(dialog).toBeVisible({ timeout: 20000 });
  await dialog.getByRole('combobox', { name: 'Name or address' }).fill('bob');
  // A real directory has more than one Bob: pick the team's by address.
  const bobOption = dialog.getByRole('option').filter({ hasText: TM.bob }).first();
  await expect(bobOption).toBeVisible({ timeout: 20000 });
  await shot(alice, 'team-assign-dialog');
  await bobOption.click();
  await expect(dialog).toHaveCount(0);
  const bobId = (await connect(TM.bob)).accountId;
  await expect.poll(() => keywordsOf(ASSIGNED), { timeout: 30000 }).toContain(`$assigned:${bobId}`);
  await expect(emailItem(alice, ASSIGNED).first().getByTestId('team-assignee-chip')).toBeVisible({ timeout: 30000 });
  await openRow(emailItem(alice, ASSIGNED).first());
  await expect(alice.locator('[data-team-timeline]:visible').filter({ hasText: /assigned this to Bob/ })).toBeVisible({ timeout: 30000 });
  await shot(alice, 'team-assigned-timeline');
  await alice.context().close();

  const bob = await userPage(browser, TM.bob);
  await openTeamFolder(bob);
  await expect(filters(bob)).toBeVisible({ timeout: 30000 });
  await filterChip(bob, 'mine').click();
  await expect(filterChip(bob, 'mine')).toHaveAttribute('aria-pressed', 'true');
  await expect(emailItem(bob, ASSIGNED).first()).toBeVisible({ timeout: 30000 });
  await expect(emailItem(bob, NOTED)).toHaveCount(0);
  await shot(bob, 'team-filter-mine');

  await rowMenu(bob, ASSIGNED);
  await bob.getByRole('menuitem', { name: 'Mark done' }).click();
  await expect.poll(() => keywordsOf(ASSIGNED), { timeout: 30000 }).toContain('$done');
  await expect(emailItem(bob, ASSIGNED).first().getByTestId('team-done-mark')).toBeVisible({ timeout: 30000 });

  await filterChip(bob, 'open').click();
  await expect(emailItem(bob, ASSIGNED)).toHaveCount(0, { timeout: 30000 });
  await filterChip(bob, 'open').click();
  await expect(emailItem(bob, ASSIGNED).first()).toBeVisible({ timeout: 30000 });

  await rowMenu(bob, ASSIGNED);
  await bob.getByRole('menuitem', { name: 'Reopen' }).click();
  await expect.poll(() => keywordsOf(ASSIGNED), { timeout: 30000 }).not.toContain('$done');

  // Mentions me and With notes find the noted message, not this one.
  await filterChip(bob, 'mentions').click();
  await expect(emailItem(bob, NOTED).first()).toBeVisible({ timeout: 30000 });
  await expect(emailItem(bob, ASSIGNED)).toHaveCount(0);
  await filterChip(bob, 'notes').click();
  await expect(filterChip(bob, 'mentions')).toHaveAttribute('aria-pressed', 'false');
  await expect(emailItem(bob, NOTED).first()).toBeVisible({ timeout: 30000 });
  await filterChip(bob, 'notes').click();
  await bob.context().close();
});

test('the notes folder shows up nowhere: not in the folder list, not in search', async ({ browser }) => {
  const alice = await userPage(browser, TM.alice);
  await expandSharedFolders(alice, TM.team);
  await expect(folderRow(alice, { role: 'inbox', shared: true }).first()).toBeVisible();
  await expect(folderRow(alice, { name: 'Team notes' })).toHaveCount(0);
  await expect(alice.locator('[data-testid="folder-row"]', { hasText: 'Team notes' })).toHaveCount(0);

  const search = alice.locator('[data-tour="search-input"]:visible').first();
  await search.fill(RUN);
  await search.press('Enter');
  await expect(emailItem(alice, NOTED).first()).toBeVisible({ timeout: 30000 });
  await expect(alice.locator(`[data-testid="email-list-item"][data-subject^="Note: "]`)).toHaveCount(0);
  await alice.context().close();
});

test('a member with read-only rights sees the notes and is told why there is no Note button', async ({ browser }) => {
  const reader = await userPage(browser, TM.reader);
  await openTeamMessage(reader, NOTED);
  await expect(noteCard(reader, BOB_NOTE)).toBeVisible({ timeout: 30000 });
  await expect(noteCard(reader, ALICE_NOTE)).toBeVisible();
  await expect(reader.locator('[data-team-note-area]').getByText('You can read notes here but not write them.')).toBeVisible();
  await expect(anyNoteButton(reader)).toHaveCount(0);
  await rowMenu(reader, NOTED);
  await expect(reader.getByRole('menuitem', { name: 'Assign to me' })).toHaveCount(0);
  await expect(reader.getByRole('menuitem', { name: 'Note' })).toHaveCount(0);
  await reader.keyboard.press('Escape');
  await shot(reader, 'team-read-only');
  await reader.context().close();
});

test('own mail and a group without the switch get nothing', async ({ browser }) => {
  const alice = await userPage(browser, TM.alice);
  await folderRow(alice, { role: 'inbox', shared: false }).first().click();
  await openRow(emailItem(alice, OWN).first());
  await expect(alice.getByText(`A message for the team mailboxes spec (${RUN}).`).first()).toBeVisible({ timeout: 30000 });
  await expect(anyNoteButton(alice)).toHaveCount(0);
  await expect(filters(alice)).toHaveCount(0);
  await rowMenu(alice, OWN);
  await expect(alice.getByRole('menuitem', { name: 'Assign to me' })).toHaveCount(0);
  await alice.keyboard.press('Escape');
  await alice.context().close();

  const other = await userPage(browser, TM.other);
  await openTeamMessage(other, TEAM2, TM.team2);
  await expect(other.getByText(`A message for the team mailboxes spec (${RUN}).`).first()).toBeVisible({ timeout: 30000 });
  await expect(anyNoteButton(other)).toHaveCount(0);
  await expect(filters(other)).toHaveCount(0);
  await rowMenu(other, TEAM2);
  await expect(other.getByRole('menuitem', { name: 'Assign to me' })).toHaveCount(0);
  await other.keyboard.press('Escape');
  await other.context().close();
});

test('on a phone the Note button, the field and the filters fit 390 px', async ({ browser }) => {
  const bob = await userPage(browser, TM.bob, true);
  await bob.locator('[data-mobile-mail-header] button').first().click();
  await openTeamFolder(bob);
  await expect(filters(bob)).toBeVisible({ timeout: 30000 });
  for (const chip of await filters(bob).getByRole('button').all()) {
    const box = await chip.boundingBox();
    if (!box) continue;
    // The row scrolls sideways; each chip is whole and the page doesn't scroll.
    expect(box.width).toBeGreaterThan(0);
  }
  expect(await bob.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(bob, 'team-phone-list');

  await openRow(emailItem(bob, NOTED).first());
  await expect(noteCard(bob, BOB_NOTE)).toBeVisible({ timeout: 30000 });
  await bob.locator('[data-team-note-bar]:visible').first().click();
  await expect(noteField(bob)).toBeVisible();
  const box = await noteField(bob).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390.5);
  expect(await bob.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(bob, 'team-phone-note');
  await noteField(bob).press('Escape');
  await bob.context().close();
});

test('with the switch off, team mailboxes look as before', async ({ browser }) => {
  await teamPolicy(false);
  try {
    const bob = await userPage(browser, TM.bob);
    await openTeamMessage(bob, NOTED);
    await expect(bob.getByText(`A message for the team mailboxes spec (${RUN}).`).first()).toBeVisible({ timeout: 30000 });
    await expect(anyNoteButton(bob)).toHaveCount(0);
    await expect(noteCards(bob)).toHaveCount(0);
    await expect(filters(bob)).toHaveCount(0);
    await rowMenu(bob, NOTED);
    await expect(bob.getByRole('menuitem', { name: 'Assign to me' })).toHaveCount(0);
    await bob.keyboard.press('Escape');
    await bob.context().close();
  } finally {
    await teamPolicy(true);
  }
});
