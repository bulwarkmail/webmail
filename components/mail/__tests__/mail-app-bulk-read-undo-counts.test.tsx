import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastContainer } from '@/components/ui/toast';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useToastStore } from '@/stores/toast-store';
import { JMAPClient } from '@/lib/jmap/client';
import { clearUndoHistory, undoHistory } from '@/lib/undo-history';
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

// Real standard MailApp, Sidebar, list, reader, toast/Undo history,
// email/auth/settings/toast stores, batchMarkAsRead and batchUpdateKeywords.
// Service reads are deferred and always derive from confirmed server messages.
await import('@/components/email/email-viewer');
const { MailApp } = await import('@/components/mail/mail-app');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useUIStore } = await import('@/stores/ui-store');
const { useAccountStore } = await import('@/stores/account-store');
const http = await import('node:http');
const https = await import('node:https');
const net = await import('node:net');
const initial = useEmailStore.getInitialState();
const initialTabs = useMessageListTabsStore.getInitialState();
const mail = (id: string, read = false): Email => ({
  id, blobId: `blob-${id}`, threadId: `thread-${id}`, mailboxIds: { inbox: true },
  keywords: { '$label:work': true, $flagged: true, ...(read ? { $seen: true } : {}) }, size: 100,
  receivedAt: '2026-11-12T09:00:00Z', from: [{ name: 'Synthetic sender', email: 'sender@example.invalid' }],
  to: [{ email: 'audit@example.invalid' }], subject: `Synthetic ${id}`, preview: 'Audit fixture',
  hasAttachment: false, textBody: [], htmlBody: [], attachments: [], bodyValues: {},
}) as Email;
function deferred<T>() { let resolve!: (v:T)=>void;
  const promise = new Promise<T>(a => { resolve=a; }); return { promise, resolve }; }
const clone = <T,>(x:T):T => JSON.parse(JSON.stringify(x));
let client: JMAPClient;
let server: Email[];
type Methods = [string, { accountId: string; update: Record<string, Record<string, boolean | null>> }, string][];
type Reply = { methodResponses: [string, Record<string, unknown>, string][]; sessionState: string };
let writes: Array<{ methods: Methods; deferred: ReturnType<typeof deferred<Reply>> }>;
let reads: Array<{ name:string; args:unknown[]; resolve:()=>void }>;
let network: ReturnType<typeof vi.fn>;

const counts = () => ({work:{ total:server.length, unread:server.filter(e=>!e.keywords.$seen).length }});
const folders = () => [{ id:'inbox',name:'Inbox',role:'inbox',totalEmails:3,totalThreads:3,
  unreadEmails:counts().work.unread, unreadThreads:counts().work.unread,
  myRights:{mayReadItems:true,maySetSeen:true,mayAddItems:true,mayRemoveItems:true,mayCreateChild:true} }] as Mailbox[];
function read<T>(kind:string,args:unknown[],result:()=>T):Promise<T> {
  const d=deferred<T>();
  reads.push({name:kind,args,resolve:()=>{d.resolve(clone(result()));}});
  return d.promise;
}
function Harness() {
  const toasts = useToastStore(s => s.toasts);
  return <><MailApp /><ToastContainer toasts={toasts} onClose={useToastStore.getState().removeToast} /></>;
}
const row = (id: string) => document.querySelector(`[data-email-id="${id}"]`)!;
const folderBadge = () => document.querySelector('[data-mailbox-id="inbox"] [data-testid="folder-counts"]');
const tagBadge = () => document.querySelector('[data-rail-key="tag:work"] [data-testid="folder-counts"]');
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const select = (id: string) => fireEvent.click(row(id), { ctrlKey: true });
const bulk = () => screen.getByTestId('batch-mark-read');
// Resolve all queued service reads, including ones caused by resolving earlier
// reads. Then advance 1 second through possible debounce work, draining again.
// Pending writes are deliberately left for explicit accept()/reject responses.
async function settle() {
  for (let round=0;round<30;round++) {
    await tick();
    if (reads.length) {
      const batch=reads.splice(0);
      await act(async()=>{ batch.forEach(r=>r.resolve()); await vi.advanceTimersByTimeAsync(0); });
    } else {
      await act(async()=>{ await vi.advanceTimersByTimeAsync(1000); });
      if (!reads.length) { await tick(); if (!reads.length) return; }
    }
  }
  throw new Error('Synthetic refreshes did not settle');
}
function compatible(readIds:string[],unread:number) {
  const s=useEmailStore.getState();
  expect(server.filter(e=>!e.keywords.$seen)).toHaveLength(unread);
  for(const id of ['a','b','c']) {
    const e=s.emails.find(e=>e.id===id)!;
    expect(!!e.keywords.$seen).toBe(readIds.includes(id));
    expect(e.keywords).toMatchObject({'$label:work':true,$flagged:true});
    expect(row(id)).toHaveAttribute('data-unread',String(!readIds.includes(id)));
  }
  expect(!!s.selectedEmail?.keywords.$seen).toBe(readIds.includes('a'));
  expect(screen.getByTitle(readIds.includes('a')?'mark_unread':'mark_read')).toBeEnabled();
  expect(s.selectedEmail?.bodyValues?.['1']?.value).toBe('Full reader body');
  expect(s.tagCounts).toEqual({work:{total:3,unread}});
  expect(tagBadge()).toHaveAttribute('data-unread',String(unread));
  expect(reads).toHaveLength(0);expect(writes).toHaveLength(0);
}
function coherentFolder(unread:number) {
  expect(useEmailStore.getState().mailboxes[0]).toMatchObject({totalEmails:3,totalThreads:3,unreadEmails:unread,unreadThreads:unread});
  expect(folderBadge()).toHaveAttribute('data-unread',String(unread));
}
async function respond(refused:string[]=[]) {
  const pending=writes.splice(0);expect(pending.length).toBeGreaterThan(0);
  await act(async()=>{
    for(const w of pending) {
      const [method,args,callId]=w.methods[0];expect(method).toBe('Email/set');expect(args.accountId).toBe('audit-account');
      const ids=Object.keys(args.update);
      for(const id of ids.filter(id=>!refused.includes(id))) {
        const e=server.find(e=>e.id===id)!;
        for(const [pointer,value] of Object.entries(args.update[id])) {
          expect(pointer).toBe('keywords/$seen');if(value) e.keywords.$seen=true;else delete e.keywords.$seen;
        }
      }
      const result={accountId:'audit-account',oldState:'before',newState:'after',
        updated:Object.fromEntries(ids.filter(id=>!refused.includes(id)).map(id=>[id,null])),
        notUpdated:Object.fromEntries(ids.filter(id=>refused.includes(id)).map(id=>[id,{type:'forbidden',description:`Synthetic restore refusal ${id}`}]))};
      w.deferred.resolve({methodResponses:[[method,result,callId]],sessionState:'synthetic'});
    }
    await vi.advanceTimersByTimeAsync(0);
  });
}
beforeEach(() => {
  vi.useFakeTimers();writes=[];reads=[];
  network=vi.fn(()=>{throw new Error('Unexpected network access denied');});vi.stubGlobal('fetch',network);
  vi.spyOn(http.default,'request').mockImplementation(network as never);vi.spyOn(http.default,'get').mockImplementation(network as never);
  vi.spyOn(https.default,'request').mockImplementation(network as never);vi.spyOn(https.default,'get').mockImplementation(network as never);
  vi.spyOn(net.Socket.prototype,'connect').mockImplementation(network as never);
  vi.stubGlobal('ResizeObserver',class { observe(){} unobserve(){} disconnect(){} });
  client=new JMAPClient('https://mail.example.invalid','audit@example.invalid','synthetic');
  Object.assign(client,{accountId:'audit-account',apiUrl:'https://mail.example.invalid/api'});
  vi.spyOn(client,'getMaxObjectsInSet').mockReturnValue(1000);
  vi.spyOn(client as unknown as { request: (methods: Methods) => Promise<Reply> },'request').mockImplementation((methods)=>{
    expect(methods).toHaveLength(1);expect(methods[0][0]).toBe('Email/set');
    const d=deferred<Reply>();writes.push({methods,deferred:d});return d.promise;
  });
  server=['a','b','c'].map(id=>mail(id));
  vi.spyOn(client,'getAllMailboxesWithState').mockImplementation((...args)=>read('mailboxes',args,()=>({mailboxes:folders(),states:{'audit-account':'synthetic-mailbox-state'}})));
  vi.spyOn(client,'getEmails').mockImplementation((...args)=>read('emails',args,()=>({emails:server,total:3,hasMore:false,threadCounts:{'thread-a':1,'thread-b':1,'thread-c':1}})));
  vi.spyOn(client,'getTagCounts').mockImplementation((...args)=>read('tags',args,counts));
  vi.spyOn(client,'getEmail').mockImplementation((...args)=>read('reader',args,()=>({...server.find(e=>e.id===args[0])!,
    textBody:[{partId:'1',blobId:'body-1',size:16,type:'text/plain'}],bodyValues:{'1':{value:'Full reader body',isTruncated:false}}})));
  vi.spyOn(client,'getThreads').mockImplementation((...args)=>read('threads',args,()=>server.map(e=>({id:e.threadId,emailIds:[e.id]}))));
  usePolicyStore.setState({loaded:true,partial:false,fetching:false,fetchPolicy:vi.fn().mockResolvedValue(undefined),refreshIfPartial:vi.fn().mockResolvedValue(undefined)});
  useAuthStore.setState({client,activeAccountId:'audit-login',getClientForAccount:()=>client,identities:[],
    isAuthenticated:true,isLoading:false,getAllConnectedClients:()=>new Map([['audit-login',client]])});
  useAccountStore.setState({accounts:[]});
  useEmailStore.setState(initial,true);useMessageListTabsStore.setState(initialTabs,true);
  useEmailStore.setState({emails:clone(server),mailboxes:folders(),selectedMailbox:'inbox',
    selectedEmail:null,selectedEmailKeys:new Set(),isLoading:false,hasMoreEmails:false,tagCounts:counts(),
    isUnifiedView:false,viewingAccountId:null,accountMailboxes:{},threadEmailsCache:new Map(),processingReadStatus:new Set()});
  useSettingsStore.setState({disableThreading:true,markAsReadDelay:-1,senderFavicons:false,enableUnifiedMailbox:false,
    interfaceLayout:'default',mailLayout:'split',emailKeywords:[{id:'work',label:'Work',color:'blue'}],
    unreadCountStyle:'number',showFolderTotalCount:true,folderCountModes:{}} as never);
  useUIStore.setState({sidebarCollapsed:false} as never);
  useToastStore.setState({toasts:[]});clearUndoHistory();
  usePluginStore.setState({initializePlugins:vi.fn().mockResolvedValue(undefined)});
  useThemeStore.setState({syncServerThemes:vi.fn().mockResolvedValue(undefined)});
  // Quota/scheduled metadata are outside this read-state audit; counter/list
  // refreshes, restore mutation and all read-state store methods stay real.
  useEmailStore.setState({fetchQuota:vi.fn().mockResolvedValue(undefined),refreshScheduledMetadata:vi.fn().mockResolvedValue(undefined)} as never);
});
afterEach(()=>{
  cleanup();
  try {expect(network).not.toHaveBeenCalled();expect(reads).toHaveLength(0);expect(writes).toHaveLength(0);}
  finally {vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();}
});
async function start(read=false) {
  if(read) {server.forEach(e=>e.keywords.$seen=true);useEmailStore.setState({emails:clone(server),mailboxes:folders(),tagCounts:counts()});}
  render(<Harness/>);await settle();
  fireEvent.click(row('a'));await settle();
  compatible(read?['a','b','c']:[],read?0:3);coherentFolder(read?0:3);
  select('a');select('b');await tick();fireEvent.click(bulk());await tick();
  expect(writes).toHaveLength(1);
  expect(writes[0].methods).toEqual([['Email/set',{accountId:'audit-account',update:{a:{'keywords/$seen':read?null:true},b:{'keywords/$seen':read?null:true}}},'0']]);
  expect(bulk()).toBeDisabled();
  await respond();await settle();
  compatible(read?['c']:['a','b'],read?2:1);coherentFolder(read?2:1);
  expect(useToastStore.getState().toasts.at(-1)?.type).toBe('success');expect(undoHistory()).toHaveLength(1);
}
async function clickUndo(originalRead=false) {
  // The actual offered toast button owns the history entry; no direct callback.
  fireEvent.click(screen.getByRole('button',{name:'undo'}));await tick();
  expect(undoHistory()).toHaveLength(0);expect(writes).toHaveLength(2);
  expect(writes.map(w=>w.methods)).toEqual(['a','b'].map(id=>[['Email/set',{
    accountId:'audit-account',update:{[id]:{'keywords/$seen':originalRead?true:null}}},'0']]));
}
it.each([false, true])('restores folder unread counts through rendered bulk Undo (initially read=%s)', async initiallyRead => {
  await start(initiallyRead);
  await clickUndo(initiallyRead);
  // No optimistic restoration while either service request is pending.
  coherentFolder(initiallyRead ? 2 : 1);
  await respond();
  await settle();
  compatible(initiallyRead ? ['a', 'b', 'c'] : [], initiallyRead ? 0 : 3);
  coherentFolder(initiallyRead ? 0 : 3);
  expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ type: 'success', title: 'undone' });
  expect(undoHistory()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'undo' })).toBeNull();
});

it('keeps the new account intact when a rendered Undo finishes after the account switcher loads a bare namesake', async () => {
  const { setClientForTests } = await import('@/stores/auth-store');
  const { snapshotAccount, clearAllStores, evictAll } = await import('@/lib/account-state-manager');
  const { useIdentityStore } = await import('@/stores/identity-store');
  evictAll();
  const account = (username: string, slot: number) => ({
    id: `${username}@mail.example.invalid`, username, email: username,
    serverUrl: 'https://mail.example.invalid', displayName: username, label: username,
    authMode: 'basic' as const, rememberMe: false, cookieSlot: slot,
    isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0,
  });
  const a = account('audit@example.invalid', 0), b = account('b@example.invalid', 1);
  const cb = new JMAPClient(b.serverUrl, b.username, 'synthetic');
  Object.assign(cb, { accountId: 'owner-b', apiUrl: 'https://mail.example.invalid/api' });
  const bRows = ['a', 'b', 'c'].map(id => ({ ...mail(id, id !== 'c'), subject: `B ${id}`, blobId: `B-${id}` }));
  const bCounts = () => ({ work: { total: 3, unread: bRows.filter(e => !e.keywords.$seen).length } });
  const bFolders = () => [{ ...folders()[0], unreadEmails: bCounts().work.unread, unreadThreads: bCounts().work.unread }];
  vi.spyOn(client, 'getSessionUsername').mockReturnValue(a.username);
  vi.spyOn(cb, 'getSessionUsername').mockReturnValue(b.username);
  vi.spyOn(cb, 'getIdentities').mockResolvedValue([{ id: 'owner-b', email: b.email, name: b.displayName, mayDelete: false }]);
  vi.spyOn(cb, 'getAllMailboxesWithState').mockImplementation((...args) => read('b-folders', args, () => ({ mailboxes: bFolders(), states: {} })));
  vi.spyOn(cb, 'getEmails').mockImplementation((...args) => read('b-emails', args, () => ({ emails: bRows, total: 3, hasMore: false,
    threadCounts: { 'thread-a': 1, 'thread-b': 1, 'thread-c': 1 } })));
  vi.spyOn(cb, 'getTagCounts').mockImplementation((...args) => read('b-tags', args, bCounts));
  vi.spyOn(cb, 'getEmail').mockImplementation((...args) => read('b-reader', args, () => ({ ...bRows.find(e => e.id === args[0])!,
    textBody: [{ partId: '1', blobId: 'B-body', size: 6, type: 'text/plain' }],
    bodyValues: { '1': { value: 'B reader body', isTruncated: false } } })));
  const bRequest = vi.spyOn(cb as unknown as { request: (methods: Methods) => Promise<Reply> }, 'request')
    .mockImplementation(() => { throw new Error('Unexpected B mutation'); });
  setClientForTests(a.id, client); setClientForTests(b.id, cb);
  useAccountStore.setState({ accounts: [a, b], activeAccountId: a.id, defaultAccountId: a.id });
  useSettingsStore.setState({ sidebarAccountSwitcher: true, flushSync: vi.fn().mockResolvedValue(undefined) } as never);
  useAuthStore.setState({ getClientForAccount: useAuthStore.getInitialState().getClientForAccount,
    getAllConnectedClients: useAuthStore.getInitialState().getAllConnectedClients });
  // Seed B through the same snapshot/restore path the connected-account UI
  // uses. No account-switch action or email-store completion method is mocked.
  useEmailStore.setState({ emails: clone(bRows), mailboxes: bFolders(), selectedMailbox: 'inbox', isLoading: false });
  useIdentityStore.setState({ identities: [{ id: 'owner-b', email: b.email, name: b.displayName, mayDelete: false }] });
  snapshotAccount(b.id); clearAllStores();
  useEmailStore.setState({ emails: clone(server), mailboxes: folders(), selectedMailbox: 'inbox', isLoading: false, tagCounts: counts() });
  useAuthStore.setState({ client, activeAccountId: a.id });
  await start(); await clickUndo();
  expect(writes).toHaveLength(2);
  expect(screen.getByTestId('account-switcher')).toBeEnabled();
  fireEvent.click(screen.getByTestId('account-switcher')); await tick();
  const option = document.querySelector(`[data-account-id="${b.id}"]`)!;
  expect(option).toBeEnabled(); fireEvent.click(option); await settle();
  expect(useAuthStore.getState().activeAccountId).toBe(b.id);
  // Switching resumes the target login's preferences; disable ancillary
  // favicons and automatic read again before opening its synthetic reader.
  await act(async () => { useSettingsStore.setState({ senderFavicons: false, markAsReadDelay: -1, disableThreading: true }); });
  fireEvent.click(row('a')); await settle();
  const before = clone({ folders: useEmailStore.getState().mailboxes, tags: useEmailStore.getState().tagCounts,
    keywords: useEmailStore.getState().emails.map(e => e.keywords), reader: useEmailStore.getState().selectedEmail });
  expect(before.folders[0].unreadEmails).toBe(1);
  expect(row('a')).toHaveTextContent('B a');
  await respond(); await settle();
  const after = clone({ folders: useEmailStore.getState().mailboxes, tags: useEmailStore.getState().tagCounts,
    keywords: useEmailStore.getState().emails.map(e => e.keywords), reader: useEmailStore.getState().selectedEmail });
  if (process.env.KEYWORD_OWNERSHIP_OBSERVATIONS === '1') console.info('UI_OWNERSHIP_OBSERVATION', JSON.stringify({ before, after,
    serverAUnread: counts().work.unread, serverBUnread: bCounts().work.unread, activeAccount: useAuthStore.getState().activeAccountId }));
  expect(counts().work.unread).toBe(3); // A's server accepted its restoration.
  expect(bRequest).not.toHaveBeenCalled();
  expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ type: 'success', title: 'undone' });
  expect.soft(after.folders, 'rendered folder completion ownership').toEqual(before.folders);
  expect.soft(after.tags).toEqual(before.tags); expect.soft(after.keywords).toEqual(before.keywords);
  expect.soft(after.reader).toEqual(before.reader);
  expect.soft(folderBadge()).toHaveAttribute('data-unread', '1');
});
