import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';

/**
 * A message window names its login in its address. When that login has no
 * client in the window (dropped while the window is open: the desktop server
 * policy, a login that did not come back), the window must show nothing of
 * the message: through the login that is active instead, the same id is
 * another account's message. It must not be read, looked up or have its
 * folders fetched through that other login.
 *
 * Belongs in components/popout/__tests__/.
 */

type ViewProps = { emailId: string; client?: unknown; clientAccountId?: string; accountId?: string };
let view: ViewProps | null = null;

vi.mock('@/components/pro/pro-email-tab-body', () => ({
  ProEmailView: (props: ViewProps) => {
    view = props;
    return <div data-testid="message-view" />;
  },
}));
vi.mock('../popout-shell', () => ({
  PopoutShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoutNotice: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
  PopoutSkeleton: () => <div data-testid="skeleton" />,
}));
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: vi.fn() }));
vi.mock('../popout-saved-message', () => ({ PopoutSavedMessage: () => <div data-testid="saved-message" /> }));

const { PopoutMessageApp } = await import('../popout-message-app');

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState() };
let active: { getSomeEmails: ReturnType<typeof vi.fn>; getAccountId: () => string };
let fetchMailboxes: ReturnType<typeof vi.fn>;

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

beforeEach(() => {
  view = null;
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  // The window of login b's message eaaaaab.
  window.history.replaceState(null, '', '/en/popout/message/eaaaaab?account=login-b');
  // Login a is the active one here now and has its own eaaaaab; login b has no client.
  active = {
    getAccountId: () => 'ee',
    getSomeEmails: vi.fn(async () => [{ id: 'eaaaaab', subject: 'OWN private note', keywords: {}, mailboxIds: { a: true } }]),
  };
  fetchMailboxes = vi.fn(async () => {});
  useAuthStore.setState({
    client: active as never,
    activeAccountId: 'login-a',
    getClientForAccount: ((id: string) => (id === 'login-a' ? active : undefined)) as never,
  });
  useEmailStore.setState({
    emails: [],
    mailboxes: [{ id: 'a', name: 'Inbox', role: 'inbox' }] as never,
    fetchMailboxes: fetchMailboxes as never,
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('a message window whose login has no client while another login is active', () => {
  it('does not hand the message view the active login\'s client', async () => {
    render(<PopoutMessageApp id="eaaaaab" />);
    await settle();
    // Either no view at all, or one that has no client to read through.
    if (view) expect(view.client).not.toBe(active);
  });

  it('does not look the id up through the active login', async () => {
    render(<PopoutMessageApp id="eaaaaab" />);
    await settle();
    expect(active.getSomeEmails).not.toHaveBeenCalled();
  });

  it('does not fetch the active login\'s folders for it', async () => {
    render(<PopoutMessageApp id="eaaaaab" />);
    await settle();
    expect(fetchMailboxes).not.toHaveBeenCalled();
  });
});
