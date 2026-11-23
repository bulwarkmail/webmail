// A grouped conversation had no way to print one of its messages: Print sat
// only in the reader's toolbar and printed the open message, and Ctrl+P did
// the same whichever message the user was reading. Each message now has its
// own ⋮ with Print, and Ctrl+P prints the message that has the focus.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsMobile: () => false,
}));
// exportOnlyFor: export is allowed for that login alone, off for every other subject.
const noExport = vi.hoisted(() => ({ value: false, noPrint: false, exportOnlyFor: null as string | null }));
vi.mock('@/hooks/use-device-policy', async (load) => ({
  ...await load<typeof import('@/hooks/use-device-policy')>(),
  useDevicePolicy: (subject?: unknown) => ({
    noExport: noExport.exportOnlyFor ? subject !== noExport.exportOnlyFor : noExport.value,
    noPrint: noExport.noPrint,
  }),
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer, MvExpandedConversationCard } = await import('../email-viewer');
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
  noExport.value = false;
  noExport.noPrint = false;
  noExport.exportOnlyFor = null;
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


describe('viewing the source of one conversation message (#1833)', () => {
  const raw = 'Subject: Offsite agenda 1\r\n\r\nFirst body';
  const fetchBlob = vi.fn(async () => new Blob([raw]));
  const downloadBlob = vi.fn(async () => {});
  const blobSource = { client: { fetchBlob, downloadBlob } as unknown as IJMAPClient, accountId: 'shared-owner' };

  function renderThread(phone: boolean, first = older()) {
    const open = newest();
    const emails = [first, open];
    const result = render(phone ? (
      <ThreadConversationView thread={{ threadId: 't1', emails, latestEmail: open } as never}
        emails={emails} onBack={() => {}} blobSource={blobSource} />
    ) : (
      <EmailViewer email={open} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox"
        mvConversation={emails} conversationPane blobSource={blobSource} />
    ));
    const card = result.container.querySelector<HTMLElement>(phone
      ? '[data-conversation-message="m1"]'
      : '[data-mv-conversation-expanded][data-email-id="m1"]')!;
    expect(card).not.toBeNull();
    return card;
  }

  beforeEach(() => {
    fetchBlob.mockClear();
    downloadBlob.mockClear();
  });

  it.each([
    ['default layout', false, 'default'],
    ['Mountain View', false, 'mountain-view'],
    ['phone thread', true, 'default'],
  ] as const)('opens the older message’s own source in %s', async (_, phone, interfaceLayout) => {
    useSettingsStore.setState({ interfaceLayout });
    const activeFetch = vi.fn();
    const oldClient = useAuthStore.getState().client;
    useAuthStore.setState({ client: { fetchBlob: activeFetch, getAccountId: () => 'active', getSieveAccountId: () => null } as unknown as IJMAPClient });
    try {
      const card = renderThread(phone);
      fireEvent.click(within(card).getByRole('button', { name: 'more_actions' }));
      fireEvent.click(screen.getByText('view_source'));
      expect(await screen.findByTestId('email-source')).toHaveTextContent('First body');
      expect(fetchBlob).toHaveBeenCalledExactlyOnceWith('b1', 'message.eml', 'message/rfc822', 'shared-owner');
      expect(activeFetch).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'export_email' }));
      await waitFor(() => expect(downloadBlob).toHaveBeenCalledExactlyOnceWith(
        'b1', expect.stringMatching(/\.eml$/), 'message/rfc822', 'shared-owner', { kind: 'export' },
      ));
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(card).toBeInTheDocument();
    } finally {
      useAuthStore.setState({ client: oldClient });
    }
  }, 30_000);

  it.each(['forbidden export', 'missing message blob'] as const)('does not offer source for %s', (condition) => {
    noExport.value = condition === 'forbidden export';
    const card = renderThread(false, condition === 'missing message blob' ? { ...older(), blobId: undefined } : older());
    fireEvent.click(within(card).getByRole('button', { name: 'more_actions' }));
    expect(screen.getByTestId('conversation-message-print')).toBeInTheDocument();
    expect(screen.queryByText('view_source')).not.toBeInTheDocument();
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it("shows the ⋮ when only the login the message is read through allows its source", () => {
    // The card and its menu must ask the same account: here the message has
    // no stamp, the conversation was read through login-b, and only login-b
    // allows export. With no replies and no Print, the ⋮ holds View source alone.
    noExport.exportOnlyFor = 'login-b';
    noExport.noPrint = true;
    const { container } = render(
      <MvExpandedConversationCard email={older()} timeFormat="24h" onCollapse={() => {}}
        blobSource={{ ...blobSource, clientAccountId: 'login-b' }} />,
    );
    const card = container.querySelector<HTMLElement>('[data-mv-conversation-expanded]')!;
    fireEvent.click(within(card).getByRole('button', { name: 'more_actions' }));
    expect(screen.getByText('view_source')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-message-print')).not.toBeInTheDocument();
  });
});
