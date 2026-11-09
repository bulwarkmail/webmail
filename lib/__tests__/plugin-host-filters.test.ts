import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Mailbox } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useFilterStore } from '@/stores/filter-store';
import { generateScript } from '../sieve/generator';
import { parseScript } from '../sieve/parser';
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
const ASSISTANT = plugin('assistant', ['filters:read', 'filters:write']);
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox' },
  { id: 'news', name: 'Newsletters', role: null },
  { id: 'trash', name: 'Trash', role: 'trash' },
  // As the client lists folders: without their share maps.
  { id: 'team', name: 'Team', role: null },
  { id: 'team-sub', name: 'Projects', role: null, parentId: 'team' },
  { id: 'flaky', name: 'Flaky', role: null },
  { id: 'acc2:box', name: 'Theirs', role: null, isShared: true, accountId: 'acc2' },
] as unknown as Mailbox[];

/** A server with one filters script, in memory. */
function server(initial: string) {
  const state = { content: initial, active: 's1' as string | null };
  const client = {
    supportsSieve: () => true,
    getAccountId: () => 'acc1',
    getSieveAccountId: () => 'acc1',
    getSieveCapabilities: () => ({ sieveExtensions: ['fileinto', 'imap4flags', 'mailbox', 'mailboxid'] }),
    getSieveScripts: vi.fn(async () => [{ id: 's1', name: 'filters', blobId: 'b1', isActive: state.active === 's1' }]),
    getSieveScriptContent: vi.fn(async () => state.content),
    updateSieveScript: vi.fn(async (_id: string, content: string) => { state.content = content; }),
    createSieveScript: vi.fn(),
    activateSieveScript: vi.fn(),
    deactivateSieveScript: vi.fn(),
    deleteSieveScript: vi.fn(),
    getMailboxes: vi.fn(async () => mailboxes),
    supportsMailboxSharing: () => true,
    getMailboxShareWith: vi.fn(async (id: string) => {
      if (id === 'flaky') throw new Error('Mailbox/get failed');
      return id === 'team' ? { u2: { mayReadItems: true } } : null;
    }),
  } as unknown as IJMAPClient;
  return { client, state };
}

const RULE = {
  name: 'Newsletters',
  conditions: [{ field: 'from', op: 'contains', value: 'newsletter@shop.example' }],
  actions: [{ type: 'move', mailboxId: 'news' }, { type: 'mark_read' }],
};

let srv: ReturnType<typeof server>;
beforeEach(() => {
  clearUndoTokens();
  srv = server(generateScript([], undefined, {}));
  useAuthStore.setState({ client: srv.client });
  useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }] } as never);
  useFilterStore.setState({ selectedAccountId: null } as never);
});
afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('api.filters', () => {
  it('adds a rule at the top of the account\'s filters and takes it back', async () => {
    const { id, undoToken } = await call(ASSISTANT, 'filters.create', RULE) as { id: string; undoToken: string };
    const rules = parseScript(srv.state.content).rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id, name: 'Newsletters', matchType: 'all',
      conditions: [{ field: 'from', comparator: 'contains', value: 'newsletter@shop.example' }],
      actions: [{ type: 'move', mailboxId: 'news', value: 'Newsletters' }, { type: 'mark_read' }],
    });
    const listed = await call(ASSISTANT, 'filters.list') as { editable: boolean; rules: { name: string; actions: unknown[] }[] };
    expect(listed.editable).toBe(true);
    expect(listed.rules[0].actions[0]).toEqual({ type: 'move', mailboxId: 'news', folder: 'Newsletters' });

    await call(ASSISTANT, 'filters.undo', undoToken);
    expect(parseScript(srv.state.content).rules).toHaveLength(0);
  });

  it('refuses forward, redirect, reject, discard and keep, whatever else the rule does', async () => {
    for (const type of ['forward', 'redirect', 'reject', 'discard', 'keep']) {
      const rule = { ...RULE, actions: [{ type: 'mark_read' }, { type, value: 'x@example.com' }] };
      await expect(call(ASSISTANT, 'filters.create', rule)).rejects.toThrow(new RegExp(`"${type}" is not allowed`));
    }
    expect(srv.client.updateSieveScript).not.toHaveBeenCalled();
  });

  it('files mail only into folders of the account that nobody else reads, never the trash', async () => {
    for (const mailboxId of ['acc2:box', 'nope']) {
      await expect(call(ASSISTANT, 'filters.create', { ...RULE, actions: [{ type: 'copy', mailboxId }] })).rejects.toThrow(/only the user reads/);
    }
    // Shared with someone, inside a shared folder, or the server didn't say.
    for (const mailboxId of ['team', 'team-sub', 'flaky']) {
      await expect(call(ASSISTANT, 'filters.create', { ...RULE, actions: [{ type: 'copy', mailboxId }] })).rejects.toThrow(/shared with other people/);
    }
    await expect(call(ASSISTANT, 'filters.create', { ...RULE, actions: [{ type: 'move', mailboxId: 'trash' }] })).rejects.toThrow(/trash/);
    expect(srv.client.updateSieveScript).not.toHaveBeenCalled();
  });

  it('checks the rule like the rule editor does', async () => {
    await expect(call(ASSISTANT, 'filters.create', { ...RULE, name: ' ' })).rejects.toThrow(/name/);
    await expect(call(ASSISTANT, 'filters.create', { ...RULE, conditions: [] })).rejects.toThrow(/conditions/);
    await expect(call(ASSISTANT, 'filters.create', { ...RULE, conditions: [{ field: 'all', op: 'any' }] })).rejects.toThrow(/field must be/);
    await expect(call(ASSISTANT, 'filters.create', { ...RULE, conditions: [{ field: 'header', op: 'contains', value: 'x', headerName: 'bad name' }] })).rejects.toThrow(/header name/);
    await expect(call(ASSISTANT, 'filters.create', { ...RULE, actions: [{ type: 'stop' }] })).rejects.toThrow(/besides stop/);
    await expect(call(ASSISTANT, 'filters.create', { ...RULE, actions: [{ type: 'add_label', tagId: 'nope' }] })).rejects.toThrow(/tags/);
  });

  it('leaves a hand-edited script alone', async () => {
    // Metadata that doesn't parse makes the whole script opaque.
    srv.state.content = '/* @metadata:begin\n{ not json\n@metadata:end */\nkeep;\n';
    const listed = await call(ASSISTANT, 'filters.list') as { editable: boolean };
    expect(listed.editable).toBe(false);
    await expect(call(ASSISTANT, 'filters.create', RULE)).rejects.toThrow(/edited by hand/);
  });

  it('needs filters:write to add and keeps the undo to its plugin', async () => {
    await expect(call(plugin('reader', ['filters:read']), 'filters.create', RULE)).rejects.toThrow(/lacks permission "filters:write"/);
    const { undoToken } = await call(ASSISTANT, 'filters.create', RULE) as { undoToken: string };
    await expect(call(plugin('other', ['filters:write']), 'filters.undo', undoToken)).rejects.toThrow(/can't be undone/);
    expect(parseScript(srv.state.content).rules).toHaveLength(1);
  });
});
