import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Mailbox } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { clearUndoHistory, undoHistory, undoLatest } from '../undo-history';
import { clearUndoTokens } from '../plugin-sandbox/assistant/c.undo';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(id: string, perms: string[]): InstalledPlugin {
  return {
    id, name: id, version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}
const WRITER = plugin('assistant', ['email:write']);
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const news = { id: 'news', name: 'Newsletters', role: null } as unknown as Mailbox;
const trash = { id: 'trash', name: 'Trash', role: 'trash' } as Mailbox;
const sharedOut = { id: 'team', name: 'Team', role: null, shareWith: { 'u2': { mayReadItems: true } } } as unknown as Mailbox;
const otherAccount = { id: 'acc2:box', name: 'Theirs', isShared: true, accountId: 'acc2' } as unknown as Mailbox;

const rows = [
  { id: 'm1', mailboxIds: { inbox: true }, keywords: { $seen: true }, receivedAt: '2026-10-01T10:00:00Z' },
  { id: 'm2', mailboxIds: { inbox: true, news: true }, keywords: {}, receivedAt: '2026-10-02T10:00:00Z' },
];
let getEmailFields: ReturnType<typeof vi.fn>;
let client: IJMAPClient;
const store = {
  batchArchive: vi.fn(async () => true),
  batchMoveToMailbox: vi.fn(async () => true),
  batchMarkAsRead: vi.fn(async () => true),
  batchSetTag: vi.fn(async () => true),
  undoMove: vi.fn(async () => {}),
};

beforeEach(() => {
  resetPluginRateLimits();
  clearUndoHistory();
  clearUndoTokens();
  for (const fn of Object.values(store)) fn.mockClear();
  getEmailFields = vi.fn(async (ids: string[]) => rows.filter((r) => ids.includes(r.id)));
  client = { getAccountId: () => 'acc1', getEmailFields } as unknown as IJMAPClient;
  useAuthStore.setState({ client });
  useEmailStore.setState({ mailboxes: [inbox, news, trash, sharedOut, otherAccount], ...store } as never);
  useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }] } as never);
});
afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('api.email.batch', () => {
  it('archives the messages of the account, as the store archives them, with one Undo', async () => {
    const result = await call(WRITER, 'email.batch', { emailIds: ['m1', 'm2', 'gone'], action: 'archive' }) as { done: number; failed: number; undoToken: string };
    expect(result).toMatchObject({ done: 2, failed: 1 });
    // From the signed-in account only, and through the store with an explicit target.
    expect(getEmailFields).toHaveBeenCalledWith(['m1', 'm2', 'gone'], expect.any(Array), undefined);
    expect(store.batchArchive).toHaveBeenCalledWith(client, expect.objectContaining({ emailIds: ['m1', 'm2'], client }));
    // One entry in the app's undo history for the whole batch.
    expect(undoHistory()).toHaveLength(1);

    await call(WRITER, 'email.undoBatch', result.undoToken);
    // The restore points were taken before: every folder and the read state.
    expect(store.undoMove).toHaveBeenCalledTimes(1);
    expect(store.undoMove).toHaveBeenCalledWith(client, [{
      client, accountId: undefined,
      points: [{ id: 'm1', mailboxIds: { inbox: true }, seen: true }, { id: 'm2', mailboxIds: { inbox: true, news: true }, seen: false }],
    }], []);
    // Off the history too, and it works once.
    expect(undoHistory()).toHaveLength(0);
    await expect(call(WRITER, 'email.undoBatch', result.undoToken)).rejects.toThrow(/can't be undone/);
  });

  it('runs the undo once whether Ctrl+Z or the plugin comes first', async () => {
    const { undoToken } = await call(WRITER, 'email.batch', { emailIds: ['m1'], action: 'move', mailboxId: 'news' }) as { undoToken: string };
    expect(store.batchMoveToMailbox).toHaveBeenCalledWith(client, 'news', expect.objectContaining({ emailIds: ['m1'] }));
    undoLatest();
    await call(WRITER, 'email.undoBatch', undoToken);
    expect(store.undoMove).toHaveBeenCalledTimes(1);
  });

  it('marks read only what changes and puts exactly that back', async () => {
    const { undoToken } = await call(WRITER, 'email.batch', { emailIds: ['m1', 'm2'], action: 'read' }) as { undoToken: string };
    expect(store.batchMarkAsRead).toHaveBeenLastCalledWith(client, true, { emailIds: ['m2'], client });
    await call(WRITER, 'email.undoBatch', undoToken);
    expect(store.batchMarkAsRead).toHaveBeenLastCalledWith(client, false, { emailIds: ['m2'], client });
  });

  it('tags through the store and takes the tag off again on undo', async () => {
    const { undoToken } = await call(WRITER, 'email.batch', { emailIds: ['m1', 'm2'], action: 'tag', tagId: 'work' }) as { undoToken: string };
    expect(store.batchSetTag).toHaveBeenLastCalledWith(client, 'work', true, expect.objectContaining({ emailIds: ['m1', 'm2'] }));
    await call(WRITER, 'email.undoBatch', undoToken);
    expect(store.batchSetTag).toHaveBeenLastCalledWith(client, 'work', false, expect.objectContaining({ emailIds: ['m1', 'm2'] }));
    await expect(call(WRITER, 'email.batch', { emailIds: ['m1'], action: 'tag', tagId: 'nope' })).rejects.toThrow(/not one of the user's tags/);
  });

  it('refuses shared folders, other accounts, the trash and more than 200 messages', async () => {
    await expect(call(WRITER, 'email.batch', { emailIds: ['m1'], action: 'move', mailboxId: 'team' })).rejects.toThrow(/only the user reads/);
    await expect(call(WRITER, 'email.batch', { emailIds: ['m1'], action: 'move', mailboxId: 'acc2:box' })).rejects.toThrow(/only the user reads/);
    await expect(call(WRITER, 'email.batch', { emailIds: ['m1'], action: 'move', mailboxId: 'trash' })).rejects.toThrow(/trash/);
    await expect(call(WRITER, 'email.batch', { emailIds: Array.from({ length: 201 }, (_, i) => `m${i}`), action: 'read' })).rejects.toThrow(/at most 200/);
    await expect(call(WRITER, 'email.batch', { emailIds: ['m1'], action: 'delete' })).rejects.toThrow(/action must be/);
    expect(store.batchMoveToMailbox).not.toHaveBeenCalled();
  });

  it('keeps the undo to the plugin that made it, and needs email:write', async () => {
    const { undoToken } = await call(WRITER, 'email.batch', { emailIds: ['m1'], action: 'archive' }) as { undoToken: string };
    await expect(call(plugin('other', ['email:write']), 'email.undoBatch', undoToken)).rejects.toThrow(/can't be undone/);
    expect(store.undoMove).not.toHaveBeenCalled();
    await expect(call(plugin('reader', ['email:read']), 'email.batch', { emailIds: ['m1'], action: 'read' })).rejects.toThrow(/lacks permission "email:write"/);
  });
});
