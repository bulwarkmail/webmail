import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastContainer } from '@/components/ui/toast';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore, setClientForTests } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useToastStore } from '@/stores/toast-store';
import { JMAPClient } from '@/lib/jmap/client';
import { clearUndoHistory, undoHistory, undoLatest } from '@/lib/undo-history';
import { useAccountStore } from '@/stores/account-store';
import { snapshotAccount, evictAll } from '@/lib/account-state-manager';
import { currentStoreEpoch } from '@/lib/store-epoch';
import { AccountSwitcher } from '@/components/layout/account-switcher';
import type { Email, Mailbox } from '@/lib/jmap/types';

// Only layout/drag machinery is replaced; controls, row rendering, stores,
// toast helper, error parser and JMAPClient.batchMarkAsRead are real.
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/hooks/use-email-drag', () => ({ useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }) }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 80, size: 80 })),
    getTotalSize: () => count * 80, measureElement() {}, measure() {}, scrollToOffset() {}, scrollToIndex() {},
    measurementsCache: [], scrollOffset: 0, scrollRect: null,
  }),
}));

vi.mock('@/components/email/email-composer', () => ({ EmailComposer: () => null }));
vi.mock('@/components/layout/sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/calendar-event-notification-toaster', () => ({ CalendarEventNotificationToaster: () => null }));
vi.mock('@/components/layout/share-notification-toaster', () => ({ ShareNotificationToaster: () => null }));
vi.mock('@/components/layout/mobile-header', () => ({ MobileHeader: () => null }));
vi.mock('@/components/email/message-list-tabs', () => ({ useMessageListPanelProps: (id: string) => ({ id }), MessageListTabs: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ activeTour: null, registerStep: vi.fn() }) }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-config', async () => {
  const { createConfig } = await import('@/lib/__tests__/fixtures/config');
  const config = createConfig({ settingsSyncEnabled: false });
  return { useConfig: () => config, getCachedConfig: () => config, fetchConfig: async () => config };
});
vi.mock('@/hooks/use-identity-sync', () => ({ useIdentitySync: () => {} }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({ useProMultiAccountIdentities: () => [] }));
vi.mock('@/hooks/use-pro-multi-account-mailboxes', () => ({ useProMultiAccountMailboxes: () => {} }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => null, canWopiOpen: () => false }));
vi.mock('@/hooks/use-browser-navigation', () => ({ useBrowserNavigation: () => {} }));
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-media-query')>()),
  useDeviceDetection: () => ({ isMobile: false, isCompact: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
  useIsMobile: () => false,
}));
vi.mock('@/lib/push-bindings', () => ({ reconcilePushBindings: () => {}, releasePushBindings: () => {} }));

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
  const Lazy = React.lazy(async () => ({ default: await load() }));
  return (props: Record<string, unknown>) => <React.Suspense fallback={null}><Lazy {...props}/></React.Suspense>;
} }));

await import('@/components/email/email-viewer');
const { MailApp } = await import('../mail-app');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { usePolicyStore } = await import('@/stores/policy-store');
const initial = useEmailStore.getInitialState();
const initialTabs = useMessageListTabsStore.getInitialState();
const mail = (id: string): Email => ({
  id, blobId: `blob-${id}`, threadId: `thread-${id}`, mailboxIds: { inbox: true },
  keywords: { '$label:work': true, $flagged: true }, size: 100,
  receivedAt: '2026-11-12T09:00:00Z', from: [{ name: 'Synthetic sender', email: 'sender@example.invalid' }],
  to: [{ email: 'audit@example.invalid' }], subject: `Synthetic ${id}`, preview: 'Audit fixture',
  hasAttachment: false, textBody: [], htmlBody: [], attachments: [], bodyValues: {},
}) as Email;
const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 2, totalThreads: 2,
  unreadEmails: 2, unreadThreads: 2, myRights: { mayReadItems: true, maySetSeen: true, mayAddItems: true },
} as Mailbox;
function deferred<T>() { let resolve!: (v:T)=>void; let reject!: (v:unknown)=>void;
  const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
type Reply = ReturnType<typeof response>;
let client: JMAPClient;
let request: ReturnType<typeof vi.spyOn>;
let service: ReturnType<typeof deferred<Reply>>;
let network: ReturnType<typeof vi.fn>;
let rich: Email;

function Harness() {
  const toasts = useToastStore(s => s.toasts);
  return <><MailApp /><ToastContainer toasts={toasts} onClose={useToastStore.getState().removeToast} /></>;
}
const row = (id: string) => document.querySelector(`[data-email-id="${id}"]`)!;
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const select = (id: string) => fireEvent.click(row(id), { ctrlKey: true });
const bulk = () => screen.getByTestId('batch-mark-read');
function expectConfirmed(read: string[], folderUnread = 2 - read.length) {
  const s=useEmailStore.getState();
  for(const id of ['a','b']) {
    expect(!!s.emails.find(e=>e.id===id)!.keywords.$seen).toBe(read.includes(id));
    expect(s.emails.find(e=>e.id===id)!.keywords).toMatchObject({ '$label:work': true, $flagged: true });
    expect(row(id)).toHaveAttribute('data-unread', String(!read.includes(id)));
  }
  expect(s.mailboxes[0]).toMatchObject({ totalEmails:2,totalThreads:2,unreadEmails:folderUnread,unreadThreads:folderUnread });
  expect(s.tagCounts).toEqual({work:{total:2,unread:2-read.length}});
}
const response = (ids: string[], refused: string[]) => ({ methodResponses: [['Email/set', {
  accountId:'audit-account',oldState:'state-before',newState:'state-after',
  updated:Object.fromEntries(ids.filter(id=>!refused.includes(id)).map(id=>[id,null])),
  notUpdated:Object.fromEntries(refused.map(id=>[id,{type:'forbidden',description:`Synthetic refusal for ${id}`}]))
},'0']],sessionState:'synthetic-session' });

beforeEach(() => {
  vi.useFakeTimers();
  network=vi.fn(() => { throw new Error('Unexpected network access'); }); vi.stubGlobal('fetch',network);
  vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} });
  client=new JMAPClient('https://mail.example.invalid','audit@example.invalid','synthetic');
  Object.assign(client,{ accountId:'audit-account',apiUrl:'https://mail.example.invalid/api' });
  vi.spyOn(client,'getMaxObjectsInSet').mockReturnValue(1000);
  service=deferred<Reply>(); request=vi.spyOn(client as unknown as { request: (methods: unknown[]) => Promise<Reply> },'request').mockImplementation(()=>service.promise);
  useAuthStore.setState({client,activeAccountId:'audit-login',getClientForAccount:()=>client,identities:[]});
  useEmailStore.setState(initial,true); useMessageListTabsStore.setState(initialTabs,true);
  useEmailStore.setState({emails:[mail('a'),mail('b')],mailboxes:[{...inbox}],selectedMailbox:'inbox',
    selectedEmail:null,selectedEmailKeys:new Set(),isLoading:false,hasMoreEmails:false,tagCounts:{work:{total:2,unread:2}},
    isUnifiedView:false,viewingAccountId:null,accountMailboxes:{},threadEmailsCache:new Map(),processingReadStatus:new Set()});
  useSettingsStore.setState({disableThreading:true,markAsReadDelay:-1,enableUnifiedMailbox:false,
    interfaceLayout:'default',mailLayout:'split',emailKeywords:[{id:'work',label:'Work',color:'blue'}]} as never);
  useToastStore.setState({toasts:[]}); clearUndoHistory();
  usePluginStore.setState({initializePlugins:vi.fn().mockResolvedValue(undefined)});
  useThemeStore.setState({syncServerThemes:vi.fn().mockResolvedValue(undefined)});
  usePolicyStore.setState({loaded:true,partial:false,fetching:false,fetchPolicy:vi.fn().mockResolvedValue(undefined),refreshIfPartial:vi.fn().mockResolvedValue(undefined)});
  useAuthStore.setState({isAuthenticated:true,isLoading:false,getAllConnectedClients:()=>new Map([['audit-login',client]])});
  rich = { ...mail('a'), preview: 'Full reader preview', textBody: [{ partId: '1', blobId: 'body-1', size: 16, type: 'text/plain' }], bodyValues: { '1': { value: 'Full reader body', isTruncated: false } }, keywords: { ...mail('a').keywords, $answered: true } };
  vi.spyOn(client,'getEmail').mockImplementation(async(id:string)=>id === 'a' ? rich : mail(id));
  useEmailStore.setState({fetchMailboxes:vi.fn().mockResolvedValue(undefined),fetchEmails:vi.fn().mockResolvedValue(undefined),
    fetchQuota:vi.fn().mockResolvedValue(undefined),fetchTagCounts:vi.fn().mockResolvedValue(undefined),
    refreshScheduledMetadata:vi.fn().mockResolvedValue(undefined)} as never);
});
afterEach(() => {
  cleanup();
  expect(network).not.toHaveBeenCalled();
  vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();
});



async function openAndSelect(read = false) {
  if (read) {
    rich = { ...rich, keywords: { ...rich.keywords, $seen: true } };
    useEmailStore.getState().setEmails([mail('a'), mail('b')].map(e => ({ ...e, keywords: { ...e.keywords, $seen: true } })));
    useEmailStore.setState({ mailboxes: [{ ...inbox, unreadEmails: 0, unreadThreads: 0 }], tagCounts: { work: { total: 2, unread: 0 } } });
  }
  render(<Harness />); await tick();
  fireEvent.click(row('a')); await tick();
  expect(useEmailStore.getState().selectedEmail).toEqual(rich);
  select('a'); select('b'); await tick();
  fireEvent.click(bulk()); await tick();
  expect(request).toHaveBeenCalledTimes(1);
  expectPatch(0, ['a', 'b'], !read);
  expect(bulk()).toBeDisabled(); fireEvent.click(bulk()); expect(request).toHaveBeenCalledTimes(1);
}
function expectPatch(index: number, ids: string[], read: boolean) {
  expect(request.mock.calls[index]).toEqual([[['Email/set', { accountId: 'audit-account',
    update: Object.fromEntries(ids.map(id => [id, { 'keywords/$seen': read ? true : null }])),
  }, '0']]]);
}
async function finish(ids: string[], refused: string[] = []) {
  await act(async () => { service.resolve(response(ids, refused)); await vi.advanceTimersByTimeAsync(0); });
}
function nextRequest() {
  service = deferred<Reply>(); request.mockImplementationOnce(() => service.promise);
}
it.each([false, true])('shows the inverse reader control after bulk read (partial=%s) and dispatches unread', async partial => {
  await openAndSelect(); expectConfirmed([]);
  await finish(['a', 'b'], partial ? ['b'] : []);
  expect(useEmailStore.getState().selectedEmail).toEqual({ ...rich, keywords: { ...rich.keywords, $seen: true } });
  expectConfirmed(partial ? ['a'] : ['a', 'b']);
  expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
  expect(useToastStore.getState().toasts.at(-1)?.type).toBe(partial ? 'error' : 'success');
  expect(undoHistory()).toHaveLength(partial ? 0 : 1);
  nextRequest(); fireEvent.click(screen.getByTitle('mark_unread')); await tick();
  expect(request).toHaveBeenCalledTimes(2); expectPatch(1, ['a'], false);
  await finish(['a']); expectConfirmed(partial ? [] : ['b']);
  expect(useEmailStore.getState().selectedEmail?.keywords.$seen).toBe(false);
  expect(screen.getByTitle('mark_read')).toBeEnabled();
});
it('keeps a refused reader unread and permits an explicit reader retry', async () => {
  await openAndSelect(); await finish(['a', 'b'], ['a']);
  expect(useEmailStore.getState().selectedEmail).toBe(rich); expectConfirmed(['b']);
  expect(undoHistory()).toHaveLength(0);
  expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ type: 'error', message: 'Failed to mark as read: Synthetic refusal for a' });
  nextRequest(); fireEvent.click(screen.getByTitle('mark_read')); await tick();
  expect(request).toHaveBeenCalledTimes(2); expectPatch(1, ['a'], true);
  expect(useEmailStore.getState().processingReadStatus.size).toBe(1);
  await finish(['a']); expectConfirmed(['a', 'b']);
  expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
  expect(screen.getByTitle('mark_unread')).toBeEnabled();
});
it('marks the reader unread with bulk, then its inverse sends read', async () => {
  await openAndSelect(true); await finish(['a', 'b']);
  expect(useEmailStore.getState().selectedEmail).toEqual({ ...rich, keywords: { ...rich.keywords, $seen: false } });
  expectConfirmed([]); expect(undoHistory()).toHaveLength(1);
  nextRequest(); fireEvent.click(screen.getByTitle('mark_read')); await tick(); expectPatch(1, ['a'], true);
  await finish(['a']); expectConfirmed(['a']); expect(screen.getByTitle('mark_unread')).toBeEnabled();
});
it.each([false, true])('Undo restores reader keywords and tag counts after bulk read=%s', async read => {
  await openAndSelect(!read); await finish(['a', 'b']); expectConfirmed(read ? ['a', 'b'] : []);
  const undoA = deferred<Reply>(); const undoB = deferred<Reply>();
  request.mockImplementationOnce(() => undoA.promise).mockImplementationOnce(() => undoB.promise);
  await act(async () => { undoLatest(); await vi.advanceTimersByTimeAsync(0); });
  expect(request).toHaveBeenCalledTimes(3); expectPatch(1, ['a'], !read); expectPatch(2, ['b'], !read);
  await act(async () => { undoA.resolve(response(['a'], [])); undoB.resolve(response(['b'], [])); await vi.advanceTimersByTimeAsync(0); });
  // The existing keyword Undo updates tag counts, but leaves folder counters
  // as they were after the bulk action. Keep that separate behavior unchanged.
  expectConfirmed(read ? [] : ['a', 'b'], read ? 0 : 2);
  expect(!!useEmailStore.getState().selectedEmail?.keywords.$seen).toBe(!read);
  expect(screen.getByTitle(read ? 'mark_read' : 'mark_unread')).toBeEnabled();
});
it('reselects an accepted message with the refused one and counts the retry only once', async () => {
  await openAndSelect(); await finish(['a', 'b'], ['b']); expectConfirmed(['a']);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  select('a'); select('b'); nextRequest(); fireEvent.click(bulk()); await tick(); expectPatch(1, ['a', 'b'], true);
  expectConfirmed(['a']); await finish(['a', 'b']); expectConfirmed(['a', 'b']);
  expect(useEmailStore.getState().selectedEmail?.keywords.$seen).toBe(true);
  expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
});

it.each([true, false])('preserves an unstamped B reader when A bulk read=%s completes after the real account switch', async read => {
  const b = new JMAPClient('https://mail.example.invalid', 'b@example.invalid', 'synthetic');
  Object.assign(b, { accountId: 'b-owner', apiUrl: 'https://mail.example.invalid/api' });
  const bReader = { ...rich, subject: 'B namesake', preview: 'B full reader',
    keywords: { ...rich.keywords, ...(!read ? { $seen: true } : {}) } };
  vi.spyOn(b, 'getEmail').mockResolvedValue(bReader);
  vi.spyOn(b, 'getIdentities').mockResolvedValue([{ id: 'b-identity', email: 'b@example.invalid', name: 'B', mayDelete: false }]);
  const bRequest = vi.spyOn(b as unknown as { request: (methods: unknown[]) => Promise<Reply> }, 'request');
  bRequest.mockRejectedValue(new Error('Unexpected B mutation'));
  const entry = (id: string, username: string, slot: number) => ({ id, username, email: username,
    label: username, displayName: id, serverUrl: 'https://mail.example.invalid', cookieSlot: slot,
    authMode: 'basic' as const, rememberMe: false, isConnected: true, hasError: false,
    lastLoginAt: 1, avatarColor: '#123456', isDefault: slot === 0,
    serverIdentifiers: [`${username}@mail.example.invalid`] });
  useAccountStore.setState({ accounts: [entry('audit-login', 'audit@example.invalid', 0), entry('b-login', 'b@example.invalid', 1)], activeAccountId: 'audit-login' });
  setClientForTests('audit-login', client); setClientForTests('b-login', b);
  useAuthStore.setState({ getClientForAccount: useAuthStore.getInitialState().getClientForAccount,
    getAllConnectedClients: useAuthStore.getInitialState().getAllConnectedClients });
  useSettingsStore.setState({ flushSync: vi.fn().mockResolvedValue(undefined) });
  // A previously loaded B inbox is restored by the actual account-state manager.
  const aState = useEmailStore.getState();
  useEmailStore.setState({ emails: [bReader], selectedEmail: null });
  snapshotAccount('b-login'); useEmailStore.setState(aState, true);
  try {
    await openAndSelect(!read);
    const epoch = currentStoreEpoch();
    render(<AccountSwitcher variant="expanded" />);
    expect(screen.getByTestId('account-switcher')).toBeEnabled();
    fireEvent.click(screen.getByTestId('account-switcher'));
    const option = screen.getAllByTestId('account-option').find(e => e.dataset.accountId === 'b-login')!;
    expect(option).toBeEnabled(); // Bulk processing disables its own controls, not account switching.
    fireEvent.click(option); await tick();
    expect(useAuthStore.getState().client).toBe(b);
    expect(useAuthStore.getState().activeAccountId).toBe('b-login');
    expect(currentStoreEpoch()).toBeGreaterThan(epoch);
    fireEvent.click(row('a')); await tick();
    const selectedB = useEmailStore.getState().selectedEmail!;
    expect(selectedB).toEqual(bReader);
    expect(selectedB.sourceAccountId).toBeUndefined();
    expect(selectedB.sourceClientAccountId).toBeUndefined();
    await finish(['a', 'b']);
    const state = useEmailStore.getState();
    // Keep the reader evidence separate from the older captured-list completion.
    console.info('bulk ownership completion', JSON.stringify({ read,
      activeAccount: useAuthStore.getState().activeAccountId,
      list: state.emails.map(e => ({ subject: e.subject, seen: e.keywords.$seen ?? false })),
      reader: { subject: state.selectedEmail?.subject, seen: state.selectedEmail?.keywords.$seen ?? false } }));
    expect(state.selectedEmail).toBe(selectedB);
    expect(screen.getByTitle(read ? 'mark_read' : 'mark_unread')).toBeEnabled();
    expect(bRequest).not.toHaveBeenCalled();
  } finally { evictAll(); }
});
