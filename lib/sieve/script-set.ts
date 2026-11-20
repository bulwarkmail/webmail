/**
 * SieveScript/set and blob upload pieces shared by the filters editor (the
 * JMAP client in the browser) and the mailbox migration (on the server).
 */

export const SIEVE_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:sieve'];

/** The blobId of an upload answer: `{ blobId }`, or keyed by account on some servers. */
export function uploadedBlobId(result: Record<string, unknown>, accountId: string): string {
  if (typeof result.blobId === 'string') return result.blobId;
  const blobInfo = result[accountId] as { blobId?: unknown } | undefined;
  if (typeof blobInfo?.blobId === 'string') return blobInfo.blobId;
  throw new Error('Invalid upload response: blobId not found');
}

/**
 * SieveScript/set arguments that create a script from an uploaded blob
 * (`id` absent) or point an existing one at it, activating it on success
 * when asked.
 */
export function sieveScriptSetArgs(opts: {
  accountId: string;
  creationId: string;
  id?: string;
  name: string;
  blobId: string;
  activate: boolean;
}): Record<string, unknown> {
  const args: Record<string, unknown> = { accountId: opts.accountId };
  if (opts.id) {
    args.update = { [opts.id]: { blobId: opts.blobId } };
  } else {
    args.create = { [opts.creationId]: { name: opts.name, blobId: opts.blobId } };
  }
  if (opts.activate) args.onSuccessActivateScript = opts.id ?? `#${opts.creationId}`;
  return args;
}
