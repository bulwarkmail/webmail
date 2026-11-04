import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { openPopoutChannel, type PopoutMessage, type RescuedDraft } from '@/lib/popout/channel';
import { createComposeHandoff, rememberComposePayload, rememberedComposePayload } from '@/lib/popout/compose-handoff';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
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

describe('back into the main window', () => {
  const focus = vi.fn();

  beforeEach(() => {
    focus.mockClear();
    window.history.replaceState(null, '', '/en/popout/compose');
  });

  afterEach(() => {
    window.bulwarkDesktop = undefined;
  });

  /** A main window that holds these logins, and answers a move as told. */
  function mainWindowAnswers(status: 'shown' | 'busy' | null, accountIds = ['alice']) {
    const channel = openPopoutChannel((message) => {
      if (message.type === 'main-ping') channel?.post({ type: 'main-pong', windowId: 'main', accountIds });
      if (message.type === 'composer-return' && status === 'busy') channel?.post({ type: 'composer-return-answer', returnId: message.returnId, status });
      if (message.type === 'composer-return' && status === 'shown') channel?.post({ type: 'composer-return-ready', returnId: message.returnId });
      if (message.type === 'composer-return-commit' && status) channel?.post({ type: 'composer-return-answer', returnId: message.returnId, status });
    })!;
    return channel;
  }

  const openComposer = async () => {
    render(<PopoutComposeApp />);
    await settle();
    return composer as unknown as {
      popOut?: () => { handOver: (state: object) => Promise<boolean>; notShownMessage: () => string };
      popOutToMainLabel?: string;
    };
  };

  it('is offered while a main window holds the login', async () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { focus } } as never;
    const main = mainWindowAnswers('shown');
    const props = await openComposer();
    await waitFor(() => expect((composer as unknown as { popOut?: unknown }).popOut).toBeTruthy(), { timeout: 5000 });
    expect((composer as unknown as { popOutToMainLabel: string }).popOutToMainLabel).toBe('back_to_main');
    expect(props).toBeTruthy();
    main.close();
  });

  it('is not offered with no main window, or one holding another login', async () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { focus } } as never;
    await openComposer();
    await settle(250);
    expect((composer as unknown as { popOut?: unknown }).popOut).toBeUndefined();
    cleanup();
    const main = mainWindowAnswers('shown', ['bob']);
    await openComposer();
    await settle(250);
    expect((composer as unknown as { popOut?: unknown }).popOut).toBeUndefined();
    main.close();
  });

  it('is not offered in a browser, which behaves as it did', async () => {
    const main = mainWindowAnswers('shown');
    await openComposer();
    await settle(250);
    expect((composer as unknown as { popOut?: unknown }).popOut).toBeUndefined();
    main.close();
  });

  it('hands over what the composer holds, and brings the main window up once it is there', async () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { focus } } as never;
    const main = mainWindowAnswers('shown');
    await openComposer();
    await waitFor(() => expect((composer as unknown as { popOut?: unknown }).popOut).toBeTruthy(), { timeout: 5000 });
    const target = (composer as unknown as { popOut: () => { handOver: (state: object) => Promise<boolean> } }).popOut();
    const state = { mode: 'reply', subject: 'Back', draftId: 'd9', draftLocalAccountId: 'carol' };
    await act(async () => {
      await expect(target.handOver(state)).resolves.toBe(true);
    });
    expect(heard.map((message) => message.type)).toContain('composer-return-commit');
    const sent = heard.find((message) => message.type === 'composer-return') as Extract<PopoutMessage, { type: 'composer-return' }>;
    expect(sent.payload).toMatchObject({ mode: 'reply', initialData: state });
    // The draft's own login, which isn't always the window's.
    expect(sent.accountId).toBe('carol');
    expect(focus).toHaveBeenCalledOnce();
    main.close();
  });

  it('a busy main window keeps the text here, says why, and stays out of sight', async () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { focus } } as never;
    const main = mainWindowAnswers('busy');
    await openComposer();
    await waitFor(() => expect((composer as unknown as { popOut?: unknown }).popOut).toBeTruthy(), { timeout: 5000 });
    const target = (composer as unknown as { popOut: () => { handOver: (state: object) => Promise<boolean>; notShownMessage: () => string } }).popOut();
    await act(async () => {
      await expect(target.handOver({ mode: 'compose' })).resolves.toBe(false);
    });
    expect(target.notShownMessage()).toBe('back_busy');
    expect(focus).not.toHaveBeenCalled();
    main.close();
  });
});

describe('a new message, with nothing handed over', () => {
  const hooks: Array<() => void> = [];
  const listen = (handler: (...args: never[]) => unknown) => {
    const held = emailHooks.onBeforeCompose.register('test', handler as never);
    hooks.push(() => held.dispose());
  };

  beforeEach(() => {
    window.history.replaceState(null, '', '/en/popout/compose');
    usePluginStore.setState({ initializePlugins: vi.fn(async () => {}) } as never);
    useIdentityStore.setState({ identities: [{ id: 'id-1', email: 'me@example.org', name: 'Me' }] } as never);
  });

  afterEach(() => {
    for (const stop of hooks.splice(0)) stop();
    window.bulwarkDesktop = undefined;
  });

  type Prefill = { prefill?: { to?: string[]; subject?: string } | null };

  it('with no plugin listening, opens empty', async () => {
    render(<PopoutComposeApp />);
    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
    expect((composer as unknown as Prefill).prefill ?? null).toBeNull();
  });

  it('a plugin that fills in fields fills them in, as in the main window', async () => {
    const seen: unknown[] = [];
    listen((options: unknown) => {
      seen.push(options);
      return { ...(options as object), to: ['from-plugin@example.org'], subject: 'From a plugin' };
    });
    render(<PopoutComposeApp />);
    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
    expect((composer as unknown as Prefill).prefill).toEqual({ to: ['from-plugin@example.org'], subject: 'From a plugin' });
    expect(seen).toHaveLength(1);
  });

  it('a plugin that stops it stops it: no composer, and the window goes', async () => {
    const closeSelf = vi.fn();
    window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { closeSelf } } as never;
    listen(() => false);
    render(<PopoutComposeApp />);
    await waitFor(() => expect(closeSelf).toHaveBeenCalled());
    expect(screen.queryByTestId('composer')).toBeNull();
  });

  it('waits for plugins that are still starting before it asks them', async () => {
    let started: () => void = () => {};
    usePluginStore.setState({ initializePlugins: vi.fn(() => new Promise<void>((resolve) => { started = resolve; })) } as never);
    render(<PopoutComposeApp />);
    await settle();
    expect(screen.queryByTestId('composer')).toBeNull();
    listen(() => false);
    const closeSelf = vi.fn();
    window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { closeSelf } } as never;
    await act(async () => started());
    await waitFor(() => expect(closeSelf).toHaveBeenCalled());
    expect(screen.queryByTestId('composer')).toBeNull();
  });

  it('a draft or a handoff isn\'t asked about again: it was at its start', async () => {
    const hook = vi.fn(() => false);
    listen(hook);
    const handoff = createComposeHandoff()!;
    void handoff.complete(PAYLOAD);
    openAt(handoff.id);
    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('after this page crashed', () => {
  const LOGIN = 'alice@example.org@mail.example.org';
  const MAILBOXES = [{ id: 'mDrafts', role: 'drafts' }];
  const draft = {
    id: 'd7', subject: 'Saved before the crash', to: [], cc: [], bcc: [], from: [{ name: 'Me', email: 'me@example.org' }],
    keywords: { $draft: true }, mailboxIds: { mDrafts: true }, bodyValues: { t: { value: 'Text' } }, textBody: [{ partId: 't', type: 'text/plain' }], htmlBody: [], attachments: [],
  };
  const search = () => new URLSearchParams(window.location.search);

  beforeEach(() => {
    useIdentityStore.setState({ identities: [{ id: 'id-1', email: 'me@example.org', name: 'Me' }] } as never);
    usePluginStore.setState({ initializePlugins: vi.fn(async () => {}) } as never);
    identityMocks.multi = { enabled: false, allIdentities: [], groups: [] };
  });

  it('each save puts the draft, its login and its account in the address, on a window that started empty', async () => {
    window.history.replaceState(null, '', '/en/popout/compose');
    render(<PopoutComposeApp />);
    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy());
    const own = (composer as unknown as { ownWindow: { onDraftSaved: (id: string, where: object) => void } }).ownWindow;
    act(() => own.onDraftSaved('d1', { localAccountId: LOGIN, accountId: 'shared' }));
    expect([search().get('draft'), search().get('account'), search().get('owner')]).toEqual(['d1', LOGIN, 'shared']);
    act(() => own.onDraftSaved('d2', { localAccountId: LOGIN }));
    expect([search().get('draft'), search().get('account'), search().get('owner')]).toEqual(['d2', LOGIN, null]);
  });

  it('comes back on the saved draft, not blank', async () => {
    const getEmail = vi.fn(async () => draft);
    const client = { getEmail, getMailboxes: vi.fn(async () => MAILBOXES) };
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === LOGIN ? client : undefined) } as never);
    window.history.replaceState(null, '', `/en/popout/compose?draft=d7&account=${encodeURIComponent(LOGIN)}`);
    render(<PopoutComposeApp />);
    await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Saved before the crash'));
    expect(getEmail).toHaveBeenCalledWith('d7', undefined);
  });

  it('with a handoff in the address too, the saved draft wins: nothing was remembered, so the page died', async () => {
    const getEmail = vi.fn(async () => draft);
    const client = { getEmail, getMailboxes: vi.fn(async () => MAILBOXES) };
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === LOGIN ? client : undefined) } as never);
    window.history.replaceState(null, '', `/en/popout/compose?handoff=gone&draft=d7&account=${encodeURIComponent(LOGIN)}`);
    render(<PopoutComposeApp />);
    await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Saved before the crash'));
  });

  it('an ordinary reload goes on from what it remembered as it unloaded, which is newer than the draft', async () => {
    const getEmail = vi.fn(async () => draft);
    const client = { getEmail, getMailboxes: vi.fn(async () => MAILBOXES) };
    useAuthStore.setState({ getClientForAccount: (id: string) => (id === LOGIN ? client : undefined) } as never);
    rememberComposePayload('h1', { mode: 'compose', initialData: { subject: 'Typed since the save' } as never });
    window.history.replaceState(null, '', `/en/popout/compose?handoff=h1&draft=d7&account=${encodeURIComponent(LOGIN)}`);
    render(<PopoutComposeApp />);
    // A reload first hears what became of the text it handed over on the way out.
    await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Typed since the save'), { timeout: 5000 });
    expect(getEmail).not.toHaveBeenCalled();
  });

  it('a save forgets what was remembered, so a later crash can\'t bring back older text', async () => {
    rememberComposePayload('h2', { mode: 'compose', initialData: { subject: 'Older' } as never });
    window.history.replaceState(null, '', '/en/popout/compose?handoff=h2');
    render(<PopoutComposeApp />);
    await waitFor(() => expect(screen.getByTestId('composer')).toBeTruthy(), { timeout: 5000 });
    act(() => (composer as unknown as { ownWindow: { onDraftSaved: (id: string, where: object) => void } }).ownWindow.onDraftSaved('d3', {}));
    expect(rememberedComposePayload('h2')).toBeNull();
  });
});

describe('a send held for undo', () => {
  const closeSelf = vi.fn();
  const MAILBOXES = [{ id: 'mDrafts', role: 'drafts' }, { id: 'mSent', role: 'sent' }];
  const startDraft = {
    id: 'd0', subject: 'Before sending', to: [{ email: 'a@example.org' }], cc: [], bcc: [], from: [{ name: 'Me', email: 'me@example.org' }],
    keywords: { $draft: true }, mailboxIds: { mDrafts: true },
    bodyValues: { t: { value: 'Text' } }, textBody: [{ partId: 't', type: 'text/plain' }], htmlBody: [], attachments: [],
  };
  const restoredDraft = {
    id: 'e1', subject: 'Back again', to: [{ email: 'a@example.org' }], cc: [], bcc: [], from: [{ name: 'Me', email: 'me@example.org' }],
    keywords: { $draft: true }, mailboxIds: { mDrafts: true },
    bodyValues: { t: { value: 'Text' } }, textBody: [{ partId: 't', type: 'text/plain' }], htmlBody: [], attachments: [],
  };
  let originalEmail: ReturnType<typeof useEmailStore.getState>;
  let sendAt: string;
  let cancelUndoSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeSelf.mockClear();
    originalEmail = useEmailStore.getState();
    window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { closeSelf, setRestore: vi.fn() } } as never;
    useIdentityStore.setState({ identities: [{ id: 'id-1', email: 'me@example.org', name: 'Me' }] } as never);
    identityMocks.multi = { enabled: false, allIdentities: [], groups: [] };
    const client = { getEmail: vi.fn(async (id: string) => (id === 'e1' ? restoredDraft : startDraft)), getMailboxes: vi.fn(async () => MAILBOXES) };
    useAuthStore.setState({ client: client as never, getClientForAccount: (id: string) => (id === 'alice' ? client : undefined) } as never);
    cancelUndoSend = vi.fn(async () => restoredDraft);
    useEmailStore.setState({
      sendEmail: vi.fn(async () => {
        useEmailStore.setState({ pendingUndoSend: { submissionId: 'sub1', emailId: 'e1', identityId: 'id-1', sendAt, isSmime: false } });
        return { scheduled: true, emailSubmissionId: 'sub1', emailId: 'e1', sendAt };
      }),
      cancelUndoSend,
    } as never);
  });

  afterEach(() => {
    useEmailStore.setState(originalEmail);
    window.bulwarkDesktop = undefined;
  });

  type Sending = { onSend: (data: object) => Promise<unknown>; onClose: () => void };
  const DATA = { to: ['a@example.org'], cc: [], bcc: [], subject: 'Hi', body: 'Text', localAccountId: 'alice' };

  /** Opens the window, sends from it and lets the composer close, as it does after a send. */
  async function sendFromWindow(seconds: number) {
    sendAt = new Date(Date.now() + seconds * 1000).toISOString();
    window.history.replaceState(null, '', '/en/popout/compose?draft=d0&account=alice');
    render(<PopoutComposeApp />);
    await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Before sending'));
    const props = composer as unknown as Sending;
    await act(async () => { await props.onSend(DATA); });
    act(() => props.onClose());
  }

  it('stays open with "Sending in" and Undo, and does not hand the undo to the main window', async () => {
    await sendFromWindow(5);
    expect(screen.getByTestId('popout-sending').textContent).toContain('sending_in');
    expect(screen.getByRole('button', { name: 'undo_send' })).toBeInTheDocument();
    expect(closeSelf).not.toHaveBeenCalled();
    const sent = heard.find((message) => message.type === 'sent') as Extract<PopoutMessage, { type: 'sent' }> | undefined;
    expect(sent?.notice.pendingUndoSend ?? null).toBeNull();
    // compose-p2-13: the main window asks for the Scheduled count again then.
    expect(sent?.notice.releasesAt).toBe(sendAt);
  });

  // compose-24: the window sat with a greyed Send until the server answered.
  it('says "Sending…" as soon as Send goes through, before the server answers', async () => {
    let answer!: () => void;
    useEmailStore.setState({ sendEmail: vi.fn(() => new Promise((resolve) => { answer = () => resolve({}); })) } as never);
    sendAt = new Date(Date.now() + 5000).toISOString();
    window.history.replaceState(null, '', '/en/popout/compose?draft=d0&account=alice');
    render(<PopoutComposeApp />);
    await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Before sending'));
    let done: Promise<unknown> = Promise.resolve();
    act(() => { done = (composer as unknown as Sending).onSend(DATA); });
    expect(screen.getByTestId('popout-sending').textContent).toMatch(/sending$/);
    await act(async () => { answer(); await done; });
  });

  it('shows the composer again with its text when the send fails', async () => {
    useEmailStore.setState({ sendEmail: vi.fn(async () => { throw new Error('refused'); }) } as never);
    sendAt = new Date(Date.now() + 5000).toISOString();
    window.history.replaceState(null, '', '/en/popout/compose?draft=d0&account=alice');
    render(<PopoutComposeApp />);
    await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Before sending'));
    await act(async () => {
      await expect((composer as unknown as Sending).onSend(DATA)).rejects.toThrow('refused');
    });
    expect(screen.queryByTestId('popout-sending')).toBeNull();
    expect(screen.getByTestId('composer').closest('.hidden')).toBeNull();
  });

  it('closes once the undo time is over', async () => {
    await sendFromWindow(1.2);
    expect(closeSelf).not.toHaveBeenCalled();
    // As the main window's toast: "Sent" once Undo is over (compose-24).
    await waitFor(() => expect(screen.getByTestId('popout-sending').textContent).toMatch(/(^|\.)sent$/), { timeout: 3000 });
    await waitFor(() => expect(closeSelf).toHaveBeenCalled(), { timeout: 4000 });
  });

  it('Undo takes the send back and opens the message again in this window', async () => {
    await sendFromWindow(30);
    fireEvent.click(screen.getByRole('button', { name: 'undo_send' }));
    await waitFor(() => expect(cancelUndoSend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ submissionId: 'sub1', localAccountId: 'alice' })));
    await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Back again'));
    expect(closeSelf).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get('draft')).toBe('e1');
  });

  it('a message scheduled for later still goes to the main window, and the window closes', async () => {
    await sendFromWindow(3600);
    // "Sending…" may still show as the window goes, but no Undo here.
    expect(screen.queryByRole('button', { name: 'undo_send' })).toBeNull();
    expect(closeSelf).toHaveBeenCalled();
    const sent = heard.find((message) => message.type === 'sent') as Extract<PopoutMessage, { type: 'sent' }> | undefined;
    expect(sent?.notice.pendingUndoSend?.submissionId).toBe('sub1');
  });
});
