import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';

/**
 * A message window's address names its login (`?account=`). The desktop shell
 * also opens one from a `bulwark://message/<id>` link, and that link names no
 * login when it was made without one (a link pasted from elsewhere, an older
 * shell): `/popout/message/<id>?via=link`, or `?owner=<account>&via=link`.
 *
 * Message ids repeat across logins. While several logins are in the account
 * list, such a window must open nothing: through the active login the id is
 * that login's message, not necessarily the one the link meant. With a single
 * login it opens as that login's, as before. A login named by its fingerprint
 * (how a notification's or the tray's context names one) opens as that login.
 */

type ViewProps = { emailId: string; client?: unknown; clientAccountId?: string; accountId?: string };
let view: ViewProps | null = null;
let saved: { accountId?: string } | null = null;

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
vi.mock('../popout-saved-message', () => ({
  PopoutSavedMessage: (props: { accountId?: string }) => {
    saved = props;
    return <div data-testid="saved-message" />;
  },
}));

const { PopoutMessageApp } = await import('../popout-message-app');

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), accounts: useAccountStore.getState() };
let active: { getSomeEmails: ReturnType<typeof vi.fn>; getAccountId: () => string };
let other: { getSomeEmails: ReturnType<typeof vi.fn>; getAccountId: () => string };
let fetchMailboxes: ReturnType<typeof vi.fn>;

const SERVER = 'https://mail.example.org';
const entry = (username: string, isDefault: boolean) => ({
  label: username, serverUrl: SERVER, username, authMode: 'basic' as const,
  rememberMe: false, displayName: username, email: username, lastLoginAt: 0,
  isConnected: true, hasError: false, isDefault,
});

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

let a: string;
let b: string;

beforeEach(() => {
  view = null;
  saved = null;
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  a = useAccountStore.getState().addAccount(entry('a@example.org', true));
  b = useAccountStore.getState().addAccount(entry('b@example.org', false));
  useAccountStore.getState().setActiveAccount(a);
  // Both logins have a message eaaaaab; login a is the active one.
  active = {
    getAccountId: () => 'ee',
    getSomeEmails: vi.fn(async () => [{ id: 'eaaaaab', subject: 'OWN private note', keywords: {}, mailboxIds: { a: true } }]),
  };
  other = {
    getAccountId: () => 'ef',
    getSomeEmails: vi.fn(async () => [{ id: 'eaaaaab', subject: 'B payroll', keywords: {}, mailboxIds: { a: true } }]),
  };
  fetchMailboxes = vi.fn(async () => {});
  const connected = new Map<string, unknown>([[a, active], [b, other]]);
  useAuthStore.setState({
    client: active as never,
    activeAccountId: a,
    getClientForAccount: ((id: string) => connected.get(id)) as never,
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
  useAccountStore.setState(original.accounts);
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('a message window from an address that names no login, while two logins are signed in', () => {
  it.each([
    ['a desktop link without an account', '/en/popout/message/eaaaaab?via=link'],
    ['a link with an owner and no account', '/en/popout/message/eaaaaab?owner=ef&via=link'],
    ['a bare window address', '/en/popout/message/eaaaaab'],
  ])('%s: shows no message of the active login', async (_label, address) => {
    window.history.replaceState(null, '', address);
    render(<PopoutMessageApp id="eaaaaab" />);
    await settle();
    // Either no view at all, or one that has no client to read through.
    if (view) expect(view.client).not.toBe(active);
    expect(active.getSomeEmails).not.toHaveBeenCalled();
    expect(fetchMailboxes).not.toHaveBeenCalled();
  });

  it('says why it opened nothing', async () => {
    window.history.replaceState(null, '', '/en/popout/message/eaaaaab?via=link');
    render(<PopoutMessageApp id="eaaaaab" />);
    await settle();
    expect(screen.getByText('account_routing.link_names_no_account')).toBeInTheDocument();
    expect(view).toBeNull();
  });

  it('a message from a file whose address names no login is not read either', async () => {
    window.history.replaceState(null, '', '/en/popout/message/_?blob=Gblob1&name=saved.eml');
    render(<PopoutMessageApp id="_" />);
    await settle();
    expect(saved).toBeNull();
    expect(screen.getByText('account_routing.link_names_no_account')).toBeInTheDocument();
  });
});

describe('a message window from an address that names its login by fingerprint', () => {
  it('opens the message of the login with that fingerprint, through that login', async () => {
    const print = await loginFingerprint(SERVER, 'b@example.org');
    window.history.replaceState(null, '', `/en/popout/message/eaaaaab?owner=ef&account=${print}&via=link`);
    render(<PopoutMessageApp id="eaaaaab" />);
    await settle();
    await settle();
    expect(view?.client).toBe(other);
    expect(view?.clientAccountId).toBe(b);
    expect(active.getSomeEmails).not.toHaveBeenCalled();
  });

  it('opens nothing for a fingerprint of no login here, and reads nothing through the active login', async () => {
    const print = await loginFingerprint('https://elsewhere.example.net', 'c@example.net');
    window.history.replaceState(null, '', `/en/popout/message/eaaaaab?account=${print}&via=link`);
    render(<PopoutMessageApp id="eaaaaab" />);
    await settle();
    await settle();
    if (view) expect(view.client).not.toBe(active);
    expect(active.getSomeEmails).not.toHaveBeenCalled();
    expect(fetchMailboxes).not.toHaveBeenCalled();
  });
});

describe('a message window from an address that names no login, with one login', () => {
  beforeEach(() => {
    useAccountStore.getState().removeAccount(b);
    expect(useAccountStore.getState().accounts).toHaveLength(1);
  });

  it('opens that login\'s message, as before', async () => {
    window.history.replaceState(null, '', '/en/popout/message/eaaaaab?via=link');
    render(<PopoutMessageApp id="eaaaaab" />);
    await settle();
    expect(view?.client).toBe(active);
    expect(view?.clientAccountId).toBe(a);
    expect(screen.queryByText('account_routing.link_names_no_account')).toBeNull();
  });

  it('opens a message from a file, as before', async () => {
    window.history.replaceState(null, '', '/en/popout/message/_?blob=Gblob1&name=saved.eml');
    render(<PopoutMessageApp id="_" />);
    await settle();
    expect(screen.getByTestId('saved-message')).toBeInTheDocument();
    expect(screen.queryByText('account_routing.link_names_no_account')).toBeNull();
  });
});
