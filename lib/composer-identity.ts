import type { Identity } from '@/lib/jmap/types';
import { stripCrossAccountIdentityPrefix } from '@/hooks/use-pro-multi-account-identities';

/** What a composer's From field stands for. */
export interface ComposerFrom {
  /** The identity the message is written from; null only when there is none at all. */
  identity: Identity | null;
  /**
   * The chosen identity is not in the From list any more and belongs to
   * another login than the composer's own: that login was signed out, or its
   * identities are not loaded. The message still names it, so a send goes to
   * that login or nowhere.
   */
  unlisted: boolean;
}

/**
 * The identity a composer's chosen From id stands for.
 *
 * An identity id names its login (`<login>::<id>`) while several logins are
 * connected, and is the bare id otherwise, so the same identity can be
 * listed under the other form than the one that was chosen; it is still
 * that identity. One of the composer's own login that is gone from the list
 * (deleted on the server) falls back to the primary identity of that login.
 *
 * An identity of another login that is not listed is never replaced by one
 * of this login: the message would leave from another address, through
 * another server, without the user choosing it. It stays the chosen one, as
 * last listed (`lastListed`), or by its id alone when it was never listed.
 */
export function resolveComposerFrom(
  selectedId: string | null,
  identities: readonly Identity[],
  primary: Identity | null,
  composerLogin: string | null | undefined,
  lastListed: Identity | null,
): ComposerFrom {
  if (!selectedId) return { identity: primary, unlisted: false };
  const listed = identities.find((identity) => identity.id === selectedId);
  if (listed) return { identity: listed, unlisted: false };

  const { localAccountId, rawId } = stripCrossAccountIdentityPrefix(selectedId);
  if (!localAccountId) {
    // Chosen while one login was connected; the list names logins now.
    const named = composerLogin ? identities.find((identity) => identity.id === `${composerLogin}::${selectedId}`) : undefined;
    return { identity: named ?? primary, unlisted: false };
  }
  if (localAccountId === composerLogin) {
    // Chosen while several logins were connected; the list is this login's own now.
    const own = identities.find((identity) => identity.id === rawId);
    return { identity: own ?? primary, unlisted: false };
  }
  const kept = lastListed?.id === selectedId ? lastListed : ({ id: selectedId, email: '', name: '' } as Identity);
  return { identity: kept, unlisted: true };
}
