import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { openPopoutChannel, type PopoutMessage, type RescuedDraft } from '@/lib/popout/channel';
import { createComposeHandoff, rememberComposePayload } from '@/lib/popout/compose-handoff';
import { useAuthStore } from '@/stores/auth-store';
import { usePluginStore } from '@/stores/plugin-store';

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
}));
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: vi.fn() }));

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

  beforeEach(() => {
    closeSelf.mockClear();
    window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { closeSelf } } as never;
  });

  afterEach(() => {
    window.bulwarkDesktop = undefined;
  });

  const draft = {
    id: 'd1', subject: 'Half-written', to: [{ email: 'a@example.org' }], cc: [], bcc: [], from: [{ email: 'me@example.org' }],
    bodyValues: { t: { value: 'Text' } }, textBody: [{ partId: 't', type: 'text/plain' }], htmlBody: [], attachments: [{ blobId: 'b1', name: 'a.pdf', type: 'application/pdf', size: 3 }],
  };

  const openDraft = (getEmail: ReturnType<typeof vi.fn>, search = 'draft=d1&account=alice&owner=group') => {
    useAuthStore.setState({ client: { getEmail } as never, getClientForAccount: () => undefined } as never);
    window.history.replaceState(null, '', `/en/popout/compose?${search}`);
    render(<PopoutComposeApp />);
  };

  it('reads the draft from where it lives, and opens the composer on it, id and all', async () => {
    const getEmail = vi.fn(async () => draft);
    openDraft(getEmail);
    await waitFor(() => expect(screen.getByTestId('composer').textContent).toBe('Half-written'));
    expect(getEmail).toHaveBeenCalledWith('d1', 'group');
    // Saving goes over this draft, not next to it, and its files stay.
    expect(composer?.initialData).toMatchObject({ draftId: 'd1', draftAccountId: 'group', draftLocalAccountId: 'alice', to: 'a@example.org' });
    expect((composer?.initialData as unknown as { attachments: unknown[] }).attachments).toHaveLength(1);
  });

  it('a draft that has gone since (sent elsewhere) closes the window', async () => {
    openDraft(vi.fn(async () => null));
    await waitFor(() => expect(closeSelf).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('composer')).toBeNull();
  });

  it('a server that doesn\'t answer closes it too: the draft is safe on the server', async () => {
    openDraft(vi.fn(async () => { throw new Error('offline'); }));
    await waitFor(() => expect(closeSelf).toHaveBeenCalledTimes(1));
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
