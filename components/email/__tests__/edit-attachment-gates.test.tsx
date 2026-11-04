import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { PHISHING_KEYWORD } from '@/lib/phishing-report';

// Where a message's attachment gets Edit, on the real components with the real check. Only
// the organisation's answer is stood in for: whether it has spoken, which needs a server.

vi.mock('@/lib/offline/offline-mode', async (original) => ({
  ...(await original<typeof import('@/lib/offline/offline-mode')>()),
  scopeDecided: () => true,
}));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { ThreadConversationView } = await import('../thread-conversation-view');
const { useAuthStore } = await import('@/stores/auth-store');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];

const part = (over: Record<string, unknown> = {}) => ({ partId: '2', blobId: 'blob-1', name: 'report.docx', type: 'application/octet-stream', size: 10, disposition: 'attachment', ...over });

function makeEmail(attachment: Record<string, unknown>, keywords: Record<string, boolean> = { $seen: true }): Email {
  return {
    id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords,
    from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: true, size: 100,
    textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }],
    attachments: [attachment], bodyValues: { 1: { value: 'Hello' } },
  } as unknown as Email;
}

/** Answers anything the views ask of a client with nothing. */
const fakeClient = new Proxy({}, { get: (_target, name) => (name === 'then' ? undefined : () => undefined) });

let popup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  popup = vi.fn(async () => null);
  window.bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    menu: { setState: () => {}, popup },
    // The shell's list, for the ones used here.
    edit: { canEdit: (name: string) => /\.(docx|txt)$/.test(name), list: async () => [], onChange: () => () => {} },
  } as never;
  useAuthStore.setState({ activeAccountId: 'acct', client: fakeClient } as never);
});

afterEach(() => {
  cleanup();
  window.bulwarkDesktop = undefined;
  useAuthStore.setState({ activeAccountId: null, client: null } as never);
});

async function viewerMenu(email: Email): Promise<(string | undefined)[]> {
  render(<EmailViewer email={email} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" onArchive={vi.fn()} onDelete={vi.fn()} />);
  const tile = await screen.findByTestId('attachment');
  fireEvent.contextMenu(tile.parentElement ?? tile, { clientX: 5, clientY: 5 });
  await waitFor(() => expect(popup).toHaveBeenCalled());
  return (popup.mock.calls[0][0] as { label?: string }[]).map((item) => item.label);
}

describe('the reader', () => {
  it('offers Edit on a part with a blob', async () => {
    expect(await viewerMenu(makeEmail(part()))).toContain('edit');
  });

  it('has none on a message marked as phishing', async () => {
    expect(await viewerMenu(makeEmail(part(), { $seen: true, [PHISHING_KEYWORD]: true }))).not.toContain('edit');
  });

  it('has none on a part with no blob, which is how a decrypted part reaches it', async () => {
    expect(await viewerMenu(makeEmail(part({ blobId: '', tnefData: new Uint8Array([1]) })))).not.toContain('edit');
  });

  it('has none for a file the shell keeps out', async () => {
    expect(await viewerMenu(makeEmail(part({ name: 'run.bat' })))).not.toContain('edit');
  });
});

function conversation(email: Email) {
  render(
    <ThreadConversationView
      thread={{ threadId: 't1', emails: [email], latestEmail: email } as never}
      emails={[email] as never}
      onBack={() => {}}
    />,
  );
}

describe('the conversation view', () => {
  const edit = () => screen.queryByRole('button', { name: 'desktopEdit.edit_named' });

  it('offers Edit on a part with a blob', async () => {
    conversation(makeEmail(part()));
    await waitFor(() => expect(edit()).not.toBeNull());
  });

  it('has none on a message marked as phishing', async () => {
    conversation(makeEmail(part(), { $seen: true, [PHISHING_KEYWORD]: true }));
    await screen.findByText(/report\.docx/);
    expect(edit()).toBeNull();
  });

  it('has none on a part with no blob', async () => {
    conversation(makeEmail(part({ blobId: '' })));
    await screen.findByText(/report\.docx/);
    expect(edit()).toBeNull();
  });

  it('has none for a file the shell keeps out', async () => {
    conversation(makeEmail(part({ name: 'run.bat' })));
    await screen.findByText(/run\.bat/);
    expect(edit()).toBeNull();
  });

  it('has none in a browser', async () => {
    window.bulwarkDesktop = undefined;
    conversation(makeEmail(part()));
    await screen.findByText(/report\.docx/);
    expect(edit()).toBeNull();
  });
});
