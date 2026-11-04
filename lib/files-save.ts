// Save attachments of a message to Files: the blobs are already on the
// server, so each is filed by blobId with no download or upload. From
// another account of the login (a shared or group mailbox) the blob is
// copied into the Files account first (Blob/copy, RFC 8620 §6.3).
//
// Used by the reader's Save to Files dialog and by the plugin host
// (api.files.saveAttachments). Plugins hear about each file as about an
// upload in Files: onBeforeFileUpload may stop it, onAfterFileUpload
// reports it.

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';
import { fileHooks } from '@/lib/plugin-hooks';
import { fileToView } from '@/lib/plugin-projection';

/** What saving needs of an attachment: its blob, name, type and size. */
export interface SaveableBlob {
  blobId: string;
  name?: string | null;
  type?: string | null;
  size: number;
}

export interface SaveToFilesOptions {
  /** The mail login's client; its Files account takes the files. */
  client: IJMAPClient;
  /** The folder to save into; null is the top of the user's own drive. */
  parentId: string | null;
  /** The folder's path, for plugins ('/' for the top). */
  path: string;
  /**
   * The JMAP account the blobs are in, when not the Files account (a
   * shared or group mailbox of the same login).
   */
  blobAccountId?: string;
}

export interface SaveToFilesResult {
  /** The files created, with the names the server gave them. */
  saved: FileNode[];
  /** Names a plugin stopped (onBeforeFileUpload). */
  stopped: string[];
}

/**
 * Files each blob into `parentId`. A name that is taken becomes
 * "name (2).ext" on the server. Stops at the first error and passes it on;
 * files saved before it stay.
 */
export async function saveBlobsToFiles(blobs: SaveableBlob[], { client, parentId, path, blobAccountId }: SaveToFilesOptions): Promise<SaveToFilesResult> {
  const saved: FileNode[] = [];
  const stopped: string[] = [];
  const filesAccountId = blobAccountId ? client.getFilesAccountId() : undefined;
  const copy = !!blobAccountId && !!filesAccountId && blobAccountId !== filesAccountId;
  for (const blob of blobs) {
    const name = blob.name || 'attachment';
    const type = blob.type || 'application/octet-stream';
    if (!(await fileHooks.onBeforeFileUpload.intercept({ name, size: blob.size, type, path }))) {
      stopped.push(name);
      continue;
    }
    const blobId = copy
      ? (await client.copyBlobs(blobAccountId!, [blob.blobId], filesAccountId!))[blob.blobId]
      : blob.blobId;
    const node = await client.createFileNode(name, blobId, type, blob.size, parentId);
    // The server's answer to a create may leave the size out.
    saved.push(node.size ? node : { ...node, size: blob.size });
    void fileHooks.onAfterFileUpload.emit(fileToView(node, path));
  }
  return { saved, stopped };
}
