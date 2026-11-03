// Area c, batches: email.batch / email.undoBatch. One change to up to 200
// messages of the signed-in account, through the email store's own batch
// functions (so their plugin hooks run and the list updates), with restore
// points taken first and one entry in the app's undo history: the plugin's
// Undo and Ctrl+Z take back the same thing, once.

import type { Email } from '../../jmap/types';
import type { IJMAPClient } from '../../jmap/client-interface';
import { useEmailStore, type EmailRestoreBatch, type BatchActionTarget } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { isArchiveActionEnabled } from '../../archive-gate';
import { recordUndo, runUndo } from '../../undo-history';
import { KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY } from '../../thread-utils';
import { readId, readObject, readString, sessionClient, withinRate } from '../host-api-input';
import { MAX_PLUGIN_MOVES_PER_MINUTE } from '../host-api-mail';
import { isSharedOut } from '../../mailbox-shared-out';
import { issueUndoToken, undoAccount, withUndoToken } from './c.undo';
import type { MailBatchAction, MailBatchResult } from './c.types';

/** Most messages one email.batch call changes. */
export const MAX_PLUGIN_BATCH = 200;
const ACTIONS: readonly MailBatchAction[] = ['archive', 'move', 'read', 'unread', 'tag', 'untag'];
const FIELDS = ['id', 'mailboxIds', 'keywords', 'receivedAt', 'threadId'];

interface BatchUndo {
  entryId: string;
  /** Runs the undo once; the history entry and the plugin's call share it. */
  run: () => Promise<void>;
}

/** Runs `fn` once while it runs or after it went through; a failure may be tried again. */
function once(fn: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | null = null;
  return () => (promise ??= fn().catch((err: unknown) => {
    promise = null;
    throw err;
  }));
}

function readIds(value: unknown, method: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${method}: emailIds must be a non-empty array`);
  if (value.length > MAX_PLUGIN_BATCH) throw new Error(`${method}: at most ${MAX_PLUGIN_BATCH} messages at once`);
  return [...new Set(value.map((id, i) => readId(id, method, `emailIds[${i}]`)))];
}

const hasTag = (email: Email, tagId: string) => !!(email.keywords?.[KEYWORD_PREFIX + tagId] || email.keywords?.[KEYWORD_PREFIX_LEGACY + tagId]);

function withTag(email: Email, tagId: string, on: boolean): Email {
  const keywords = { ...email.keywords };
  if (on) keywords[KEYWORD_PREFIX + tagId] = true;
  else { delete keywords[KEYWORD_PREFIX + tagId]; delete keywords[KEYWORD_PREFIX_LEGACY + tagId]; }
  return { ...email, keywords };
}

/**
 * Change many messages of the signed-in account at once: archive (by the
 * user's archiveMode), move into one of its own folders (not a shared one,
 * not the trash), mark read or unread, put a tag on or take it off.
 */
export async function doEmailBatch(pluginId: string, input: unknown): Promise<MailBatchResult> {
  const method = 'email.batch';
  const data = readObject(input, method, 'batch', ['emailIds', 'action', 'mailboxId', 'tagId']);
  const ids = readIds(data.emailIds, method);
  const action = data.action as MailBatchAction;
  if (!ACTIONS.includes(action)) throw new Error(`${method}: action must be one of ${ACTIONS.join(', ')}`);
  if (action !== 'move' && data.mailboxId !== undefined) throw new Error(`${method}: mailboxId is only for move`);
  if (action !== 'tag' && action !== 'untag' && data.tagId !== undefined) throw new Error(`${method}: tagId is only for tag and untag`);
  const client = sessionClient(method);
  const store = useEmailStore.getState();

  let mailboxId = '';
  if (action === 'move') {
    mailboxId = readId(data.mailboxId, method, 'mailboxId');
    // Only the account's own folders, never one shared with other people.
    const box = store.mailboxes.find((m) => m.id === mailboxId && !m.isShared);
    // The share map isn't in the folder list: ask the server, for the folder
    // and the folders above it (a shared parent shares its children).
    if (!box || (await isSharedOut(client, store.mailboxes, mailboxId))) {
      throw new Error(`${method}: mailboxId is not a folder of this account that only the user reads`);
    }
    if (box.role === 'trash') throw new Error(`${method}: messages can't be moved to the trash this way`);
  }
  let tagId = '';
  if (action === 'tag' || action === 'untag') {
    tagId = readString(data.tagId, method, 'tagId', 100, { min: 1, trim: true });
    if (!useSettingsStore.getState().emailKeywords.some((k) => k.id === tagId)) throw new Error(`${method}: tagId is not one of the user's tags`);
  }
  if (action === 'archive' && !isArchiveActionEnabled()) throw new Error(`${method}: archiving is switched off by the administrator`);
  if ((action === 'archive' || action === 'move') && !withinRate('email.move', pluginId, MAX_PLUGIN_MOVES_PER_MINUTE)) {
    throw new Error(`${method}: too many moves, try again in a minute`);
  }

  // The messages as the server has them now, from the signed-in account only.
  const emails = (await client.getEmailFields(ids, FIELDS, undefined)) as unknown as Email[];
  const found = emails.filter((e) => e && typeof e.id === 'string' && ids.includes(e.id));
  const missing = ids.length - found.length;
  const target: BatchActionTarget = { emailIds: found.map((e) => e.id), client, emails: found };
  const none: MailBatchResult = { done: 0, failed: ids.length, undoToken: null };
  if (found.length === 0) return none;

  let done = 0;
  let undo: () => Promise<void>;
  let label: string;
  if (action === 'archive' || action === 'move') {
    const batches: EmailRestoreBatch[] = [{
      client, accountId: undefined,
      points: found.map((e) => ({ id: e.id, mailboxIds: { ...e.mailboxIds }, seen: !!e.keywords?.$seen })),
    }];
    const ok = action === 'archive'
      ? await store.batchArchive(client, target)
      : await store.batchMoveToMailbox(client, mailboxId, target);
    if (!ok) return none;
    done = found.length;
    undo = () => useEmailStore.getState().undoMove(client, batches, []);
    label = `${action} ${done}`;
  } else if (action === 'read' || action === 'unread') {
    const read = action === 'read';
    const changed = found.filter((e) => !!e.keywords?.$seen !== read).map((e) => e.id);
    if (changed.length > 0 && !(await store.batchMarkAsRead(client, read, { emailIds: changed, client }))) return none;
    done = found.length;
    undo = async () => {
      if (changed.length > 0 && !(await useEmailStore.getState().batchMarkAsRead(client, !read, { emailIds: changed, client }))) {
        throw new Error('stopped');
      }
    };
    label = `${action} ${done}`;
  } else {
    const add = action === 'tag';
    const changed = found.filter((e) => hasTag(e, tagId) !== add);
    if (changed.length > 0 && !(await store.batchSetTag(client, tagId, add, target))) return none;
    done = found.length;
    const after = changed.map((e) => withTag(e, tagId, add));
    undo = async () => {
      if (after.length > 0 && !(await useEmailStore.getState().batchSetTag(client, tagId, !add, { emailIds: after.map((e) => e.id), client, emails: after }))) {
        throw new Error('stopped');
      }
    };
    label = `${action} ${done}`;
  }

  const run = once(undo);
  // One entry in the app's undo history: Ctrl+Z reaches it too.
  const entry = recordUndo(`Plugin ${pluginId}: ${label} messages`, () => { void run().catch(() => { /* the plugin's undo reports it */ }); });
  const token = issueUndoToken(pluginId, undoAccount(client), 'batch', { entryId: entry.id, run } satisfies BatchUndo);
  return { done, failed: missing, undoToken: token };
}

/** Take back an email.batch: the messages go back to their folders, read state and tags. */
export async function doEmailUndoBatch(pluginId: string, token: unknown): Promise<void> {
  const method = 'email.undoBatch';
  const client: IJMAPClient = sessionClient(method);
  await withUndoToken<BatchUndo, void>(method, pluginId, undoAccount(client), 'batch', token, async ({ entryId, run }) => {
    // Off the history first, so Ctrl+Z can't run it again; an entry already
    // taken by Ctrl+Z has run (or is running) the same undo.
    runUndo(entryId);
    await run();
  });
}
