import type { AddressBook, ContactCard, ContactRelation } from "@/lib/jmap/types";

/** A card's uid as other cards name it: with or without `urn:uuid:`, in any case. */
function bareUid(value: string): string {
  return value.trim().replace(/^urn:uuid:/i, "").toLowerCase();
}

/**
 * The card a `relatedTo` key names. RFC 9553 keys the map by the related
 * card's uid, so the card is looked up among the loaded ones: in the same
 * account as `contact` first, since a uid is only unique within an account.
 *
 * Undefined when no card has that uid. Importers also keep other values
 * there (a name from an Android custom relation, a URL, see lib/vcard.ts);
 * those are shown as stored.
 */
export function findRelatedContact(
  key: string,
  contact: Pick<ContactCard, "id" | "accountId" | "localAccountId">,
  contacts: readonly ContactCard[],
): ContactCard | undefined {
  const wanted = bareUid(key);
  if (!wanted) return undefined;
  const matches = contacts.filter((c) => c.id !== contact.id && !!c.uid && bareUid(c.uid) === wanted);
  if (matches.length === 0) return undefined;
  const sameAccount = (c: ContactCard) =>
    (c.accountId ?? "") === (contact.accountId ?? "") && (c.localAccountId ?? "") === (contact.localAccountId ?? "");
  return matches.find(sameAccount) ?? (matches.length === 1 ? matches[0] : undefined);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a `relatedTo` key is a card's uid (`urn:uuid:…` or a bare UUID),
 * as Bulwark and Stalwart write them, rather than a name or URL an importer
 * kept there.
 */
export function looksLikeCardUid(key: string): boolean {
  const value = key.trim();
  return /^urn:uuid:/i.test(value) || UUID.test(value);
}

/** The login and JMAP account a card lives in; a uid is unique only there. */
function accountKey(c: Pick<ContactCard, "accountId" | "localAccountId">): string {
  return `${c.localAccountId ?? ""}|${c.accountId ?? ""}`;
}

/** A card in an address book shared read-only can't be changed. */
function isWritable(card: ContactCard, books: readonly AddressBook[]): boolean {
  return !Object.entries(card.addressBookIds ?? {})
    .some(([id, inBook]) => inBook && books.find((b) => b.id === id)?.myRights?.mayWrite === false);
}

export interface RelatedToCleanup {
  /** The card to change. */
  contact: ContactCard;
  /** Its new `relatedTo`; undefined when no entry is left. */
  relatedTo: Record<string, ContactRelation> | undefined;
}

/**
 * The `relatedTo` changes deleting `deletedIds` calls for: other cards of the
 * same account that name a deleted card lose that entry, so they don't list a
 * contact that no longer exists. Every other entry stays as it is.
 *
 * A uid that a card left in the account still has (a copy in another address
 * book) is kept. With `replacementUid` (merging duplicates), an entry is
 * pointed at that card instead, unless the card already names it or is that
 * card. Cards in read-only address books are left alone.
 */
export function planRelatedToCleanup(
  contacts: readonly ContactCard[],
  deletedIds: ReadonlySet<string>,
  books: readonly AddressBook[],
  replacementUid?: string,
): RelatedToCleanup[] {
  const goneByAccount = new Map<string, Set<string>>();
  for (const c of contacts) {
    if (!deletedIds.has(c.id) || !c.uid || !bareUid(c.uid)) continue;
    const key = accountKey(c);
    if (!goneByAccount.has(key)) goneByAccount.set(key, new Set());
    goneByAccount.get(key)!.add(bareUid(c.uid));
  }
  if (goneByAccount.size === 0) return [];
  for (const c of contacts) {
    if (deletedIds.has(c.id) || !c.uid) continue;
    goneByAccount.get(accountKey(c))?.delete(bareUid(c.uid));
  }

  const replacement = replacementUid && bareUid(replacementUid) ? replacementUid : undefined;
  const out: RelatedToCleanup[] = [];
  for (const c of contacts) {
    if (deletedIds.has(c.id) || !c.relatedTo) continue;
    const gone = goneByAccount.get(accountKey(c));
    if (!gone || gone.size === 0) continue;
    const entries = Object.entries(c.relatedTo);
    if (!entries.some(([key]) => gone.has(bareUid(key)))) continue;
    if (!isWritable(c, books)) continue;

    const isReplacement = !!replacement && !!c.uid && bareUid(c.uid) === bareUid(replacement);
    const next: Record<string, ContactRelation> = {};
    for (const [key, rel] of entries) {
      if (!gone.has(bareUid(key))) next[key] = rel;
    }
    if (replacement && !isReplacement) {
      const named = Object.keys(next).some((key) => bareUid(key) === bareUid(replacement));
      const moved = entries.find(([key]) => gone.has(bareUid(key)));
      if (!named && moved) next[replacement] = moved[1];
    }
    out.push({ contact: c, relatedTo: Object.keys(next).length > 0 ? next : undefined });
  }
  return out;
}
