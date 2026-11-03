/** How a FileNode becomes a row. The server's own copy stays in `json`, in whichever draft it speaks. */

import { fileNodeKind, fromDraftFileNode } from '@/lib/jmap/filenode-kind';
import { decodeFileNodeName } from '@/lib/jmap/filenode-name';
import type { FileNode } from '@/lib/jmap/types';
import type { StorageAdapter } from '../storage';

export const FILES_CAPABILITY = 'urn:ietf:params:jmap:filenode';
export const FILES_USING = ['urn:ietf:params:jmap:core', FILES_CAPABILITY];

/** The client's list (lib/jmap/client.ts). Stalwart leaves out shareWith and myRights unless asked. */
export const FILE_NODE_PROPERTIES = [
  'id', 'parentId', 'name', 'type', 'blobId', 'size', 'created', 'modified',
  'nodeType', '@type', 'mediaType', 'shareWith', 'myRights',
];

export type WireNode = Record<string, unknown> & { id: string };

/** The node's media type, whichever draft named it. */
export function nodeMediaType(node: WireNode): string {
  const { type } = fromDraftFileNode(node as unknown as Partial<FileNode> & { '@type'?: unknown; mediaType?: unknown });
  return typeof type === 'string' && type ? type : 'application/octet-stream';
}

export function writeNode(db: StorageAdapter, jmap: string, node: WireNode, gen: number): void {
  const normal = fromDraftFileNode(node as unknown as FileNode & { '@type'?: unknown; mediaType?: unknown });
  db.run(
    `INSERT INTO file_node (jmap, id, parent_id, name, kind, blob_id, size, json, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (jmap, id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, kind = excluded.kind,
       size = excluded.size, json = excluded.json, gen = excluded.gen,
       keep_error = CASE WHEN blob_id IS excluded.blob_id THEN keep_error END,
       blob_id = excluded.blob_id`,
    [
      jmap,
      node.id,
      typeof node.parentId === 'string' ? node.parentId : null,
      // The client decodes names itself from `json`. This column is for the store's own lists.
      typeof node.name === 'string' ? decodeFileNodeName(node.name) : '',
      fileNodeKind(normal),
      typeof node.blobId === 'string' ? node.blobId : null,
      typeof node.size === 'number' ? node.size : null,
      JSON.stringify(node),
      gen,
    ],
  );
}

export function removeNode(db: StorageAdapter, jmap: string, id: string): void {
  db.run('DELETE FROM file_node WHERE jmap = ? AND id = ?', [jmap, id]);
}
