import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { JMAPClient } from '@/lib/jmap/client';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { ComposerDraftData } from '@/components/email/email-composer';
import type { ComposePopoutPayload } from '@/lib/popout/compose-payload';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useToastStore } from '@/stores/toast-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useUIStore } from '@/stores/ui-store';
import { handOffComposeTab, takeHandedOffComposeDraft, useProTabStore } from '@/stores/pro-tab-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { resetComposerSessions } from '@/lib/plugin-composer-hooks';
import { clearRescuedDrafts, keepRescuedDraft } from '@/lib/popout/rescued-drafts';
import { commitReturnedComposer, offerReturnedComposer, takeReturnedComposer } from '@/lib/popout/return-to-main';

// Real MailApp, EmailComposer, stores, responsive hooks and composer hosts.
// Only surrounding UI and external services are replaced. In particular, no
// recovery callback or composer lifecycle is implemented by this test.
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/layout/sidebar', () => ({
  Sidebar: ({ onCompose }: { onCompose: () => void }) => <button onClick={onCompose}>stub compose</button>,
}));
vi.mock('@/components/email/rich-text-editor', () => ({ RichTextEditor: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/lib/plugin-storage', async original => ({ ...await original<typeof import('@/lib/plugin-storage')>(), fileStorage: {
  saveFile: vi.fn().mockResolvedValue(undefined), getFile: vi.fn().mockResolvedValue(null), deleteFile: vi.fn().mockResolvedValue(undefined),
} }));
vi.mock('@/components/search/mv-search-form', () => ({
  MvSearchForm: ({ onSearch }: { onSearch: () => void }) => <button onClick={onSearch}>stub filter search</button>,
}));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => <div>message viewer</div> }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/layout/mv-side-panel', () => ({ MvSidePanel: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }), getCachedConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }), stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }) }));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));
const synthetic = vi.hoisted(() => ({ draft: null as Email | null }));
vi.mock('@/components/email/email-list', () => ({
  EmailList: ({ onEditDraft }: { onEditDraft: (email: Email) => void }) => (
    <button onClick={() => onEditDraft(synthetic.draft!)}>open saved B</button>
  ),
}));
const popout = vi.hoisted(() => ({
  handOver: vi.fn(async (_payload: ComposePopoutPayload) => true),
  cancel: vi.fn(),
}));
vi.mock('@/hooks/use-popouts-available', () => ({
  usePopoutsAvailable: () => true,
  useOpenEmailInWindow: () => null,
}));
vi.mock('@/lib/popout/open', () => ({ openComposerWindow: () => popout }));

const { MailApp } = await import('../mail-app');
const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 } as Mailbox;
const original = {
  auth: useAuthStore.getState(), email: useEmailStore.getState(), settings: useSettingsStore.getState(),
  identity: useIdentityStore.getState(), ui: useUIStore.getState(), pro: useProTabStore.getState(),
  plugins: usePluginStore.getState(), theme: useThemeStore.getState(),
};
const submit = vi.fn(() => { throw new Error('Mail submission is forbidden'); });
let client: ReturnType<typeof makeClient>;
function makeClient() {
  return {
    getAccountId: () => 'acc', getUsername: () => 'a@example.org',
    getSieveAccountId: () => null, hasDelayedSend: () => false, getSession: () => null,
    getMaxDelayedSend: () => 0,
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    createDraft: vi.fn(async (...args: Parameters<IJMAPClient['createDraft']>) => `saved-${args[1]}`),
    getEmail: vi.fn().mockResolvedValue(null),
    uploadBlob: vi.fn().mockResolvedValue({ blobId: 'completed-B-blob', size: 12, type: 'text/plain', accountId: 'acc' }),
    sendEmail: submit, sendRawEmail: submit,
  };
}

// Feed synthetic viewport changes to the real useSyncExternalStore media hooks.
let viewportWidth = 1200;
type MediaQuery = MediaQueryList & { listeners: Set<(event: { matches: boolean; media: string }) => void> };
const mediaQueries = new Map<string, MediaQuery>();
function matchesWidth(query: string) {
  const conditions = [...query.matchAll(/\(width\s*(>=|<)\s*([\d.]+)rem\)/g)];
  return conditions.length > 0 && conditions.every(([, op, value]) =>
    op === '<' ? viewportWidth < Number(value) * 16 : viewportWidth >= Number(value) * 16);
}
function resize(width: number, afterResize?: () => void) {
  act(() => {
    viewportWidth = width;
    for (const [query, mq] of mediaQueries) {
      const previous = mq.matches;
      Object.assign(mq, { matches: matchesWidth(query) });
      if (previous !== mq.matches) for (const listener of mq.listeners) listener({ matches: mq.matches, media: query });
    }
    window.dispatchEvent(new Event('resize'));
    afterResize?.();
  });
}
function recoveryData(subject = 'Recovered'): ComposerDraftData {
  return { subject, body: `${subject} body`, to: '', cc: '', bcc: '', mode: 'compose',
    showCc: false, showBcc: false, selectedIdentityId: 'me', subAddressTag: '', draftId: null, plainTextMode: true };
}
beforeEach(() => {
  viewportWidth = 1200;
  mediaQueries.clear();
  vi.stubGlobal('matchMedia', (query: string) => {
    if (!mediaQueries.has(query)) {
      const listeners: MediaQuery['listeners'] = new Set();
      mediaQueries.set(query, {
        matches: matchesWidth(query), media: query, onchange: null, listeners,
        addEventListener: (_: string, fn: Parameters<MediaQuery['listeners']['add']>[0]) => { listeners.add(fn); },
        removeEventListener: (_: string, fn: Parameters<MediaQuery['listeners']['add']>[0]) => { listeners.delete(fn); },
        addListener: (fn: Parameters<MediaQuery['listeners']['add']>[0]) => { listeners.add(fn); },
        removeListener: (fn: Parameters<MediaQuery['listeners']['add']>[0]) => { listeners.delete(fn); },
        dispatchEvent: () => false,
      } as unknown as MediaQuery);
    }
    return mediaQueries.get(query)!;
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  vi.stubGlobal('XMLHttpRequest', class { constructor() { throw new Error('Unexpected XHR'); } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  submit.mockClear(); popout.handOver.mockClear(); popout.cancel.mockClear();
  resetComposerSessions(); clearRescuedDrafts(); takeReturnedComposer(); takeHandedOffComposeDraft();
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  client = makeClient();
  useAuthStore.setState({
    isAuthenticated: true, isLoading: false, client: client as unknown as JMAPClient, activeAccountId: 'login-a', identities: [],
    getClientForAccount: () => client as unknown as JMAPClient,
    getAllConnectedClients: () => new Map([['login-a', client as unknown as JMAPClient]]),
  });
  useSettingsStore.setState({ enableUnifiedMailbox: false, interfaceLayout: 'mountain-view', mailLayout: 'split',
    proInterface: false, plainTextMode: true, sendDelaySeconds: 0 });
  useEmailStore.setState({
    emails: [], selectedEmail: null, selectedMailbox: 'inbox', selectedKeyword: null, mailboxes: [inbox],
    viewingAccountId: null, accountMailboxes: {}, isUnifiedView: false, unifiedRole: null,
    isScheduledView: false, isLoadingEmail: false, isLoading: false, searchQuery: '',
    searchFilters: { ...DEFAULT_SEARCH_FILTERS }, searchMailboxId: '', isAdvancedSearchOpen: false,
    selectedEmailKeys: new Set(), unreadSection: null,
    fetchMailboxes: vi.fn().mockResolvedValue(undefined), fetchEmails: vi.fn().mockResolvedValue(undefined),
    fetchQuota: vi.fn().mockResolvedValue(undefined), fetchTagCounts: vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata: vi.fn().mockResolvedValue(undefined), sendEmail: submit, sendRawEmail: submit,
  });
  useIdentityStore.setState({ identities: [{ id: 'me', email: 'a@example.org', name: 'A', mayDelete: false }] });
  useUIStore.getState().setDeviceType(false, false, true);
  useProTabStore.setState({ tabs: [], activeTabId: '' });
  synthetic.draft = { id: 'draft-B', sourceAccountId: 'acc', sourceClientAccountId: 'login-a', subject: 'B subject',
    from: [{ email: 'a@example.org' }], to: [{ email: 'b@example.test' }], cc: [], bcc: [],
    keywords: { $draft: true }, mailboxIds: { drafts: true }, textBody: [{ partId: 'body', type: 'text/plain' }],
    bodyValues: { body: { value: 'B body' } }, attachments: [] } as unknown as Email;
  useToastStore.getState().clearToasts();
});
afterEach(() => {
  cleanup();
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  expect(submit).not.toHaveBeenCalled();
  resetComposerSessions(); clearRescuedDrafts(); takeReturnedComposer(); takeHandedOffComposeDraft();
  useAuthStore.setState(original.auth); useEmailStore.setState(original.email); useSettingsStore.setState(original.settings);
  useIdentityStore.setState(original.identity); useUIStore.setState(original.ui); useProTabStore.setState(original.pro);
  usePluginStore.setState(original.plugins); useThemeStore.setState(original.theme);
  useToastStore.getState().clearToasts();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const subject = () => screen.getByTestId('composer-subject');
const body = () => screen.getByRole('textbox', { name: 'body_label' });
function edit(subjectText: string, bodyText: string) {
  fireEvent.change(subject(), { target: { value: subjectText } });
  fireEvent.change(body(), { target: { value: bodyText } });
}
async function openFresh(strict: boolean) {
  const view = render(strict ? <React.StrictMode><MailApp /></React.StrictMode> : <MailApp />);
  fireEvent.click(screen.getByText('stub compose'));
  await screen.findByTestId('composer-subject');
  return view;
}
async function replaceWithB(strict: boolean, existingAttachment = false) {
  if (existingAttachment) synthetic.draft!.attachments = [{ partId: 'B-part', blobId: 'B-existing-blob', name: 'B-existing.txt', type: 'text/plain', size: 12 }];
  const view = await openFresh(strict);
  edit('A edited', 'A body edited');
  fireEvent.click(screen.getByText('open saved B'));
  await waitFor(() => expect(subject()).toHaveValue('B subject'));
  expect(body()).toHaveValue('B body');
  // Upstream explicitly saves A before opening B. Keep that behavior, then
  // count only B's persistence in the assertions below.
  expect(client.createDraft).toHaveBeenCalledTimes(1);
  expect(client.createDraft.mock.calls[0].slice(1, 3)).toEqual(['A edited', 'A body edited']);
  client.createDraft.mockClear();
  return view;
}
function expectB() {
  expect(subject()).toHaveValue('B subject'); expect(body()).toHaveValue('B body');
}

describe.each([false, true])('composer recovery ownership (Strict Mode: %s)', strict => {
  it.each([false, true])('keeps saved B after replacing edited A and resizing (existing attachment: %s)', async attachment => {
    await replaceWithB(strict, attachment);
    resize(500);
    await waitFor(expectB);
    expect(document.querySelector('[data-mv-compose-window]')).toBeNull();
    if (attachment) expect(screen.getByText('B-existing.txt')).toBeInTheDocument();
    resize(1200);
    await waitFor(expectB);
    expect(document.querySelector('[data-mv-compose-window]')).toBeInTheDocument();
    if (attachment) expect(screen.getByText('B-existing.txt')).toBeInTheDocument();
    expect(client.createDraft).not.toHaveBeenCalled(); expect(client.deleteEmail).not.toHaveBeenCalled();
  });
  it('keeps fresh edited text through repeated desktop/phone round trips', async () => {
    await openFresh(strict); edit('A edited', 'A body edited');
    for (const width of [500, 1200, 500, 1200]) {
      resize(width);
      await waitFor(() => expect(subject()).toHaveValue('A edited'));
      expect(body()).toHaveValue('A body edited');
    }
  });
  it('accepts intentionally empty edits after recovering nonempty text', async () => {
    await openFresh(strict); edit('A edited', 'A body edited');
    resize(500);
    await waitFor(() => expect(subject()).toHaveValue('A edited'));
    edit('', '');
    for (const width of [1200, 500, 1200]) {
      resize(width);
      await waitFor(() => expect(subject()).toHaveValue(''));
      expect(body()).toHaveValue('');
    }
    expect(client.createDraft).not.toHaveBeenCalled();
  });
  it('keeps B edits and a newly completed upload during responsive recovery', async () => {
    await replaceWithB(strict, true);
    edit('B edited', 'B body edited');
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['B attachment'], 'B-upload.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(client.uploadBlob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    for (const width of [500, 1200]) {
      resize(width);
      await waitFor(() => expect(subject()).toHaveValue('B edited'));
      expect(body()).toHaveValue('B body edited');
      expect(screen.getByText('B-existing.txt')).toBeInTheDocument(); expect(screen.getByText('B-upload.txt')).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByTestId('composer-subject')).toBeNull());
    const saved = client.createDraft.mock.calls.at(-1)!;
    expect(saved[1]).toBe('B edited'); expect(saved[2]).toBe('B body edited'); expect(saved[7]).toBe('draft-B');
    expect(saved[8]).toEqual(expect.arrayContaining([
      expect.objectContaining({ blobId: 'B-existing-blob' }), expect.objectContaining({ blobId: 'completed-B-blob' }),
    ]));
  });
  it('ordinary close/reopen keeps B and never revives A', async () => {
    await replaceWithB(strict, true);
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByTestId('composer-subject')).toBeNull());
    expect(screen.queryByTestId('continue-draft-bar')).toBeNull();
    fireEvent.click(screen.getByText('open saved B'));
    await waitFor(expectB); expect(screen.getByText('B-existing.txt')).toBeInTheDocument();
  });
  it('explicit Discard deletes B and suppresses recovery', async () => {
    await replaceWithB(strict);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole('button', { name: 'discard' }));
    expect(screen.queryByTestId('composer-subject')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(client.deleteEmail).not.toHaveBeenCalled();
    const discarded = useToastStore.getState().toasts.find(toast => toast.title === 'draft_discarded')!;
    await act(async () => { await vi.advanceTimersByTimeAsync(discarded.duration! + 1); });
    expect(client.deleteEmail).toHaveBeenCalledWith('draft-B', 'acc');
    expect(screen.queryByTestId('continue-draft-bar')).toBeNull();
    fireEvent.click(screen.getByText('stub compose'));
    await waitFor(() => expect(subject()).toHaveValue(''));
  });
  it('Discard Undo restores B and keeps its ownership during responsive recovery', async () => {
    await replaceWithB(strict, true);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole('button', { name: 'discard' }));
    expect(screen.queryByTestId('composer-subject')).toBeNull();
    const discarded = useToastStore.getState().toasts.find(toast => toast.title === 'draft_discarded')!;
    await act(async () => { discarded.action!.onClick(); });
    await waitFor(expectB);
    for (const width of [500, 1200]) {
      resize(width);
      await waitFor(expectB);
      expect(screen.getByText('B-existing.txt')).toBeInTheDocument();
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(discarded.duration! + 1); });
    expect(client.deleteEmail).not.toHaveBeenCalled();
  });
  it('intentional rescued-draft adoption and Continue preserve the snapshot', async () => {
    render(strict ? <React.StrictMode><MailApp /></React.StrictMode> : <MailApp />);
    act(() => keepRescuedDraft(recoveryData()));
    const bar = await screen.findByTestId('continue-draft-bar');
    fireEvent.click(within(bar).getByRole('button', { name: /continue_draft/ }));
    for (const width of [500, 1200]) {
      resize(width);
      await waitFor(() => expect(subject()).toHaveValue('Recovered'));
      expect(body()).toHaveValue('Recovered body');
    }
  });
});

it('preserves current-session edits when a recovered phone composer deliberately returns to Pro', async () => {
  const view = await openFresh(false); edit('A edited', 'A body edited');
  resize(500);
  await waitFor(() => expect(subject()).toHaveValue('A edited'));
  edit('A continued', 'A body continued');
  act(() => useSettingsStore.setState({ proInterface: true }));
  // The surrounding Pro route replaces the MailApp on widening. Simulate that
  // route unmount alongside the viewport event, keeping MailApp's real cleanup.
  resize(1200, view.unmount);
  const tabs = useProTabStore.getState().tabs.filter(tab => tab.kind === 'compose');
  expect(tabs).toHaveLength(1);
  expect(tabs[0].composeData?.initialData).toMatchObject({ subject: 'A continued', body: 'A body continued' });
});
it('preserves a Pro tab handoff and the edited snapshot handed back to Pro', async () => {
  const id = useProTabStore.getState().openComposeTab({ sessionId: 1, mode: 'compose', title: 'From Pro',
    initialData: recoveryData('From Pro'), sourceEmailId: 'source-A', sourceEmailSource: { clientAccountId: 'login-a', accountId: 'shared' } });
  handOffComposeTab(id);
  resize(500);
  const view = render(<MailApp />);
  await waitFor(() => expect(subject()).toHaveValue('From Pro'));
  edit('Pro edited', 'Pro edited body');
  act(() => useSettingsStore.setState({ proInterface: true }));
  resize(1200, view.unmount);
  const data = useProTabStore.getState().tabs.find(tab => tab.kind === 'compose')?.composeData;
  expect(data?.initialData).toMatchObject({ subject: 'Pro edited', body: 'Pro edited body' });
  expect(data?.sourceEmailId).toBe('source-A');
  expect(data?.sourceEmailSource).toEqual({ clientAccountId: 'login-a', accountId: 'shared' });
});
it('moves the authoritative snapshot to a pop-out without resurrecting inline recovery', async () => {
  await replaceWithB(false, true);
  resize(500);
  await waitFor(expectB);
  fireEvent.click(screen.getByTestId('composer-open-in-window'));
  await waitFor(() => expect(popout.handOver).toHaveBeenCalledTimes(1));
  expect(popout.handOver.mock.calls[0][0].initialData).toMatchObject({ subject: 'B subject', body: 'B body',
    attachments: [expect.objectContaining({ blobId: 'B-existing-blob' })] });
  await waitFor(() => expect(screen.queryByTestId('composer-subject')).toBeNull());
  expect(screen.queryByTestId('continue-draft-bar')).toBeNull();
});
it('accepts a deliberate pop-out return and retains it through responsive recovery', async () => {
  render(<MailApp />);
  const answer = vi.fn();
  act(() => offerReturnedComposer({ returnId: 'return-B', answer, payload: { mode: 'compose', initialData: recoveryData('Returned B') },
    sendReady: () => commitReturnedComposer('return-B') }));
  await waitFor(() => expect(subject()).toHaveValue('Returned B'));
  await waitFor(() => expect(answer).toHaveBeenCalledWith('shown'));
  for (const width of [500, 1200]) {
    resize(width);
    await waitFor(() => expect(subject()).toHaveValue('Returned B'));
    expect(body()).toHaveValue('Returned B body');
  }
});
