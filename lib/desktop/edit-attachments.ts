/**
 * "Edit" on an attachment, the page's side. The desktop app copies the file to a private
 * folder, opens it in its default program and says when it was saved (the shell's
 * features/os-edit.ts). What happens to a saved file is decided here and in what uses
 * this: a composer offers "Update attachment" (hooks/use-composer-edits.ts), and the
 * rest goes through the offers in components/desktop/edited-files-host.tsx.
 *
 * The organisation's word on saving attachments and exporting mail is per account and only
 * known here, so it's asked at every step, as the local export does around its sink:
 * before anything starts, after the bytes arrive, and before a saved file is read back.
 * A policy that turns to no ends the session (the host watches), and one that isn't known
 * yet counts as no for starting something, but deletes nothing.
 */

import { create } from 'zustand';
import { isAppLocked } from '@/lib/desktop/app-lock-state';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import type { DesktopEditBridge, DesktopEditOpenResult, DesktopEditSession } from '@/lib/desktop/types';
import { canDownload, canExport } from '@/lib/device-policy';
import { scopeDecided } from '@/lib/offline/offline-mode';
import { onDeviceWipe, WipeIncompleteError } from '@/lib/offline/wipe-registry';
import { onBeforeSignOut, onFullSignOut } from '@/lib/sign-out-cleanup';

/** Where a session's file came from, kept by main for as long as the session lives. */
export type EditSource =
  /** A message's attachment: offers a reply. */
  | { kind: 'mail'; emailId: string; ownerAccountId?: string }
  /** A draft's attachment: offers the update, in the composer holding it. */
  | { kind: 'draft'; draftId: string | null; ownerAccountId?: string }
  /** Its message went or it was taken off a draft: only the file is left. */
  | { kind: 'file' };

export function parseEditSource(raw: string): EditSource {
  try {
    const parsed = JSON.parse(raw) as Partial<EditSource> & { emailId?: unknown; draftId?: unknown; ownerAccountId?: unknown };
    const ownerAccountId = typeof parsed.ownerAccountId === 'string' ? parsed.ownerAccountId : undefined;
    if (parsed.kind === 'mail' && typeof parsed.emailId === 'string') return { kind: 'mail', emailId: parsed.emailId, ownerAccountId };
    if (parsed.kind === 'draft') return { kind: 'draft', draftId: typeof parsed.draftId === 'string' ? parsed.draftId : null, ownerAccountId };
  } catch {
    // Falls through: what's left is a file.
  }
  return { kind: 'file' };
}

export function getEditBridge(): DesktopEditBridge | null {
  return getDesktopBridge()?.edit ?? null;
}

/** Nothing in the browser. Otherwise the shell's own list of what may be opened. */
export function canEditFile(name: string | null | undefined): boolean {
  return !!name && getEditBridge()?.canEdit(name) === true;
}

/** Whether this account may keep a copy outside the app: saving attachments and export both have to be allowed. */
export function editAllowed(account: string): boolean {
  return scopeDecided(account) && canDownload(account) && canExport(account);
}

/** A definite no. An unknown policy isn't one: nothing is deleted for that. */
export function editForbidden(account: string): boolean {
  return scopeDecided(account) && !(canDownload(account) && canExport(account));
}

export type EditStartResult = DesktopEditOpenResult | { ok: false; reason: 'policy' | 'unavailable' | 'gesture' };

export interface StartEditInput {
  /** One session per key: Edit on the same attachment opens the same file, with its edits. */
  key: string;
  name: string;
  type: string;
  account: string;
  source: EditSource;
  load: () => Promise<Blob | ArrayBuffer>;
}

/** Call it straight from the click: main only starts a session on a real one. */
export async function startAttachmentEdit(input: StartEditInput): Promise<EditStartResult> {
  const edit = getEditBridge();
  if (!edit) return { ok: false, reason: 'unavailable' };
  if (!editAllowed(input.account)) return { ok: false, reason: 'policy' };
  const begun = await edit.begin(input.key);
  if (!begun.ok) return begun;
  if (begun.open) return edit.reopen(begun.ticket, begun.open);
  const loaded = await input.load();
  // It can take a while to arrive, and the answer can change meanwhile.
  if (!editAllowed(input.account)) return { ok: false, reason: 'policy' };
  if (isAppLocked()) return { ok: false, reason: 'locked' };
  const data = new Uint8Array(loaded instanceof Blob ? await loaded.arrayBuffer() : loaded);
  return edit.open(begun.ticket, {
    key: input.key,
    name: input.name,
    type: input.type,
    data,
    account: input.account,
    source: JSON.stringify(input.source),
  });
}

/** A file read back remembers which session it came from, so whichever composer it lands in takes the session on. */
const editFiles = new WeakMap<File, { id: string; hash: string }>();

export function editFileInfo(file: File | undefined): { id: string; hash: string } | undefined {
  return file ? editFiles.get(file) : undefined;
}

export type EditReadOutcome =
  | { ok: true; file: File; hash: string }
  | { ok: false; reason: 'policy' | 'locked' | 'missing' | 'busy' | 'too-large' | 'unavailable' };

export async function readEditedFile(session: Pick<DesktopEditSession, 'id' | 'account'>): Promise<EditReadOutcome> {
  const edit = getEditBridge();
  if (!edit) return { ok: false, reason: 'unavailable' };
  if (!editAllowed(session.account)) return { ok: false, reason: 'policy' };
  const answer = await edit.read(session.id);
  if (!answer.ok) return answer;
  const bytes = answer.data;
  const file = new File([new Uint8Array(bytes)], answer.name, { type: answer.type || 'application/octet-stream' });
  editFiles.set(file, { id: session.id, hash: answer.hash });
  return { ok: true, file, hash: answer.hash };
}

const REPLY_WAIT_MS = 2 * 60 * 1000;
const parkedReplies = new Map<string, { files: File[]; at: number }>();

/** The next reply composer opened on this message takes these. Waits here so every way of opening one works. */
export function parkFilesForReply(emailId: string, files: File[]): void {
  parkedReplies.set(emailId, { files, at: Date.now() });
}

export function takeFilesForReply(emailId: string | undefined): File[] {
  if (!emailId) return [];
  const parked = parkedReplies.get(emailId);
  parkedReplies.delete(emailId);
  return parked && Date.now() - parked.at < REPLY_WAIT_MS ? parked.files : [];
}

interface EditSessionsState {
  sessions: DesktopEditSession[];
}

/** What main says, per window. Empty while the app is locked. */
export const useEditSessions = create<EditSessionsState>(() => ({ sessions: [] }));

let listening = false;

/** Once per page, and for its life. Does nothing in a browser. */
export function followEditSessions(): void {
  const edit = getEditBridge();
  if (!edit || listening) return;
  listening = true;
  edit.onChange((sessions) => useEditSessions.setState({ sessions }));
  void edit.list().then((sessions) => useEditSessions.setState({ sessions }), () => {});
}

/** For tests. */
export function resetEditSessions(): void {
  listening = false;
  parkedReplies.clear();
  useEditSessions.setState({ sessions: [] });
}

const clear = async (account: string | null) => {
  await getEditBridge()?.clear(account);
};

const wipe = async (account: string | null) => {
  const result = await getEditBridge()?.wipe(account);
  if (result && result.held.length > 0) throw new WipeIncompleteError(`${result.held.length} files are held by another program`);
};

// The copies are of mail, so they go with the account. A wipe asks nobody; the question before
// a sign-out the user started is main's, through the host's gate. A sign-out the app decided
// on because it couldn't confirm the login (keepLocalStore) keeps them, as it keeps the store:
// nobody chose it, and these can be someone's only copy of an afternoon's work. While it lasts
// the host doesn't show them, since that account isn't signed in.
onDeviceWipe((account) => wipe(account));
onBeforeSignOut((account, options) => (options.keepLocalStore ? Promise.resolve() : clear(account)));
onFullSignOut((options) => {
  if (!options.keepLocalStore) void clear(null);
});
