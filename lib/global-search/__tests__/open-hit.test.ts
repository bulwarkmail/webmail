import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileHit, MailHit } from '../types';
import type { FileNode } from '@/lib/jmap/types';
import { appPath } from '@/lib/deep-links';

// Opening a Files hit: a node of a drive shared with the user has no path
// under the login's own root, so its link names it by id.

const setPendingDeepLink = vi.fn();
// Whether a Files page is open and listening (see deliverDeepLink).
const deliverDeepLink = vi.fn((..._args: unknown[]) => false);
vi.mock('@/lib/deep-link-handoff', () => ({
  setPendingDeepLink: (...args: unknown[]) => setPendingDeepLink(...args),
  deliverDeepLink: (...args: unknown[]) => deliverDeepLink(...args),
}));

function storeHook(state: object) {
  const hook = (selector?: (s: object) => unknown) => (typeof selector === 'function' ? selector(state) : state);
  hook.getState = () => state;
  hook.setState = (patch: object) => Object.assign(state, patch);
  hook.subscribe = () => () => {};
  return hook;
}

const authState = { activeAccountId: 'login-a', getClientForAccount: () => undefined, switchAccount: vi.fn() };
const fileState = { currentAccountId: 'login-a', initClient: vi.fn() };
const tabState = { openTab: vi.fn(), openEmailTab: vi.fn() };
vi.mock('@/stores/auth-store', () => ({ useAuthStore: storeHook(authState) }));
vi.mock('@/stores/file-store', () => ({ useFileStore: storeHook(fileState) }));
vi.mock('@/stores/pro-tab-store', () => ({ useProTabStore: storeHook(tabState) }));

const { openHit } = await import('../open-hit');

const T = '2026-09-01T08:00:00Z';

function hit(node: Partial<FileNode> & Pick<FileNode, 'id' | 'name'>, folderPath: string, isFolder = false): FileHit {
  const full: FileNode = {
    parentId: null, type: isFolder ? '' : 'application/pdf', blobId: isFolder ? null : 'b1', size: 1, created: T, modified: T, ...node,
  };
  return {
    kind: 'files',
    localAccountId: 'login-a',
    jmapAccountId: full.accountId ?? 'me',
    id: full.id.includes(':') ? full.id.split(':')[1] : full.id,
    accountLabel: 'A',
    title: full.name,
    subtitle: folderPath,
    date: T,
    source: 'remote',
    node: full,
    folderPath,
    isFolder,
  };
}

// A file shared on its own (its folder isn't shared), a shared folder, and a
// file of the user's own drive.
const sharedFile = hit({ id: 'owner1:n5', name: 'Q3 plan.pdf', parentId: 'owner1:d0', isShared: true, accountId: 'owner1' }, '/Documents');
const sharedFolder = hit({ id: 'owner1:d1', name: 'Project X', isShared: true, accountId: 'owner1' }, '/', true);
const ownFile = hit({ id: 'f1', name: 'a.txt', parentId: 'd1' }, '/Docs');

beforeEach(() => {
  vi.clearAllMocks();
  deliverDeepLink.mockReturnValue(false);
});

describe('openHit for Files', () => {
  it('links a shared file by id, with the file to preview, in the standard layout', async () => {
    const navigate = vi.fn();
    await openHit(sharedFile, { proShell: false, navigate });
    expect(navigate).toHaveBeenCalledWith(appPath('/files?shared=owner1%3An5&preview=Q3%20plan.pdf'));

    await openHit(sharedFolder, { proShell: false, navigate });
    expect(navigate).toHaveBeenLastCalledWith(appPath('/files?shared=owner1%3Ad1'));
  });

  it('keeps linking the user\'s own files by path', async () => {
    const navigate = vi.fn();
    await openHit(ownFile, { proShell: false, navigate });
    expect(navigate).toHaveBeenCalledWith(appPath('/files/Docs?preview=a.txt'));
  });

  // A Files page takes a link without a query from the address bar instead,
  // where a shared folder on screen still says `?shared=`.
  it('hands an own folder over with an empty query, in both layouts', async () => {
    const ownFolder = hit({ id: 'd7', name: 'Docs' }, '/', true);
    deliverDeepLink.mockReturnValue(true);
    await openHit(ownFolder, { proShell: false, navigate: vi.fn() });
    expect(deliverDeepLink).toHaveBeenCalledWith('files', ['Docs'], '');

    await openHit(ownFolder, { proShell: true });
    expect(setPendingDeepLink).toHaveBeenCalledWith('files', ['Docs'], '');
  });

  it('hands the shared link to the Files tab in the Pro shell', async () => {
    await openHit(sharedFile, { proShell: true });
    expect(tabState.openTab).toHaveBeenCalledWith('files');
    expect(setPendingDeepLink).toHaveBeenCalledWith('files', [], '?shared=owner1%3An5&preview=Q3%20plan.pdf');
  });

  it('hands the link to a Files page that is already open instead of navigating, in the standard layout', async () => {
    // Next keeps the page mounted when only the query changes, and the page
    // reads the route only when it mounts.
    deliverDeepLink.mockReturnValue(true);
    const navigate = vi.fn();
    await openHit(sharedFile, { proShell: false, navigate });
    expect(deliverDeepLink).toHaveBeenCalledWith('files', [], '?shared=owner1%3An5&preview=Q3%20plan.pdf');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates for a hit of another login, which has to switch logins first', async () => {
    deliverDeepLink.mockReturnValue(true);
    const navigate = vi.fn();
    await openHit({ ...sharedFile, localAccountId: 'login-b' }, { proShell: false, navigate });
    expect(authState.switchAccount).toHaveBeenCalledWith('login-b');
    expect(deliverDeepLink).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(appPath('/files?shared=owner1%3An5&preview=Q3%20plan.pdf'));
  });
});

// A message of the team account `c`, which Stalwart numbers alike on every
// install, as it numbers the messages: the id also names other accounts'
// messages. The Pro email tab reads it through the login it names.
describe('openHit for mail in the Pro shell', () => {
  const mailHit = (localAccountId: string): MailHit => ({
    kind: 'mail', localAccountId, jmapAccountId: 'c', id: 'eaaaaab', accountLabel: 'A', title: 'Hello',
    subtitle: 'Inbox', date: T, source: 'remote', snippet: null, email: { id: 'eaaaaab' } as MailHit['email'],
  });

  it('opens a hit of the active login with that login, not through the mail list', async () => {
    await openHit(mailHit('login-a'), { proShell: true, pane: 'main' });
    expect(tabState.openEmailTab).toHaveBeenCalledWith(
      { accountId: 'c', clientAccountId: 'login-a', emailId: 'eaaaaab', mailboxId: null, title: 'Hello' },
      { pane: 'main', reuseReader: true },
    );
  });

  it('opens a hit of another login with that login', async () => {
    await openHit(mailHit('login-b'), { proShell: true, pane: 'main' });
    expect(tabState.openEmailTab).toHaveBeenCalledWith(
      { accountId: 'c', clientAccountId: 'login-b', emailId: 'eaaaaab', mailboxId: null, title: 'Hello' },
      { pane: 'main', reuseReader: true },
    );
  });
});

// The standard layout opens a hit by its address. With several logins signed
// in an address that names no login opens nothing, so the hit's address
// names its login then.
describe('openHit for mail in the standard layout', () => {
  const mailHit: MailHit = {
    kind: 'mail', localAccountId: 'login-a', jmapAccountId: 'c', id: 'eaaaaab', accountLabel: 'A', title: 'Hello',
    subtitle: 'Inbox', date: T, source: 'remote', snippet: null, email: { id: 'eaaaaab' } as MailHit['email'],
  };

  it('names the hit\'s login while two logins are signed in', async () => {
    const { useAccountStore } = await import('@/stores/account-store');
    const before = useAccountStore.getState().accounts;
    useAccountStore.setState({ accounts: [{ id: 'login-a' }, { id: 'login-b' }] as never });
    try {
      const navigate = vi.fn();
      await openHit(mailHit, { proShell: false, navigate });
      expect(navigate).toHaveBeenCalledWith(appPath('/mail/message/eaaaaab?account=login-a&owner=c'));
    } finally {
      useAccountStore.setState({ accounts: before });
    }
  });

  it('keeps the address as it was for a single login', async () => {
    const navigate = vi.fn();
    await openHit(mailHit, { proShell: false, navigate });
    expect(navigate).toHaveBeenCalledWith(appPath('/mail/message/eaaaaab?owner=c'));
  });
});
