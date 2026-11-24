import { hiddenSharedMailIds, setSharedMailAccountHidden } from '@/lib/shared-mail-visibility';

/**
 * Addresses kept out of From for new mail (#1673), such as a group address
 * the server gives every member. They still answer mail sent to them: a
 * reply or forward picks them as before, and they can be picked there.
 * Keyed by login (AccountEntry.id), since identity ids are per server.
 */

/** The reply-only identity ids of a login. */
export function replyOnlyIdentityIds(
  map: Record<string, string[]> | undefined,
  loginId: string | null | undefined,
): string[] {
  return hiddenSharedMailIds(map, loginId);
}

export function isReplyOnlyIdentity(
  map: Record<string, string[]> | undefined,
  loginId: string | null | undefined,
  identityId: string,
): boolean {
  return replyOnlyIdentityIds(map, loginId).includes(identityId);
}

/** The map with one identity marked reply-only, or offered for new mail again. */
export function setIdentityReplyOnly(
  map: Record<string, string[]>,
  loginId: string,
  identityId: string,
  replyOnly: boolean,
): Record<string, string[]> {
  return setSharedMailAccountHidden(map, loginId, identityId, replyOnly);
}
