import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Email, FileNode } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFileStore } from '@/stores/file-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { fileHooks } from '@/lib/plugin-hooks';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
const composeOpen = vi.hoisted(() => vi.fn(() => 'opened'));
vi.mock('../plugin-sandbox/host-api-compose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plugin-sandbox/host-api-compose')>()),
  doComposeOpen: composeOpen,
}));

import { dispatchApiCall, PERM_PER_METHOD } from '../plugin-sandbox/host-api';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { snapshotHostFeatures } from '../plugin-sandbox/host-features';
import { withAssistantRuntime } from '../plugin-sandbox/assistant/runtime';
import { forgetFileListing } from '../plugin-sandbox/assistant/d';
import { registerComposer, resetComposers } from '../plugin-sandbox/composer-registry';

// api.files (area d of the assistant's host APIs): find, read and attach
// the user's files, save attachments, create, move and rename, only in
// the user's own drive and never in a shared folder, with the Files hooks.

function plugin(perms: string[], id = 'ai-assistant'): InstalledPlugin {
  return {
    id, name: 'AI Assistant', version: '2.2.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}
const ASSISTANT = plugin(['email:read', 'files:read', 'files:write', 'compose:write', 'compose:open']);
const call = (method: string, ...args: unknown[]) => dispatchApiCall(ASSISTANT, method, args);

const node = (n: Partial<FileNode> & { id: string; name: string }): FileNode => ({
  parentId: null, type: 'd', blobId: null, size: 0, created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z', ...n,
} as FileNode);
const folder = (id: string, name: string, parentId: string | null = null, extra: Partial<FileNode> = {}) => node({ id, name, parentId, ...extra });
const file = (id: string, name: string, parentId: string | null, type: string, modified: string, extra: Partial<FileNode> = {}) =>
  node({ id, name, parentId, type, blobId: `blob-${id}`, size: 100, modified, ...extra });

const BOB = { 'bob-principal': { mayRead: true, mayWrite: false } } as unknown as FileNode['shareWith'];

/** The user's own drive. */
function ownNodes(): FileNode[] {
  return [
    folder('docs', 'Documents'),
    file('notes', 'notes.md', 'docs', 'text/markdown', '2026-10-30T10:00:00Z'),
    file('budget', 'budget 2026.xlsx', 'docs', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '2026-10-20T10:00:00Z'),
    file('photo', 'whiteboard.jpg', 'docs', 'image/jpeg', '2026-09-01T10:00:00Z'),
    file('report', 'report.pdf', null, 'application/pdf', '2026-10-31T10:00:00Z'),
    folder('team', 'Team', null, { shareWith: BOB }),
    folder('team-sub', 'Plans', 'team'),
    file('team-notes', 'team notes.md', 'team-sub', 'text/markdown', '2026-10-01T10:00:00Z'),
    node({ id: 'link', name: 'notes link', nodeType: 'symlink', blobId: null, type: '' }),
    folder('trash', '.Trash'),
    folder('batch', '1730112000000~docs', 'trash'),
    file('gone', 'old notes.md', 'batch', 'text/markdown', '2026-10-31T12:00:00Z'),
  ];
}
/** Bob's drive, as the user sees what he shared (listAllFileNodesAcrossAccounts). */
const bobNodes = (): FileNode[] => [
  folder('bob:root', 'Bob home', null, { isShared: true, accountId: 'bob', accountName: 'Bob', discoverableOnly: true }),
  file('bob:plan', 'Bob plan.txt', 'bob:root', 'text/plain', '2026-10-15T10:00:00Z', { isShared: true, accountId: 'bob', accountName: 'Bob' }),
];

const RULES = { forbiddenChars: '/<>:"\\|?*', forbiddenNames: ['.', '..', 'CON', 'NUL'], maxNameBytes: 255 };
const message = {
  id: 'm1', threadId: 't1', blobId: 'raw', size: 4, mailboxIds: { inbox: true }, keywords: {}, subject: 'Invoice',
  receivedAt: '2026-05-01T10:00:00Z', attachments: [{ partId: '2', blobId: 'blob-inv', name: 'invoice.pdf', type: 'application/pdf', size: 1234 }],
} as unknown as Email;

let own: FileNode[];
let client: Record<string, ReturnType<typeof vi.fn>>;
let seq = 0;

beforeEach(() => {
  seq = 0;
  resetPluginRateLimits();
  resetComposers();
  forgetFileListing();
  composeOpen.mockClear();
  own = ownNodes();
  client = {
    supportsFiles: vi.fn(() => true),
    listAllFileNodesAcrossAccounts: vi.fn(async () => [...own, ...bobNodes()]),
    listAllFileNodes: vi.fn(async () => own),
    fetchBlobArrayBuffer: vi.fn(async () => new TextEncoder().encode('# Notes\n\nLaunch on 12 December.').buffer),
    uploadBlob: vi.fn(async (f: File) => ({ blobId: `up-${++seq}`, size: f.size, type: f.type })),
    createFileNode: vi.fn(async (name: string, blobId: string, type: string, size: number, parentId: string | null) => ({ id: `new-${++seq}`, name, blobId, type, parentId, size: 0, created: '', modified: '' })),
    createFileDirectory: vi.fn(async (name: string, parentId: string | null) => ({ id: `dir-${++seq}`, name, parentId, blobId: null, type: 'd', size: 0, created: '', modified: '' })),
    updateFileNode: vi.fn(async () => undefined),
    replaceFileNodeBlob: vi.fn(async () => undefined),
    getFileNameRules: vi.fn(() => RULES),
    getMaxFileNodeDepth: vi.fn(() => 64),
    getAccountId: vi.fn(() => 'me'),
    getFilesAccountId: vi.fn(() => 'me'),
    copyBlobs: vi.fn(),
    getEmail: vi.fn(async (id: string) => (id === 'm1' ? message : null)),
    getMailboxes: vi.fn(async () => []),
  };
  useAuthStore.setState({ client: client as unknown as IJMAPClient, activeAccountId: 'login-a' });
  useEmailStore.setState({ selectedEmail: null, emails: [], mailboxes: [], selectedMailbox: '' });
  usePolicyStore.setState({ policy: DEFAULT_POLICY });
});

afterEach(() => {
  useAuthStore.setState({ client: null });
  for (const bus of Object.values(fileHooks)) bus.clear();
  useFileStore.setState({ client: null, hasListed: false });
});

describe('api.files: offered, gated, and nothing that deletes or shares', () => {
  it('has exactly these methods, each behind files:read or files:write', () => {
    const methods = Object.entries(PERM_PER_METHOD).filter(([m]) => m.startsWith('files.'));
    expect(Object.fromEntries(methods)).toEqual({
      'files.find': 'files:read', 'files.list': 'files:read', 'files.getText': 'files:read', 'files.getImage': 'files:read',
      'files.attach': 'files:read',
      'files.saveAttachments': 'files:write', 'files.create': 'files:write', 'files.createFolder': 'files:write',
      'files.move': 'files:write', 'files.rename': 'files:write',
    });
    const api = withAssistantRuntime({} as { files?: Record<string, unknown> }, async () => null);
    expect(Object.keys(api.files ?? {}).sort()).toEqual(['attach', 'create', 'createFolder', 'find', 'getImage', 'getText', 'list', 'move', 'rename', 'saveAttachments']);
  });

  it('refuses without the permissions', async () => {
    await expect(dispatchApiCall(plugin(['email:read']), 'files.find', [{}])).rejects.toThrow(/lacks permission "files:read"/);
    await expect(dispatchApiCall(plugin(['files:read']), 'files.create', [{ name: 'a.md', content: 'x', type: 'text/markdown' }])).rejects.toThrow(/lacks permission "files:write"/);
    await expect(dispatchApiCall(plugin(['files:read']), 'files.attach', [['notes'], { composerId: 'c1' }])).rejects.toThrow(/lacks permission "compose:write"/);
    await expect(dispatchApiCall(plugin(['files:read']), 'files.attach', [['notes'], { newDraft: {} }])).rejects.toThrow(/lacks permission "compose:open"/);
    await expect(dispatchApiCall(plugin(['files:write']), 'files.saveAttachments', ['m1', ['blob-inv']])).rejects.toThrow(/lacks permission "email:read"/);
    expect(client.uploadBlob).not.toHaveBeenCalled();
    expect(client.createFileNode).not.toHaveBeenCalled();
  });

  it('says files only where the server has Files and the administrator left it on', async () => {
    expect(snapshotHostFeatures()).toMatchObject({ files: true });
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, features: { ...DEFAULT_POLICY.features, filesEnabled: false } } });
    expect(snapshotHostFeatures()).toMatchObject({ files: false });
    await expect(call('files.find', {})).rejects.toThrow(/Files is not available/);
    usePolicyStore.setState({ policy: DEFAULT_POLICY });
    client.supportsFiles.mockReturnValue(false);
    expect(snapshotHostFeatures()).toMatchObject({ files: false });
    await expect(call('files.list')).rejects.toThrow(/Files is not available/);
  });
});

describe('files.find and files.list', () => {
  it('finds own and shared files, without the trash, symlinks and the folders above a shared file', async () => {
    const all = (await call('files.find', { limit: 50 })) as { id: string }[];
    const ids = all.map((f) => f.id);
    expect(ids).not.toEqual(expect.arrayContaining(['trash']));
    for (const hidden of ['trash', 'batch', 'gone', 'link', 'bob:root']) expect(ids).not.toContain(hidden);
    expect(ids).toEqual(expect.arrayContaining(['notes', 'report', 'bob:plan', 'docs']));
    // Newest first.
    expect(ids[0]).toBe('report');
    const plan = all.find((f) => f.id === 'bob:plan');
    expect(plan).toMatchObject({ name: 'Bob plan.txt', kind: 'file', shared: true, owner: 'Bob', path: '/Bob home' });
    expect(all.find((f) => f.id === 'notes')).toEqual({
      id: 'notes', name: 'notes.md', path: '/Documents', parentId: 'docs', kind: 'file', mimeType: 'text/markdown', size: 100, modified: '2026-10-30T10:00:00Z',
    });
  });

  it('filters by words, kind, folder and dates, and keeps the listing for a minute', async () => {
    const names = async (q: unknown) => ((await call('files.find', q)) as { name: string }[]).map((f) => f.name);
    expect(await names({ text: 'NOTES' })).toEqual(['notes.md', 'team notes.md']);
    expect(await names({ text: 'notes', folderId: 'docs' })).toEqual(['notes.md']);
    expect(await names({ kind: 'spreadsheet' })).toEqual(['budget 2026.xlsx']);
    expect(await names({ kind: 'image' })).toEqual(['whiteboard.jpg']);
    expect(await names({ kind: 'folder' })).toEqual(['Documents', 'Team', 'Plans']);
    expect(await names({ kind: 'document', modifiedAfter: '2026-10-25' })).toEqual(['report.pdf', 'notes.md']);
    expect(await names({ modifiedBefore: '2026-09-02', kind: 'image' })).toEqual(['whiteboard.jpg']);
    expect(await names({ limit: 1 })).toEqual(['report.pdf']);
    expect(client.listAllFileNodesAcrossAccounts).toHaveBeenCalledTimes(1);
    await expect(call('files.find', { kind: 'video' })).rejects.toThrow(/kind must be one of/);
    await expect(call('files.find', { folderId: 'trash' })).rejects.toThrow(/no file or folder/);
  });

  it('lists the top of the drive with what others shared, and a folder', async () => {
    const top = ((await call('files.list')) as { name: string }[]).map((f) => f.name);
    expect(top).toEqual(['Documents', 'Team', 'Bob plan.txt', 'report.pdf']);
    const docs = ((await call('files.list', 'docs')) as { name: string }[]).map((f) => f.name);
    expect(docs).toEqual(['budget 2026.xlsx', 'notes.md', 'whiteboard.jpg']);
    await expect(call('files.list', 'notes')).rejects.toThrow(/not a folder/);
  });
});

describe('files.getText', () => {
  it('reads a file with the attachment reader, and a shared one from its owner\'s account', async () => {
    const out = await call('files.getText', 'notes');
    expect(out).toMatchObject({ name: 'notes.md', format: 'text', status: 'ok', text: '# Notes\n\nLaunch on 12 December.', truncated: false });
    expect(client.fetchBlobArrayBuffer).toHaveBeenLastCalledWith('blob-notes', 'notes.md', 'text/markdown');
    await call('files.getText', 'bob:plan');
    expect(client.fetchBlobArrayBuffer).toHaveBeenLastCalledWith('blob-bob:plan', 'Bob plan.txt', 'text/plain', 'bob');
    await expect(call('files.getText', 'docs')).rejects.toThrow(/is a folder/);
    await expect(call('files.getText', 'gone')).rejects.toThrow(/no file or folder/);
  });
});

describe('files.attach', () => {
  it('attaches to the open draft by blob, with the login that holds the files', async () => {
    const attachFile = vi.fn(async () => true);
    const { id } = registerComposer({
      readBody: () => ({ html: '', text: '' }), readSelection: () => ({ html: '', text: '', empty: true }),
      replaceBody: () => true, replaceSelection: () => true, attach: vi.fn(async () => true), attachFile,
    });
    const out = await call('files.attach', ['notes', 'bob:plan'], { composerId: id });
    expect(out).toEqual({ attached: ['notes.md', 'Bob plan.txt'], refused: [] });
    expect(attachFile).toHaveBeenCalledWith({ blobId: 'blob-notes', name: 'notes.md', type: 'text/markdown', size: 100, sourceAccountId: 'login-a' });
    await expect(call('files.attach', ['docs'], { composerId: id })).rejects.toThrow(/is a folder/);
    await expect(call('files.attach', ['notes'], { composerId: 'gone' })).rejects.toThrow(/not open any more/);
  });

  it('opens a new draft with the files through compose.open', async () => {
    const out = await call('files.attach', ['report'], { newDraft: { to: ['bob@example.org'], subject: 'Report' } });
    expect(out).toEqual({ attached: ['report.pdf'], refused: [] });
    expect(composeOpen).toHaveBeenCalledWith(ASSISTANT, {
      to: ['bob@example.org'], subject: 'Report',
      attachments: [{ blobId: 'blob-report', name: 'report.pdf', type: 'application/pdf', size: 100 }],
    });
  });
});

describe('writes stay in the user\'s own drive', () => {
  const create = (input: Record<string, unknown>) => call('files.create', { content: '# Minutes', type: 'text/markdown', ...input });

  it('creates a Markdown file in a folder, with the upload hooks, and lets the server number a taken name', async () => {
    const before = vi.fn(() => true);
    const after = vi.fn();
    fileHooks.onBeforeFileUpload.register('other', before);
    fileHooks.onAfterFileUpload.register('other', after);
    const out = (await create({ folderId: 'docs', name: 'notes.md' })) as { file: { name: string; path: string } };
    expect(before).toHaveBeenCalledWith({ name: 'notes.md', size: 9, type: 'text/markdown', path: '/Documents' });
    expect(client.uploadBlob).toHaveBeenCalledTimes(1);
    // Never an overwrite: createFileNode sends onExists rename ("notes (2).md").
    expect(client.createFileNode).toHaveBeenCalledWith('notes.md', 'up-1', 'text/markdown', 9, 'docs');
    expect(client.updateFileNode).not.toHaveBeenCalled();
    expect(client.replaceFileNodeBlob).not.toHaveBeenCalled();
    expect(out.file).toMatchObject({ path: '/Documents', parentId: 'docs', kind: 'file', mimeType: 'text/markdown' });
    await vi.waitFor(() => expect(after).toHaveBeenCalledWith(expect.objectContaining({ name: 'notes.md', type: 'file', path: '/Documents' })));
  });

  it('stops when another plugin vetoes the upload', async () => {
    fileHooks.onBeforeFileUpload.register('dlp', () => false);
    await expect(create({ name: 'secret.md' })).rejects.toThrow(/another plugin stopped this/);
    expect(client.uploadBlob).not.toHaveBeenCalled();
    expect(client.createFileNode).not.toHaveBeenCalled();
  });

  it('refuses shared folders, other people\'s drives and the trash', async () => {
    await expect(create({ folderId: 'team', name: 'a.md' })).rejects.toThrow(/shared with others/);
    await expect(create({ folderId: 'team-sub', name: 'a.md' })).rejects.toThrow(/shared with others/);
    await expect(create({ folderId: 'bob:root', name: 'a.md' })).rejects.toThrow(/drive someone shared with you/);
    await expect(create({ folderId: 'batch', name: 'a.md' })).rejects.toThrow(/in your own files/);
    await expect(create({ folderId: 'trash', name: 'a.md' })).rejects.toThrow(/in your own files/);
    await expect(call('files.createFolder', { parentId: 'team', name: 'New' })).rejects.toThrow(/shared with others/);
    await expect(call('files.move', 'notes', 'team-sub')).rejects.toThrow(/shared with others/);
    await expect(call('files.move', 'notes', 'bob:root')).rejects.toThrow(/another person's drive/);
    await expect(call('files.move', 'team-notes', 'docs')).rejects.toThrow(/shared with others/);
    await expect(call('files.move', 'notes', 'trash')).rejects.toThrow(/in your own files/);
    await expect(call('files.rename', 'team-notes', 'x.md')).rejects.toThrow(/shared with others/);
    await expect(call('files.rename', 'bob:plan', 'x.txt')).rejects.toThrow(/drive someone shared with you/);
    await expect(call('files.saveAttachments', 'm1', ['blob-inv'], 'team')).rejects.toThrow(/shared with others/);
    await expect(create({ replace: 'team-notes' })).rejects.toThrow(/shared with others/);
    expect(client.uploadBlob).not.toHaveBeenCalled();
    expect(client.createFileNode).not.toHaveBeenCalled();
    expect(client.createFileDirectory).not.toHaveBeenCalled();
    expect(client.updateFileNode).not.toHaveBeenCalled();
  });

  it('refuses names the server would refuse, and says why', async () => {
    await expect(create({ name: 'con.txt' })).rejects.toThrow(/reserved/);
    await expect(create({ name: 'a:b.md' })).rejects.toThrow(/may not contain :/);
    await expect(create({ name: 'a\u0001b.md' })).rejects.toThrow(/control characters/);
    await expect(call('files.rename', 'notes', 'NUL')).rejects.toThrow(/reserved/);
    await expect(call('files.rename', 'notes', 'budget 2026.xlsx')).rejects.toThrow(/already something named/);
    await expect(call('files.createFolder', { name: '.Trash' })).rejects.toThrow(/trash/);
    await expect(create({ name: 'a.md', type: 'application/pdf' })).rejects.toThrow(/type must be/);
    expect(client.uploadBlob).not.toHaveBeenCalled();
  });

  it('replaces a text file and keeps the old version in the Files trash', async () => {
    const out = (await create({ replace: 'notes', content: 'New text' })) as { file: { id: string; size: number }; kept: unknown };
    // A trash folder for this change, under the existing .Trash, named like a delete from Documents.
    expect(client.createFileDirectory).toHaveBeenCalledTimes(1);
    expect(client.createFileDirectory).toHaveBeenCalledWith(expect.stringMatching(/^\d{13}~docs$/), 'trash');
    const batchId = (await client.createFileDirectory.mock.results[0].value).id;
    // The old version: a copy pointing at the old blob.
    expect(client.createFileNode).toHaveBeenCalledWith('notes.md', 'blob-notes', 'text/markdown', 100, batchId);
    expect(client.replaceFileNodeBlob).toHaveBeenCalledWith('notes', 'up-1');
    // The copy is made before the content changes.
    expect(client.createFileNode.mock.invocationCallOrder[0]).toBeLessThan(client.replaceFileNodeBlob.mock.invocationCallOrder[0]);
    expect(out).toMatchObject({ file: { id: 'notes', size: 8 }, kept: { trashFolder: '.Trash', name: 'notes.md' } });
  });

  it('makes the trash folder when there is none yet, and only replaces text files', async () => {
    own = own.filter((n) => !['trash', 'batch', 'gone'].includes(n.id));
    await create({ replace: 'notes', content: 'New' });
    expect(client.createFileDirectory.mock.calls[0]).toEqual(['.Trash', null]);
    await expect(create({ replace: 'budget' })).rejects.toThrow(/only text and Markdown/);
    await expect(create({ replace: 'docs' })).rejects.toThrow(/is a folder/);
  });

  it('creates a folder and tells plugins', async () => {
    const seen = vi.fn();
    fileHooks.onDirectoryCreate.register('other', seen);
    const out = await call('files.createFolder', { parentId: 'docs', name: '2026' });
    expect(client.createFileDirectory).toHaveBeenCalledWith('2026', 'docs');
    expect(out).toMatchObject({ name: '2026', kind: 'folder', path: '/Documents', parentId: 'docs' });
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith(expect.objectContaining({ name: '2026', type: 'directory', path: '/Documents' })));
  });

  it('moves within the own drive with the move hooks, and says where it was', async () => {
    const moved = vi.fn();
    fileHooks.onFileMove.register('other', moved);
    const out = await call('files.move', 'notes', null);
    expect(client.updateFileNode).toHaveBeenCalledWith('notes', { parentId: null });
    expect(out).toMatchObject({ file: { id: 'notes', parentId: null, path: '/' }, previousFolderId: 'docs' });
    await vi.waitFor(() => expect(moved).toHaveBeenCalledWith({ files: [expect.objectContaining({ id: 'notes' })], toPath: '/' }));
    await expect(call('files.move', 'docs', 'docs')).rejects.toThrow(/into itself/);
    await expect(call('files.move', 'budget', 'docs')).rejects.toThrow(/already there/);
  });

  it('stops a move and a rename another plugin vetoes', async () => {
    fileHooks.onBeforeFileMove.register('dlp', () => false);
    fileHooks.onBeforeFileRename.register('dlp', () => false);
    await expect(call('files.move', 'notes', null)).rejects.toThrow(/another plugin stopped this/);
    await expect(call('files.rename', 'notes', 'minutes.md')).rejects.toThrow(/another plugin stopped this/);
    expect(client.updateFileNode).not.toHaveBeenCalled();
  });

  it('renames with the rename hooks and says the old name', async () => {
    const before = vi.fn(() => true);
    fileHooks.onBeforeFileRename.register('other', before);
    const out = await call('files.rename', 'notes', 'minutes.md');
    expect(before).toHaveBeenCalledWith({ file: expect.objectContaining({ id: 'notes', name: 'notes.md', path: '/Documents' }), newName: 'minutes.md' });
    expect(client.updateFileNode).toHaveBeenCalledWith('notes', { name: 'minutes.md' });
    expect(out).toMatchObject({ file: { name: 'minutes.md' }, previousName: 'notes.md' });
  });

  it('saves attachments by blob into an own folder, and another plugin can stop one', async () => {
    const out = await call('files.saveAttachments', 'm1', ['blob-inv'], 'docs');
    expect(client.createFileNode).toHaveBeenCalledWith('invoice.pdf', 'blob-inv', 'application/pdf', 1234, 'docs');
    expect(out).toMatchObject({ saved: [{ name: 'invoice.pdf', path: '/Documents', size: 1234 }], stopped: [] });
    await expect(call('files.saveAttachments', 'm1', ['blob-other'], 'docs')).rejects.toThrow(/not an attachment of this message/);
    fileHooks.onBeforeFileUpload.register('dlp', () => false);
    expect(await call('files.saveAttachments', 'm1', ['blob-inv'], null)).toEqual({ saved: [], stopped: ['invoice.pdf'] });
    expect(client.createFileNode).toHaveBeenCalledTimes(1);
  });

  it('refreshes the open Files view and the listing after a change', async () => {
    const refresh = vi.fn(async () => {});
    useFileStore.setState({ client: client as unknown as IJMAPClient, hasListed: true, refresh });
    await call('files.find', {});
    await call('files.rename', 'notes', 'minutes.md');
    expect(refresh).toHaveBeenCalledTimes(1);
    await call('files.find', {});
    expect(client.listAllFileNodesAcrossAccounts).toHaveBeenCalledTimes(2);
  });

  it('allows 20 changes a minute', async () => {
    for (let i = 0; i < 20; i++) await call('files.createFolder', { name: `F${i}` });
    await expect(call('files.createFolder', { name: 'F20' })).rejects.toThrow(/at most 20 changes/);
  });
});
