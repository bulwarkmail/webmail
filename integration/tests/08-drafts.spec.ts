import { test, expect } from '@playwright/test';
import { ACCOUNTS } from './helpers/config';
import { JmapClient } from './helpers/jmap';
import {
  login,
  openComposer,
  addRecipient,
  setFrom,
  setSubject,
  waitDraftSaved,
  closeComposer,
  composerRecipients,
  openFolder,
  emailItem,
} from './helpers/app';

/**
 * Draft handling. Focus areas reported as flaky by the user:
 *  - the "continue draft" (edit-draft) button in the message view,
 *  - multiple recipients being persisted to the draft,
 *  - a changed sender identity being persisted to the draft.
 *
 * Each test drives the composer, lets it auto-save, then verifies the draft on
 * the server (JMAP) and by reopening it in the UI.
 */
const { alice, bob, carol } = ACCOUNTS;
const subj = (l: string) => `IT ${l} ${Date.now()}`;

async function draftBody(page: import('@playwright/test').Page, text: string) {
  await page.locator('.ProseMirror').first().fill(text);
}

test.describe('Drafts', () => {
  let jmap: JmapClient;

  test.beforeEach(async () => {
    jmap = await JmapClient.connect(alice.email, alice.password);
    await jmap.reset();
  });

  test('multiple recipients save and reopen via the continue-draft button', async ({ page }) => {
    const subject = subj('draft-multi');
    await login(page, alice);

    await openComposer(page);
    await addRecipient(page, bob.email);
    await addRecipient(page, carol.email);
    await setSubject(page, subject);
    await draftBody(page, 'draft body');
    await waitDraftSaved(page);
    await closeComposer(page);

    // Server: the draft carries BOTH recipients.
    const drafts = await jmap.mailboxByRole('drafts');
    const draft = await jmap.waitForEmail(subject, { mailboxId: drafts!.id });
    const to = (draft.to ?? []).map((r: { email: string }) => r.email).sort();
    expect(to).toEqual([bob.email, carol.email].sort());

    // UI: opening the draft shows the continue-draft button, which reopens the
    // composer with both recipients intact.
    await openFolder(page, { role: 'drafts' });
    await emailItem(page, subject).first().click();
    await page.locator('[data-testid="edit-draft"]').click();
    await page.locator('[data-testid="email-composer"]').waitFor({ state: 'visible' });
    const recips = await composerRecipients(page);
    expect(recips).toContain(bob.email);
    expect(recips).toContain(carol.email);
  });

  test('a recipient typed but not committed to a chip is still saved', async ({ page }) => {
    const subject = subj('draft-uncommitted');
    await login(page, alice);

    await openComposer(page);
    await addRecipient(page, bob.email); // committed chip
    // Type a second address but do NOT press Enter — leave it as raw input.
    const input = page.locator('[data-testid="composer-to"] input').first();
    await input.click();
    await input.fill(carol.email);
    await setSubject(page, subject); // blur the To field
    await draftBody(page, 'uncommitted body');
    await waitDraftSaved(page);
    await closeComposer(page);

    const drafts = await jmap.mailboxByRole('drafts');
    const draft = await jmap.waitForEmail(subject, { mailboxId: drafts!.id });
    const to = (draft.to ?? []).map((r: { email: string }) => r.email).sort();
    // Both the committed and the still-in-the-input recipient must survive.
    expect(to).toEqual([bob.email, carol.email].sort());
  });

  test('a server-created draft shows the continue-draft button when viewed', async ({ page }) => {
    const subject = subj('draft-server');
    await jmap.createDraft(subject, bob.email);

    await login(page, alice);
    await openFolder(page, { role: 'drafts' });
    await emailItem(page, subject).first().click();

    // The edit-draft ("continue draft") button must be present for any message
    // carrying the $draft keyword, regardless of how the draft was created.
    await expect(page.locator('[data-testid="edit-draft"]')).toBeVisible();
  });

  test('a changed sender identity is saved to the draft (server)', async ({ page }) => {
    const altId = await jmap.ensureIdentity('Alice Team', alice.email);
    const subject = subj('draft-from');

    await login(page, alice);
    await openComposer(page);
    await setFrom(page, altId);
    await addRecipient(page, bob.email);
    await setSubject(page, subject);
    await draftBody(page, 'from-change body');
    await waitDraftSaved(page);
    await closeComposer(page);

    const drafts = await jmap.mailboxByRole('drafts');
    const draft = await jmap.waitForEmail(subject, { mailboxId: drafts!.id });
    expect((draft.from ?? [])[0]?.name, 'draft From carries the selected identity').toBe('Alice Team');
  });

  // Regression: reopening a draft must restore the identity it was written with
  // (drafts store the From address+name, not an identity id, so the reopen path
  // matches name+address against the identity list — see findDraftIdentityId).
  test('reopening a draft restores the changed sender in the From selector', async ({ page }) => {
    const altId = await jmap.ensureIdentity('Alice Team', alice.email);
    const subject = subj('draft-from-reopen');

    await login(page, alice);
    await openComposer(page);
    await setFrom(page, altId);
    await addRecipient(page, bob.email);
    await setSubject(page, subject);
    await draftBody(page, 'reopen body');
    await waitDraftSaved(page);
    await closeComposer(page);

    await openFolder(page, { role: 'drafts' });
    await emailItem(page, subject).first().click();
    await page.locator('[data-testid="edit-draft"]').click();
    await expect(page.locator('[data-testid="composer-from"]')).toHaveValue(altId);
  });
});
