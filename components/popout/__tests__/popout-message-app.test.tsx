import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { openPopoutChannel } from '@/lib/popout/channel';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';

// The pop-out message around the view it hosts: the view is stubbed, since the
// Pro tab's tests cover it. The next-intl mock returns the key.

type ViewProps = {
  emailId: string;
  clientAccountId?: string;
  accountId?: string;
  liveState?: { keywords?: Record<string, boolean>; mailboxIds?: Record<string, boolean> } | null;
  onLoaded?: (email: Email) => void;
  onClose: () => void;
  onOpenCompose?: (data: { mode: string }) => void;
  onMailChanged?: () => void;
};
let view: ViewProps;

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

const { PopoutMessageApp } = await import('../popout-message-app');

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState() };
const EMAIL = { id: 'm/1', subject: 'Hello', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;
let found: Array<Partial<Email>> | Error;
let client: { getSomeEmails: ReturnType<typeof vi.fn> };

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  window.history.replaceState(null, '', '/en/popout/message/m%2F1?account=login-b&owner=group');
  found = [EMAIL];
  client = {
    getSomeEmails: vi.fn(async () => {
      if (found instanceof Error) throw found;
      return found;
    }),
  };
  useAuthStore.setState({
    client: client as never,
    activeAccountId: 'login-a',
    getClientForAccount: (id: string) => (id === 'login-b' ? client : undefined) as never,
  });
  useEmailStore.setState({
    emails: [],
    mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }, { id: 'archive', name: 'Old mail', role: null }] as never,
    fetchMailboxes: vi.fn(async () => {}) as never,
  });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('a message opened from a bulwark:// link', () => {
  it('asks for nothing automatic: such a link may show a message, not act on it', async () => {
    window.history.replaceState(null, '', '/en/popout/message/m%2F1?account=login-b&via=link');
    render(<PopoutMessageApp id="m/1" />);
    await settle();
    expect((view as unknown as { noAutomaticActions?: boolean }).noAutomaticActions).toBe(true);
  });

  it('an ordinary pop-out acts as ever', async () => {
    render(<PopoutMessageApp id="m/1" />);
    await settle();
    expect((view as unknown as { noAutomaticActions?: boolean }).noAutomaticActions).toBeFalsy();
  });
});

describe('PopoutMessageApp', () => {
  // pass-2 mail-p2-5: the window showed one message of a conversation.
  it('reads the message in its conversation, as the reading pane does', async () => {
    render(<PopoutMessageApp id="m/1" />);
    await settle();
    expect((view as unknown as { conversation?: boolean }).conversation).toBe(true);
  });

  it('opens the message of the address, through its login and account', async () => {
    render(<PopoutMessageApp id="rendered-for-another-id" />);
    await settle();
    expect(view.emailId).toBe('m/1');
    expect(view.clientAccountId).toBe('login-b');
    expect(view.accountId).toBe('group');
    expect(client.getSomeEmails).toHaveBeenCalledWith(['m/1'], 'group');
  });

  it('shows the message once the folders are in: Delete needs Trash, and the toolbar must not move', async () => {
    let finish: () => void = () => {};
    useEmailStore.setState({ mailboxes: [], fetchMailboxes: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) as never });
    render(<PopoutMessageApp id="m1" />);
    await settle();
    expect(screen.queryByTestId('message-view')).toBeNull();
    expect(screen.getByTestId('skeleton')).toBeTruthy();
    await act(async () => { finish(); });
    await settle();
    expect(screen.getByTestId('message-view')).toBeTruthy();
  });

  it('shows the message anyway when the folders cannot be fetched', async () => {
    useEmailStore.setState({ mailboxes: [], fetchMailboxes: vi.fn(async () => { throw new Error('offline'); }) as never });
    render(<PopoutMessageApp id="m1" />);
    await settle();
    expect(screen.getByTestId('message-view')).toBeTruthy();
  });

  it('puts the loaded message where delete, move, star and read look for it', async () => {
    render(<PopoutMessageApp id="m1" />);
    await settle();
    act(() => view.onLoaded?.(EMAIL));
    expect(useEmailStore.getState().emails).toEqual([EMAIL]);
    expect(useEmailStore.getState().selectedMailbox).toBe('inbox');
  });

  it('says so when the message is gone', async () => {
    found = [];
    render(<PopoutMessageApp id="m1" />);
    await screen.findByText('message_gone_title');
    expect(screen.queryByTestId('message-view')).toBeNull();
  });

  it('keeps the message on screen when the server does not answer', async () => {
    found = new TypeError('Failed to fetch');
    render(<PopoutMessageApp id="m1" />);
    await settle();
    expect(screen.getByTestId('message-view')).toBeTruthy();
    expect(screen.queryByText('message_gone_title')).toBeNull();
  });

  it('checks again when another window reports a change, and shows the new flags', async () => {
    const main = openPopoutChannel(() => {})!;
    render(<PopoutMessageApp id="m1" />);
    await settle();
    act(() => view.onLoaded?.(EMAIL));
    found = [{ ...EMAIL, keywords: { $seen: false } }];
    main.post({ type: 'state-change' });
    await waitFor(() => expect(view.liveState?.keywords).toEqual({ $seen: false }));
    // And the next toggle starts from them.
    expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: false });
    main.close();
  });

  it('checks again when the window gets the focus', async () => {
    render(<PopoutMessageApp id="m1" />);
    await settle();
    found = [];
    act(() => { window.dispatchEvent(new Event('focus')); });
    await screen.findByText('message_gone_title');
  });

  it('says where a moved message went, and keeps showing it', async () => {
    render(<PopoutMessageApp id="m1" />);
    await settle();
    expect(document.querySelector('[data-popout-moved]')).toBeNull();
    found = [{ ...EMAIL, mailboxIds: { archive: true } }];
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(document.querySelector('[data-popout-moved]')?.textContent).toContain('message_moved_to'));
    expect(screen.getByTestId('message-view')).toBeTruthy();
  });

  it('tells the main window when it changed something', async () => {
    const heard: string[] = [];
    const main = openPopoutChannel((message) => heard.push(message.type))!;
    render(<PopoutMessageApp id="m1" />);
    await settle();
    act(() => view.onMailChanged?.());
    await settle();
    expect(heard).toContain('mail-changed');
    main.close();
  });

  it('closes the window when the message leaves it', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<PopoutMessageApp id="m1" />);
    await settle();
    act(() => view.onClose());
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });
});
