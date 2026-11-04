/**
 * "Save to Files" for a document opened from Files in its own program (pim-p2-1): the saved
 * bytes go back into the node they came from, as an upload's Replace does (same id, so shares
 * and links stay), the way OneDrive or Nextcloud write back an edited file.
 *
 * Before that the node is read again: when its content is no longer what was opened (someone
 * changed it on the server, or it was deleted), nothing is overwritten and the caller asks
 * Keep both (a numbered copy beside it) or Replace.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useFileStore } from '@/stores/file-store';
import type { EditSource } from './edit-attachments';

export type NodeEditSource = Extract<EditSource, { kind: 'node' }>;

export type SaveBackResult =
  | { status: 'saved'; blobId: string }
  /** Someone changed the file on the server since it was opened. */
  | { status: 'changed' }
  /** It isn't there any more. */
  | { status: 'gone' };

/** The client for the account the file belongs to, whichever account is on screen. */
export function filesClientFor(account: string): IJMAPClient | null {
  const files = useFileStore.getState();
  if (files.client && files.currentAccountId === account) return files.client;
  const auth = useAuthStore.getState();
  return auth.getClientForAccount?.(account) ?? (auth.activeAccountId === account ? auth.client : null) ?? null;
}

/** Puts the file into its node. `force`: also when it changed on the server (Replace). */
export async function saveBackToNode(client: IJMAPClient, source: NodeEditSource, file: File, force = false): Promise<SaveBackResult> {
  const [node] = await client.getFileNodes([source.nodeId], ['id', 'blobId', 'name', 'parentId']);
  if (!node) return { status: 'gone' };
  if (!force && source.blobId && node.blobId !== source.blobId) return { status: 'changed' };
  const { blobId } = await client.uploadBlob(file);
  await client.replaceFileNodeBlob(source.nodeId, blobId);
  return { status: 'saved', blobId };
}

/** Keep both: a new file beside the original, numbered by the server when the name is taken. */
export async function saveBesideNode(client: IJMAPClient, source: NodeEditSource, file: File): Promise<{ source: NodeEditSource; name: string }> {
  const { blobId, type } = await client.uploadBlob(file);
  let created;
  try {
    created = await client.createFileNode(file.name, blobId, type || file.type || 'application/octet-stream', file.size, source.parentId);
  } catch (error) {
    // The folder went too: the top of Files.
    if (source.parentId === null) throw error;
    created = await client.createFileNode(file.name, blobId, type || file.type || 'application/octet-stream', file.size, null);
  }
  return { source: { kind: 'node', nodeId: created.id, blobId, parentId: created.parentId ?? null }, name: created.name };
}

/** Files on screen shows the new size and date. */
export function refreshFilesFor(client: IJMAPClient): void {
  const files = useFileStore.getState();
  if (files.client === client) void files.refresh().catch(() => {});
}
