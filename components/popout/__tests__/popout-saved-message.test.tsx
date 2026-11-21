import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';

// A message window for an .eml opened from Explorer (desktop-p3-5). The reader is
// stubbed: its saved-file look has tests of its own. The next-intl mock returns the key.

type ViewerProps = {
  email: Email | null;
  savedFile?: boolean;
  noAutomaticActions?: boolean;
  onReply?: (draftText?: string) => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onToggleStar?: () => void;
  onMarkAsRead?: unknown;
  onSetTag?: unknown;
  onMoveToMailbox?: (mailboxId: string) => void;
};
let viewer: ViewerProps | null;

vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: (props: ViewerProps) => {
    viewer = props;
    return <div data-testid="viewer" />;
  },
}));
vi.mock('../popout-shell', () => ({
  PopoutNotice: ({ title, body }: { title: string; body: string }) => <div><h1>{title}</h1><p>{body}</p></div>,
  PopoutSkeleton: () => <div data-testid="skeleton" />,
}));
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));

const { PopoutSavedMessage } = await import('../popout-saved-message');

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState() };
const PARSED = {
  id: 'blob-1',
  blobId: 'blob-1',
  subject: 'From a file',
  from: [{ name: 'Alice', email: 'alice@example.org' }],
  to: [{ email: 'me@example.org' }],
  mailboxIds: {},
  keywords: { $seen: true },
  bodyValues: { 1: { value: 'Hello' } },
  textBody: [{ partId: '1', type: 'text/plain' }],
  messageId: ['m1@example.org'],
} as unknown as Email;

let client: {
  parseEmailBlob: ReturnType<typeof vi.fn>;
  fetchBlob: ReturnType<typeof vi.fn>;
  importRawEmail: ReturnType<typeof vi.fn>;
  getAccountId: () => string;
  getUsername: () => string;
};
const openCompose = vi.fn(async (_data: { mode: string }) => true);
const onImported = vi.fn();

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

beforeEach(() => {
  viewer = null;
  vi.clearAllMocks();
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  client = {
    parseEmailBlob: vi.fn(async () => PARSED),
    fetchBlob: vi.fn(async () => new Blob(['Subject: From a file\r\n\r\nHello'])),
    importRawEmail: vi.fn(async () => 'new-id'),
    getAccountId: () => 'acc-a',
    getUsername: () => 'me@example.org',
  };
  useAuthStore.setState({
    client: client as never,
    activeAccountId: 'login-a',
    getClientForAccount: (id: string) => (id === 'login-a' ? client : undefined) as never,
  });
  useEmailStore.setState({
    mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox', accountId: 'acc-a' }, { id: 'shared-1', name: 'Team', role: null, accountId: 'acc-team' }] as never,
    fetchMailboxes: vi.fn(async () => {}) as never,
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
  vi.unstubAllGlobals();
});

function show() {
  render(<PopoutSavedMessage blobId="blob-1" name="letter.eml" accountId="login-a" openCompose={openCompose} onImported={onImported} />);
}

describe('a message from a file in its own window', () => {
  it('reads the uploaded file through the server and shows it as received mail', async () => {
    show();
    await settle();
    expect(client.parseEmailBlob).toHaveBeenCalledWith('blob-1');
    expect(viewer?.email).toBe(PARSED);
    expect(viewer?.savedFile).toBe(true);
    // Opening it marks nothing and sends no read receipt.
    expect(viewer?.noAutomaticActions).toBe(true);
  });

  it('offers no action on a stored message, and no download of the file', async () => {
    show();
    await settle();
    expect(viewer?.onDelete).toBeUndefined();
    expect(viewer?.onArchive).toBeUndefined();
    expect(viewer?.onToggleStar).toBeUndefined();
    expect(viewer?.onMarkAsRead).toBeUndefined();
    expect(viewer?.onSetTag).toBeUndefined();
    expect(screen.queryByText('download')).toBeNull();
  });

  it('Reply opens a composer window with the message quoted, and marks no stored message answered', async () => {
    show();
    await settle();
    act(() => viewer?.onReply?.());
    await settle();
    expect(openCompose).toHaveBeenCalledTimes(1);
    const [data] = openCompose.mock.calls[0] as unknown as [{ mode: string; replyTo: { subject?: string; accountId?: string }; sourceEmailId?: string }];
    expect(data.mode).toBe('reply');
    expect(data.replyTo.subject).toBe('From a file');
    expect(data.replyTo.accountId).toBe('login-a');
    expect(data.sourceEmailId).toBeUndefined();
  });

  it('Reply all and Forward open composer windows too', async () => {
    show();
    await settle();
    act(() => viewer?.onReplyAll?.());
    act(() => viewer?.onForward?.());
    await settle();
    expect(openCompose.mock.calls.map(([data]) => data.mode)).toEqual(['replyAll', 'forward']);
  });

  it('Move imports it into the folder picked, as the drop overlay does, and the window goes on as that message', async () => {
    show();
    await settle();
    await act(async () => viewer?.onMoveToMailbox?.('inbox'));
    await settle();
    expect(client.fetchBlob).toHaveBeenCalledWith('blob-1', 'letter.eml', 'message/rfc822');
    expect(client.importRawEmail).toHaveBeenCalledWith(expect.any(Blob), { inbox: true }, { $seen: true }, 'acc-a');
    expect(toast.success).toHaveBeenCalledWith('import_done');
    expect(onImported).toHaveBeenCalledWith({ emailId: 'new-id', ownerAccountId: undefined });
  });

  it('a folder of another account: imported there, and opened there', async () => {
    show();
    await settle();
    await act(async () => viewer?.onMoveToMailbox?.('shared-1'));
    await settle();
    expect(client.importRawEmail).toHaveBeenCalledWith(expect.any(Blob), { 'shared-1': true }, { $seen: true }, 'acc-team');
    expect(onImported).toHaveBeenCalledWith({ emailId: 'new-id', ownerAccountId: 'acc-team' });
  });

  it('says so when the import fails, and stays', async () => {
    client.importRawEmail.mockRejectedValue(new Error('overQuota'));
    show();
    await settle();
    await act(async () => viewer?.onMoveToMailbox?.('inbox'));
    await settle();
    expect(toast.error).toHaveBeenCalledWith('import_failed');
    expect(onImported).not.toHaveBeenCalled();
  });

  it('says the file could not be opened when the server can\'t read it', async () => {
    client.parseEmailBlob.mockResolvedValue(null);
    show();
    await settle();
    expect(viewer).toBeNull();
    expect(screen.getByText('open_failed')).toBeTruthy();
    expect(screen.getByText('letter.eml')).toBeTruthy();
  });

  // The file was uploaded through login b, which has no client in this
  // window any more. Its blob id is another file, or none, for login a.
  it('uploaded through a login that has no client here is not read through the active login', async () => {
    render(<PopoutSavedMessage blobId="blob-1" name="letter.eml" accountId="login-b" openCompose={openCompose} onImported={onImported} />);
    await settle();
    expect(client.parseEmailBlob).not.toHaveBeenCalled();
    expect(useEmailStore.getState().fetchMailboxes).not.toHaveBeenCalled();
    expect(viewer).toBeNull();
    expect(screen.getByText('session_ended_title')).toBeTruthy();
  });
});
