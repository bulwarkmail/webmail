// A grouped conversation had no way to print one of its messages: Print sat
// only in the reader's toolbar and printed the open message, and Ctrl+P did
// the same whichever message the user was reading. Each message now has its
// own ⋮ with Print, and Ctrl+P prints the message that has the focus.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsMobile: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');
const { ThreadConversationView } = await import('../thread-conversation-view');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function mail(n: number, text: string, overrides: Partial<Email> = {}): Email {
  return {
    id: `m${n}`, blobId: `b${n}`, threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: `Sender ${n}`, email: `s${n}@example.com` }], to: [{ name: 'Me', email: 'me@example.com' }],
    subject: `Offsite agenda ${n}`, receivedAt: `2026-01-0${n}T10:00:00Z`, preview: text,
    hasAttachment: false, size: 100,
    textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], attachments: [],
    bodyValues: { '1': { value: text, isTruncated: false } },
    ...overrides,
  } as unknown as Email;
}

// Older message unread, so it opens unfolded; the newest is the open one.
const older = () => mail(1, 'First body', { keywords: {} });
const newest = () => mail(2, 'Newest body');

function renderPane() {
  const open = newest();
  return render(
    <EmailViewer
      email={open}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      mvConversation={[older(), open]}
      conversationPane
    />,
  );
}

function capturePopup() {
  let written = '';
  const popup = {
    opener: window as Window | null,
    document: { write: (html: string) => { written += html; }, close: () => {} },
    focus: vi.fn(),
    print: vi.fn(),
  };
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
  return { popup, html: () => written };
}

function printCopy(): HTMLElement | null {
  return document.body.querySelector(':scope > [data-print-root]');
}
function printedBody(): string {
  return printCopy()?.querySelector('[data-message-print-body]')?.shadowRoot?.innerHTML ?? '';
}

beforeEach(() => {
  useSettingsStore.setState({ interfaceLayout: 'default', markAsReadDelay: -1 });
  // jsdom lays nothing out; the reader asks whether it is on screen.
  (HTMLElement.prototype as unknown as { checkVisibility: () => boolean }).checkVisibility = () => true;
});

afterEach(() => {
  act(() => { window.dispatchEvent(new Event('afterprint')); });
  delete (HTMLElement.prototype as unknown as { checkVisibility?: unknown }).checkVisibility;
  vi.restoreAllMocks();
});

describe('printing one message of a conversation', () => {
  it("offers Print in the message's own ⋮ and prints only that message", () => {
    const { container } = renderPane();
    const card = container.querySelector<HTMLElement>('[data-mv-conversation-expanded][data-email-id="m1"]')!;
    expect(card).not.toBeNull();
    const { popup, html } = capturePopup();

    fireEvent.click(within(card).getByRole('button', { name: 'more_actions' }));
    fireEvent.click(screen.getByTestId('conversation-message-print'));

    expect(popup.print).toHaveBeenCalledTimes(1);
    const page = html();
    expect(page).toContain('Offsite agenda 1');
    expect(page).toContain('Sender 1');
    expect(page).toContain('First body');
    expect(page).not.toContain('Newest body');
    expect(page).not.toContain('Offsite agenda 2');
  }, 30_000);

  it('prints the focused message on Ctrl+P, and the open one otherwise', () => {
    const { container } = renderPane();

    // Nothing in the conversation has the focus: the open message, as before.
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(printedBody()).toContain('Newest body');
    act(() => { window.dispatchEvent(new Event('afterprint')); });

    // A click in the older message gives it the focus.
    const card = container.querySelector<HTMLElement>('[data-mv-conversation-expanded][data-email-id="m1"]')!;
    act(() => { card.focus(); });
    expect(document.activeElement).toBe(card);
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(printCopy()!.querySelector('.pr-title')!.textContent).toBe('Offsite agenda 1');
    expect(printedBody()).toContain('First body');
    expect(printedBody()).not.toContain('Newest body');
  }, 30_000);

  it('works the same in the phone conversation view', () => {
    const emails = [older(), newest()];
    const { container } = render(
      <ThreadConversationView
        thread={{ threadId: 't1', emails, latestEmail: emails[1] } as never}
        emails={emails}
        onBack={() => {}}
      />,
    );
    const card = container.querySelector<HTMLElement>('[data-conversation-message="m1"]')!;
    expect(card).not.toBeNull();

    const { popup, html } = capturePopup();
    fireEvent.click(within(card).getByRole('button', { name: 'more_actions' }));
    fireEvent.click(screen.getByTestId('conversation-message-print'));
    expect(popup.print).toHaveBeenCalledTimes(1);
    expect(html()).toContain('First body');
    expect(html()).not.toContain('Newest body');

    act(() => { card.focus(); });
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(printedBody()).toContain('First body');
  }, 30_000);
});
