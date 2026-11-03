import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { openPopoutChannel, type PopoutMessage, type RescuedDraft } from '@/lib/popout/channel';
import { createComposeHandoff, rememberComposePayload } from '@/lib/popout/compose-handoff';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { usePluginStore } from '@/stores/plugin-store';
import { emailHooks } from '@/lib/plugin-hooks';

// The composer's window: when it tells the opening window to let go, and what
// happens on a reload. The composer itself is stubbed; its own tests cover it.

type ComposerProps = {
  initialData?: { draftId?: string | null; subject?: string; unsaved?: boolean } | null;
  ownWindow: { rescueDraft: (draft: RescuedDraft) => boolean };
};
let composer: ComposerProps | null;

vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: (props: ComposerProps) => {
    composer = props;
    return <div data-testid="composer">{props.initialData?.subject}</div>;
  },
}));
vi.mock('@/components/error', () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>, ComposerErrorFallback: () => null }));
vi.mock('../popout-shell', () => ({
  PopoutShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoutSkeleton: () => <div data-testid="skeleton" />,
  PopoutNotice: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: vi.fn() }));

const identityMocks = vi.hoisted(() => ({
  multi: { enabled: false, allIdentities: [] as unknown[], groups: [] as unknown[] },
  bump: undefined as undefined | (() => void),
}));
vi.mock('@/hooks/use-pro-multi-account-identities', async () => {
  const { useReducer } = await import('react');
  return {
    useProMultiAccountIdentities: () => {
      const [, bump] = useReducer((n: number) => n + 1, 0);
      identityMocks.bump = bump;
      return identityMocks.multi;
    },
    stripCrossAccountIdentityPrefix: (id: string) => {
      const at = id.indexOf('::');
      return at >= 0 ? { localAccountId: id.slice(0, at), rawId: id.slice(at + 2) } : { localAccountId: null, rawId: id };
    },
  };
});

const { PopoutComposeApp } = await import('../popout-compose-app');

const original = useAuthStore.getState();
const PAYLOAD = { mode: 'compose' as const, initialData: { subject: 'Moving', draftId: 'old', unsaved: true } as never };
let heard: PopoutMessage[];
let listener: NonNullable<ReturnType<typeof openPopoutChannel>>;

const settle = async (ms = 10) => {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
};

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  sessionStorage.clear();
  composer = null;
  heard = [];
  listener = openPopoutChannel((message) => heard.push(message))!;
  useAuthStore.setState({ client: {} as never, activeAccountId: 'alice' });
});

afterEach(() => {
  cleanup();
  listener.close();
  useAuthStore.setState(original);
  vi.unstubAllGlobals();
  vi.resetModules();
  window.history.replaceState(null, '', '/');
});

function openAt(handoffId: string) {
  window.history.replaceState(null, '', `/en/popout/compose?handoff=${handoffId}&account=alice`);
  render(<PopoutComposeApp />);
}

describe('a composer coming back on its draft', () => {
  const closeSelf = vi.fn();
  const setRestore = vi.fn();
  const LOGIN = 'alice@example.org@mail.example.org';
  const MAILBOXES = [
    { id: 'mDrafts', role: 'drafts' },
    { id: 'mSent', role: 'sent' },
    { id: 'mTrash', role: 'trash' },
    { id: 'mInbox', role: 'inbox' },
  ];

  beforeEach(() => {
    closeSelf.mockClear();
    setRestore.mockClear();
    identityMocks.multi = { enabled: false, allIdentities: [], groups: [] };
    useIdentityStore.setState({ identities: [{ id: 'id-1', email: 'me@example.org', name: 'Me' }] } as never);
    window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { closeSelf, setRestore } } as never;
  });

  afterEach(() => {
    window.bulwarkDesktop = undefined;
    vi.useRealTimers();
  });

  const draft = {
    id: 'd1', subject: 'Half-written', to: [{ email: 'a@example.org' }], cc: [], bcc: [], from: [{ name: 'Me', email: 'me@example.org' }],
    keywords: { $draft: true }, mailboxIds: { mDrafts: true },
    bodyValues: { t: { value: 'Text' } }, textBody: [{ partId: 't', type: 'text/plain' }], htmlBody: [], attachments: [{ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 3 }],
  };

  const openDraft = (getEmail: ReturnType<typeof vi.fn>, search = `draft=d1&account=${encodeURIComponent(LOGIN)}&owner=group`) => {
    const client = { getEmail, getMailboxes: vi.fn(async () => MAILBOXES) };
    useAuthStore.setState({ client: { other: true } as never, getClientForAccount: (id: string) => (id === LOGIN ? client : undefined) } as never);
    window.history.replaceState(null, '', `/en/popout/compose?${search}`);
    render(<PopoutComposeApp />);
    return client;
  };

  it('reads the draft from where it lives, and opens the composer on it, id and all', async () => {
    const getEmail = vi.fn(async () => draft);
    openDraft(getEmail);
    await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Half-written'));
    expect(getEmail).toHaveBeenCalledWith('d1', 'group');
    // Saving goes over this draft, not next to it, and its files stay.
    expect(composer?.initialData).toMatchObject({ draftId: 'd1', draftAccountId: 'group', draftLocalAccountId: LOGIN, to: 'a@example.org' });
    expect((composer?.initialData as unknown as { attachments: unknown[] }).attachments).toHaveLength(1);
  });

  // Sending keeps the id. A composer on it would destroy the Sent copy at the next
  // autosave, Send would mail it twice, and Discard would delete it.
  it.each([
    ['a message that was sent', { keywords: { $seen: true }, mailboxIds: { mSent: true } }],
    ['a sent message still marked as a draft', { keywords: { $draft: true }, mailboxIds: { mSent: true } }],
    ['a draft in the Trash', { keywords: { $draft: true }, mailboxIds: { mTrash: true } }],
    ['mail in the Inbox that is no draft at all', { keywords: {}, mailboxIds: { mInbox: true } }],
  ])('%s is not opened', async (_name, shape) => {
    openDraft(vi.fn(async () => ({ ...draft, ...shape })));
    await waitFor(() => expect(closeSelf).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('composer')).toBeNull();
  });

  it('a send brought back has no $draft, and in Drafts it opens', async () => {
    openDraft(vi.fn(async () => ({ ...draft, keywords: {}, mailboxIds: { mDrafts: true } })));
    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
  });

  it('an address with no login opens nothing, not the active account\'s mail under the same id', async () => {
    const getEmail = vi.fn(async () => draft);
    useAuthStore.setState({ client: { getEmail, getMailboxes: async () => MAILBOXES } as never, getClientForAccount: () => undefined } as never);
    window.history.replaceState(null, '', '/en/popout/compose?draft=d1');
    render(<PopoutComposeApp />);
    await waitFor(() => expect(closeSelf).toHaveBeenCalledTimes(1));
    expect(getEmail).not.toHaveBeenCalled();
  });

  it('a draft gone since closes the window', async () => {
    openDraft(vi.fn(async () => null));
    await waitFor(() => expect(closeSelf).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('composer')).toBeNull();
  });

  it('a server not answering keeps the window and the entry, and Try again works', async () => {
    let up = false;
    const getEmail = vi.fn(async () => {
      if (!up) throw new Error('offline');
      return draft;
    });
    openDraft(getEmail);
    await screen.findByText('unavailable_title');
    expect(closeSelf).not.toHaveBeenCalled();
    // On the list for next time.
    expect(setRestore.mock.lastCall![0]).toEqual([expect.stringContaining('draft=d1')]);
    up = true;
    fireEvent.click(screen.getByText('try_again'));
    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
  });

  it('plugins get their say on the draft, as when it opens from the list', async () => {
    const hook = emailHooks.onBeforeEditDraft.register('test', ((value: unknown) => ({ ...(value as object), subject: 'Changed by a plugin' })) as never);
    try {
      openDraft(vi.fn(async () => draft));
      await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Changed by a plugin'));
    } finally {
      hook.dispose();
    }
  });

  describe('with several accounts', () => {
    const OTHER = { id: 'other@x@h::id-9', email: 'other@example.org', name: 'Other', localAccountId: LOGIN };

    it('waits for the identity that wrote it, however late it loads, and starts on that', async () => {
      identityMocks.multi = { enabled: true, allIdentities: [], groups: [] };
      const fromOther = { ...draft, from: [{ name: 'Other', email: 'other@example.org' }] };
      openDraft(vi.fn(async () => fromOther));
      await settle();
      // Not on the default in the meantime: it would save that.
      expect(screen.queryByTestId('composer')).toBeNull();
      act(() => {
        identityMocks.multi = { enabled: true, allIdentities: [OTHER], groups: [] };
        identityMocks.bump?.();
      });
      await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
      expect(composer?.initialData).toMatchObject({ selectedIdentityId: OTHER.id });
      expect((composer?.initialData as unknown as { fromOverrideEnabled?: boolean }).fromOverrideEnabled).toBeUndefined();
    });

    it('an address no identity has any more stays as the From, not the default', async () => {
      identityMocks.multi = { enabled: true, allIdentities: [], groups: [] };
      vi.useFakeTimers({ shouldAdvanceTime: true });
      openDraft(vi.fn(async () => ({ ...draft, from: [{ name: 'Gone', email: 'gone@example.org' }] })));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });
      await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
      expect(composer?.initialData).toMatchObject({ selectedIdentityId: null, fromOverrideEnabled: true, fromOverrideEmail: 'gone@example.org', fromOverrideName: 'Gone' });
    });
  });

  it('a save moves the address on, or a reload would look for a version that is gone', async () => {
    openDraft(vi.fn(async () => draft));
    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
    act(() => (composer as unknown as { ownWindow: { onDraftSaved: (id: string) => void } }).ownWindow.onDraftSaved('d2'));
    expect(new URLSearchParams(window.location.search).get('draft')).toBe('d2');
    expect(new URLSearchParams(window.location.search).get('account')).toBe(LOGIN);
  });
});

describe('PopoutComposeApp', () => {
  it('tells the opening window to let go only with the composer on screen', async () => {
    const handoff = createComposeHandoff()!;
    openAt(handoff.id);
    await settle();
    expect(heard.some((message) => message.type === 'handoff-rendered')).toBe(false);
    expect(screen.queryByTestId('composer')).toBeNull();

    await expect(Promise.all([handoff.complete(PAYLOAD), settle()]).then(([shown]) => shown)).resolves.toBe(true);
    expect(screen.getByTestId('composer').textContent).toBe('Moving');
  });

  it('does not while it has no session, so the opening window keeps its copy', async () => {
    useAuthStore.setState({ client: null });
    const handoff = createComposeHandoff()!;
    openAt(handoff.id);
    await settle();
    const shown = handoff.complete(PAYLOAD, 100);
    await settle(30);
    await expect(shown).resolves.toBe(false);
    handoff.cancel();
    await settle();
  });

  it('closes when the opening window takes the draft back, also after it was delivered', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    useAuthStore.setState({ client: null });
    const handoff = createComposeHandoff()!;
    openAt(handoff.id);
    await settle();
    void handoff.complete(PAYLOAD, 5000);
    await settle();
    expect(screen.getByTestId('composer')).toBeTruthy();
    handoff.cancel();
    await settle();
    expect(screen.queryByTestId('composer')).toBeNull();
    expect(close).toHaveBeenCalled();
    close.mockRestore();
  });

  it('after a reload, takes up the id its text was saved under, so no second draft appears', async () => {
    rememberComposePayload('h1', PAYLOAD);
    const main = openPopoutChannel((message) => {
      if (message.type === 'rescue-query') main.post({ type: 'rescue-answer', rescueKey: message.rescueKey, draftId: 'saved-by-main' });
    })!;
    openAt('h1');
    await waitFor(() => expect(composer?.initialData?.draftId).toBe('saved-by-main'));
    expect(composer?.initialData?.unsaved).toBe(false);
    main.close();
  });

  it('after a reload with nothing handed over, keeps what it holds', async () => {
    rememberComposePayload('h2', PAYLOAD);
    openAt('h2');
    await waitFor(() => expect(composer?.initialData?.draftId).toBe('old'), { timeout: 4000 });
    expect(composer?.initialData?.unsaved).toBe(true);
  });

  it('names the login and the key when it hands over a closing draft', async () => {
    const main = openPopoutChannel((message) => {
      if (message.type === 'main-ping') main.post({ type: 'main-pong', windowId: 'w', accountIds: ['alice'] });
    })!;
    rememberComposePayload('h3', { mode: 'compose' });
    openAt('h3');
    await waitFor(() => expect(composer).not.toBeNull());
    await settle();
    usePluginStore.setState({ initialized: false });
    expect(composer!.ownWindow.rescueDraft({ state: {} } as RescuedDraft), 'before plugins have started').toBe(false);
    usePluginStore.setState({ initialized: true });
    expect(composer!.ownWindow.rescueDraft({ state: {} } as RescuedDraft)).toBe(true);
    await settle();
    expect(heard.find((message) => message.type === 'draft-rescue')).toMatchObject({ draft: { localAccountId: 'alice', rescueKey: 'h3' } });
    main.close();
  });
});
