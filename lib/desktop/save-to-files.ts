/**
 * "Save to Files" for a document opened from Files in its own program (pim-p2-1): the saved
 * bytes go back into the node they came from, as an upload's Replace does (same id, so shares
 * and links stay), the way OneDrive or Nextcloud write back an edited file.
 *
 * Before that the node is read again: when its content is no longer what was opened (someone
 * changed it on the server, or it was deleted), nothing is overwritten and the caller asks
 * Keep both (a numbered copy beside it) or Replace.
 */

import { TRASH_FOLDER_NAME } from '@/lib/files-trash';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useFileStore } from '@/stores/file-store';
import type { EditSource } from './edit-attachments';

export type NodeEditSource = Extract<EditSource, { kind: 'node' }>;

export type SaveBackResult =
  /** `source`: the node as the server holds it now, the base for the next save. */
  | { status: 'saved'; source: NodeEditSource }
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

const STATE_PROPERTIES = ['id', 'blobId', 'name', 'parentId', 'size', 'modified'];

type NodeState = { blobId: string | null; size?: number; modified?: string; parentId?: string | null };

/**
 * Whether the node still holds what the session last knew. The blob id is what the server
 * reported (Stalwart 1.0 keeps an uploaded file under a blob id of its own, pim-p3-1), and
 * where a server reports another id for the same content, the same size and change time
 * still say nobody touched it.
 */
export function nodeUnchanged(source: NodeEditSource, node: NodeState): boolean {
  if (!source.blobId) return true;
  if (node.blobId === source.blobId) return true;
  return source.size !== undefined && source.modified !== undefined && node.size === source.size && node.modified === source.modified;
}

function sourceOf(source: NodeEditSource, node: NodeState, fallbackBlobId: string): NodeEditSource {
  return {
    kind: 'node',
    nodeId: source.nodeId,
    blobId: node.blobId ?? fallbackBlobId,
    parentId: node.parentId === undefined ? source.parentId : node.parentId,
    ...(typeof node.size === 'number' ? { size: node.size } : {}),
    ...(typeof node.modified === 'string' && node.modified ? { modified: node.modified } : {}),
  };
}

/**
 * Whether the node sits in Files' trash: deleted there, so a save that goes back by itself
 * mustn't land in it (pim-p3-6). Walks up its folders; the trash is a folder at the top.
 */
async function inTrash(client: IJMAPClient, parentId: string | null | undefined): Promise<boolean> {
  let at = parentId ?? null;
  for (let depth = 0; at && depth < 32; depth++) {
    const [folder] = await client.getFileNodes([at], ['id', 'name', 'parentId']).catch(() => []);
    if (!folder) return false;
    if ((folder.parentId ?? null) === null) return folder.name === TRASH_FOLDER_NAME && !folder.id.includes(':');
    at = folder.parentId;
  }
  return false;
}

/** Puts the file into its node. `force`: also when it changed on the server (Replace). */
export async function saveBackToNode(client: IJMAPClient, source: NodeEditSource, file: File, force = false): Promise<SaveBackResult> {
  const [node] = await client.getFileNodes([source.nodeId], STATE_PROPERTIES);
  if (!node || await inTrash(client, node.parentId)) return { status: 'gone' };
  if (!force && !nodeUnchanged(source, node)) return { status: 'changed' };
  const { blobId } = await client.uploadBlob(file);
  await client.replaceFileNodeBlob(source.nodeId, blobId);
  // What the server holds now, not what was uploaded: the next save compares with this.
  const [after] = await client.getFileNodes([source.nodeId], STATE_PROPERTIES).catch(() => []);
  return { status: 'saved', source: sourceOf(source, after ?? { blobId }, blobId) };
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
  const base: NodeEditSource = { kind: 'node', nodeId: created.id, blobId, parentId: created.parentId ?? null };
  const [after] = await client.getFileNodes([created.id], STATE_PROPERTIES).catch(() => []);
  return { source: sourceOf(base, after ?? { blobId }, blobId), name: created.name };
}

/** Files on screen shows the new size and date. */
export function refreshFilesFor(client: IJMAPClient): void {
  const files = useFileStore.getState();
  if (files.client === client) void files.refresh().catch(() => {});
}
