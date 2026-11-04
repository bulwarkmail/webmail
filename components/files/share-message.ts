import { appPath, buildSharedFilesPath } from "@/lib/deep-links";

/**
 * The link a person a file or folder was shared with opens it by. The node
 * is theirs to see under "<owner account>:<node id>" (the id a drive shared
 * with them is listed by); a file opens in its preview there.
 */
export function sharedNodeLink(
  origin: string,
  ownerAccountId: string,
  node: { id: string; name: string; isDirectory: boolean },
): string {
  const shared = `${ownerAccountId}:${node.id}`;
  return `${origin}${appPath(buildSharedFilesPath(shared, node.isDirectory ? null : node.name))}`;
}
