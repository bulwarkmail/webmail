import type { FileNode, FileNodeType } from './types';

/**
 * What a FileNode is: a file, a folder or a symlink.
 *
 * `nodeType` says so on Stalwart 0.16.6 and later. Without it, a node is a
 * folder exactly when it has no content blob (#379). Stalwart 1.0 adds
 * symlinks, which have no blob either but can't hold anything, so the blob
 * rule alone would show them as empty folders.
 */
export function fileNodeKind(node: Pick<FileNode, 'nodeType' | 'blobId'>): FileNodeType {
  switch (node.nodeType) {
    case 'file':
    case 'directory':
    case 'symlink':
      return node.nodeType;
    default:
      return node.blobId == null ? 'directory' : 'file';
  }
}

/**
 * Stalwart 1.0 implements File Storage draft 18, which names the kind
 * `@type` ("File", "Directory", "SymLink") and the media type `mediaType`.
 * 0.16 calls them `nodeType` and `type`. Each server leaves the other's
 * names out of FileNode/get but refuses them in a create.
 */
const DRAFT_NODE_TYPES: Record<string, FileNodeType> = { File: 'file', Directory: 'directory', SymLink: 'symlink' };

type DraftFileNode = { '@type'?: unknown; mediaType?: unknown };

/** A node of either draft, with the kind in `nodeType` and the media type in `type`. */
export function fromDraftFileNode<T extends Partial<FileNode>>(node: T & DraftFileNode): T {
  const kind = typeof node['@type'] === 'string' ? DRAFT_NODE_TYPES[node['@type']] : undefined;
  const mediaType = typeof node.mediaType === 'string' ? node.mediaType : undefined;
  if (!kind && mediaType === undefined) return node;
  return {
    ...node,
    ...(kind && !node.nodeType ? { nodeType: kind } : {}),
    ...(mediaType !== undefined && node.type == null ? { type: mediaType } : {}),
  };
}

/** The properties of a FileNode/set create in draft 18, from 0.16 ones (no blob: a folder). */
export function toDraftFileNodeCreate(props: Record<string, unknown>): Record<string, unknown> {
  const { type, ...rest } = props;
  return rest.blobId == null
    ? { '@type': 'Directory', ...rest }
    : { '@type': 'File', ...rest, mediaType: type };
}
