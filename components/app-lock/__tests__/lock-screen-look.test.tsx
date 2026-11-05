import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockScreen } from '../lock-screen';
import { createVault, deleteVault } from '@/lib/app-lock/vault';
import { useEmailStore } from '@/stores/email-store';
import { useAccountStore } from '@/stores/account-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { AccountEntry } from '@/stores/account-store';

vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));

const helloState = vi.hoisted(() => vi.fn());
vi.mock('@/lib/app-lock/controller', async (original) => ({
  ...(await original<typeof import('@/lib/app-lock/controller')>()),
  helloState,
}));

const CSS = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
const LOCK_CSS = readFileSync(join(process.cwd(), 'app/app-lock.css'), 'utf8');

/** The body of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf('}', at));
}

/** The selector list of the rule that keeps what's clickable out of the window's drag. */
function noDragSelector(): string {
  const head = 'html[data-window-controls] :is(';
  const end = CSS.indexOf('[draggable="true"]');
  const start = CSS.lastIndexOf(head, end);
  expect(start).toBeGreaterThanOrEqual(0);
  const close = CSS.indexOf(') {', end);
  expect(CSS.slice(close, close + 40)).toMatch(/^\) \{\s*app-region: no-drag;/);
  return CSS.slice(start + head.length, close).replace(/\s+/g, ' ').trim();
}

const SUBJECT = 'Quarterly numbers for Rosalind';
const SENDER = 'Bartholomew Quince';
const FOLDER = 'Project Larkspur';
const ACCOUNT = 'alice.lockscreen@example.org';

beforeEach(async () => {
  await deleteVault();
  localStorage.clear();
  helloState.mockReset();
  helloState.mockResolvedValue({ shown: false, on: false });
  (await createVault('correct-pin')).fill(0);
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  useEmailStore.setState({ emails: [], mailboxes: [] });
  useAccountStore.setState({ accounts: [] });
});

describe('the lock screen in a window with no title bar', () => {
  it('draws the window\'s drag band over the top row, before the card, with nothing to click in it', () => {
    render(<LockScreen phase="locked" />);
    const overlay = screen.getByRole('dialog');
    const band = overlay.querySelector('[data-window-drag-band]');
    expect(band).not.toBeNull();
    expect(band!.children).toHaveLength(0);
    expect(band).toHaveAttribute('aria-hidden', 'true');
    // Before every field and button, so each of them cuts itself out of the band.
    const clickable = Array.from(overlay.querySelectorAll('input, button, a[href]'));
    expect(clickable.length).toBeGreaterThan(1);
    for (const el of clickable) {
      expect(band!.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('drags by that band over the controls\' row, and keeps every field and button out of it', () => {
    const band = ruleBody(CSS, '[data-window-drag-band]');
    expect(band).toMatch(/-webkit-app-region: drag;/);
    expect(band).toMatch(/height: var\(--titlebar-row-height\);/);
    expect(band).toMatch(/top: 0;/);
    // The overlay is fixed and a dialog: no-drag over the whole window. The band is neither.
    render(<LockScreen phase="locked" />);
    const overlay = screen.getByRole('dialog');
    const bandEl = overlay.querySelector('[data-window-drag-band]')!;
    expect(bandEl.matches('.fixed, [role="dialog"]')).toBe(false);
    const noDrag = `:is(${noDragSelector()})`;
    expect(bandEl.matches(noDrag)).toBe(false);
    for (const el of Array.from(overlay.querySelectorAll('input, button'))) {
      expect(el.matches(noDrag), el.outerHTML.slice(0, 80)).toBe(true);
    }
  });

  it('draws no band of its own under the desktop menu bar, which is the row then', () => {
    expect(CSS).toMatch(/html:has\(\[data-window-menu-bar\]\) \[data-window-drag-band\] \{\s*display: none;/);
  });

  it('the crash page draws the band too: nothing marks a row there', () => {
    const page = readFileSync(join(process.cwd(), 'app/global-error.tsx'), 'utf8');
    expect(page).toMatch(/<body[^>]*>\s*\{\/\*[^*]*\*\/\}\s*<div aria-hidden="true" data-window-drag-band="" \/>/);
  });
});

describe('the app\'s skeleton behind the lock card', () => {
  beforeEach(() => {
    useEmailStore.setState({
      emails: [{ id: 'e1', threadId: 't1', subject: SUBJECT, from: [{ name: SENDER, email: 'bq@example.org' }], preview: `About ${SUBJECT}` } as unknown as Email],
      mailboxes: [{ id: 'm1', name: FOLDER, role: undefined, totalEmails: 42, unreadEmails: 7 } as unknown as Mailbox],
    });
    useAccountStore.setState({ accounts: [{ id: `${ACCOUNT}@x`, label: ACCOUNT, username: ACCOUNT } as unknown as AccountEntry] });
  });

  it('draws the mail page\'s shapes behind the card, hidden from assistive tech and out of reach', () => {
    render(<LockScreen phase="locked" />);
    const overlay = screen.getByRole('dialog');
    const backdrop = overlay.querySelector('[data-app-lock-backdrop]');
    expect(backdrop).not.toBeNull();
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
    expect(backdrop).toHaveAttribute('inert');
    expect(backdrop!.querySelectorAll('.sk-shape').length).toBeGreaterThan(20);
    // Behind: first in the overlay, before the band and the card.
    const card = overlay.querySelector('[data-app-lock-card]')!;
    expect(card).toContainElement(screen.getByTestId('app-lock-pin'));
    expect(backdrop!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(backdrop!.contains(card)).toBe(false);
    // Not the boot skeleton's root: no status message and no mark the probes count.
    expect(backdrop!.querySelector('[role="status"], [data-boot-skeleton]')).toBeNull();
  });

  it('holds no text at all, and nothing of the mail, the folders or the account the app has', () => {
    // The app as it would sit under the lock, hidden.
    const app = document.createElement('div');
    app.textContent = `${FOLDER} 7 ${SUBJECT} ${SENDER} ${ACCOUNT}`;
    document.body.appendChild(app);
    try {
      render(<LockScreen phase="locked" />);
      const overlay = screen.getByRole('dialog');
      const backdrop = overlay.querySelector('[data-app-lock-backdrop]')!;
      // Shapes and icons only: the search field's "/" key hint is all the text there is.
      expect(backdrop.textContent).not.toMatch(/[\p{L}\p{N}]/u);
      expect(backdrop.querySelectorAll('img, [style*="background-image"]')).toHaveLength(0);
      for (const text of [SUBJECT, SENDER, FOLDER, ACCOUNT]) {
        expect(overlay.textContent).not.toContain(text);
        expect(overlay.innerHTML).not.toContain(text);
      }
      // The counts: no number anywhere in what it says (sizes in its markup are only sizes).
      expect(overlay.textContent).not.toMatch(/\d/);
    } finally {
      app.remove();
    }
  });

  it('is not drawn in a pop-out, which isn\'t the mail page', () => {
    window.history.replaceState(null, '', '/en/popout/compose');
    render(<LockScreen phase="locked" />);
    expect(screen.getByRole('dialog').querySelector('[data-app-lock-backdrop]')).toBeNull();
    expect(screen.getByRole('dialog').querySelector('[data-window-drag-band]')).not.toBeNull();
  });

  it('stands still, and goes for the plain background with more contrast or forced colours', () => {
    expect(ruleBody(LOCK_CSS, '[data-app-lock-backdrop] .sk-shape')).toMatch(/animation: none;/);
    expect(ruleBody(LOCK_CSS, ':root[data-contrast="more"] [data-app-lock-backdrop]')).toMatch(/display: none;/);
    expect(LOCK_CSS).toMatch(/@media \(prefers-contrast: more\) \{\s*:root:not\(\[data-contrast="normal"\]\) \[data-app-lock-backdrop\] \{\s*display: none;/);
    expect(LOCK_CSS).toMatch(/@media \(forced-colors: active\) \{\s*\[data-app-lock-backdrop\] \{\s*display: none;/);
  });
});
