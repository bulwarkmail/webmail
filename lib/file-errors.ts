import { jmapError, jmapErrorProperties, jmapErrorType, type JmapError } from '@/lib/jmap/jmap-error';
import { uploadRateLimit } from '@/lib/jmap/upload-errors';

/**
 * Why a FileNode write failed, from the SetError the JMAP client threw
 * (see jmapError), for the Files toasts to explain under their own title.
 * `rateLimited` is an upload refused with HTTP 429 (see uploadRateLimit).
 */
export type FileErrorKind = 'overQuota' | 'tooDeep' | 'invalidName' | 'forbidden' | 'tooLarge' | 'rateLimited';

// Stalwart 1.0's description for a node past maxFileNodeDepth.
const TOO_DEEP = 'Maximum folder depth exceeded.';

/** The error for a node that would sit deeper than the server allows, worded as Stalwart 1.0 does. */
export function folderDepthError(): Error {
  return jmapError(TOO_DEEP, { type: 'invalidProperties', properties: ['parentId'] });
}

type PartialCopyError = JmapError & { partialCopy?: boolean };

/**
 * The error for a copy that stopped part-way and could not be taken back
 * completely, so part of it is still there. It keeps the message and JMAP
 * type of `cause`, which say why the copy stopped.
 */
export function partialCopyError(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  const error: PartialCopyError = jmapError(message, {
    type: jmapErrorType(cause),
    properties: jmapErrorProperties(cause),
  });
  error.partialCopy = true;
  return error;
}

/** Whether a failed copy left part of itself in place (see partialCopyError). */
export function isPartialCopy(error: unknown): boolean {
  return (error as PartialCopyError | null | undefined)?.partialCopy === true;
}

export function fileErrorKind(error: unknown): FileErrorKind | null {
  if (uploadRateLimit(error)) return 'rateLimited';
  switch (jmapErrorType(error)) {
    // Stalwart 1.0, once an administrator limits files or folders per account.
    case 'overQuota':
      return 'overQuota';
    // 1.0 for content over 4 GiB.
    case 'tooLarge':
      return 'tooLarge';
    case 'forbidden':
      return 'forbidden';
    case 'invalidProperties': {
      const properties = jmapErrorProperties(error);
      if (properties.includes('name')) return 'invalidName';
      // `parentId` is refused for other reasons too (the folder is gone, a
      // folder moved into itself); only the description tells depth apart.
      if (properties.includes('parentId') && error instanceof Error && /depth/i.test(error.message)) {
        return 'tooDeep';
      }
      return null;
    }
    default:
      return null;
  }
}
