import { matchesTerms, type ParsedQuery } from '@/lib/global-search/query-parser';
import { getActiveLocalAccountId, indexAccounts } from '@/lib/global-search/accounts';
import type { ContactHit, SearchAccount, SearchProvider } from '@/lib/global-search/types';
import type { AddressBook, ContactCard } from '@/lib/jmap/types';
import { getContactDisplayName, getContactPrimaryEmail, useContactStore } from '@/stores/contact-store';

/** Pro-shell store namespace: `${localAccountId}::${id}` (see contact-store). */
const STORE_DELIMITER = '::';

function contactFields(contact: ContactCard): string[] {
  const fields: string[] = [getContactDisplayName(contact)];
  for (const email of Object.values(contact.emails ?? {})) if (email?.address) fields.push(email.address);
  for (const org of Object.values(contact.organizations ?? {})) {
    const name = (org as { name?: string }).name;
    if (name) fields.push(name);
  }
  for (const phone of Object.values(contact.phones ?? {})) {
    const number = (phone as { number?: string }).number;
    if (number) fields.push(number);
  }
  for (const nick of Object.values(contact.nicknames ?? {})) {
    const name = (nick as { name?: string }).name;
    if (name) fields.push(name);
  }
  return fields;
}

function bookOf(contact: ContactCard, books: AddressBook[]): AddressBook | undefined {
  const ids = Object.keys(contact.addressBookIds ?? {});
  for (const id of ids) {
    const book = books.find((b) => b.id === id || b.originalId === id);
    if (book?.name) return book;
  }
  return undefined;
}

function toHit(
  contact: ContactCard,
  account: SearchAccount,
  storeId: string,
  source: 'local' | 'remote',
  books: AddressBook[],
): ContactHit {
  const title = getContactDisplayName(contact) || getContactPrimaryEmail(contact) || contact.originalId || contact.id;
  const email = getContactPrimaryEmail(contact);
  const book = bookOf(contact, books);
  const shownEmail = email && email !== title ? email : '';
  return {
    kind: 'contacts',
    serverUrl: account.serverUrl,
    localAccountId: account.localAccountId,
    jmapAccountId: contact.accountId ?? account.client.getContactsAccountId(),
    id: contact.originalId ?? contact.id,
    accountLabel: account.label,
    title,
    subtitle: [book?.name ?? '', shownEmail].filter(Boolean).join(' · '),
    ...(book ? { collection: { kind: 'addressBook' as const, name: book.name, isShared: book.isShared, rest: shownEmail } } : {}),
    date: contact.updated ?? null,
    source,
    contact,
    storeId,
  };
}

export const contactsProvider: SearchProvider = {
  kind: 'contacts',

  supports: (account) => account.client.supportsContacts(),

  local: (parsed: ParsedQuery, accounts: SearchAccount[], limit: number) => {
    const byId = indexAccounts(accounts);
    const active = getActiveLocalAccountId();
    const { contacts, addressBooks } = useContactStore.getState();
    const hits: ContactHit[] = [];
    for (const contact of contacts) {
      const localAccountId = contact.localAccountId ?? active;
      if (!localAccountId) continue;
      const account = byId.get(localAccountId);
      if (!account) continue;
      if (!matchesTerms(parsed.terms, contactFields(contact))) continue;
      hits.push(toHit(contact, account, contact.id, 'local', addressBooks));
      if (hits.length >= limit) break;
    }
    return hits;
  },

  remote: async (parsed, account, { limit, signal }) => {
    const found = await account.client.searchContacts(parsed.text);
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { addressBooks } = useContactStore.getState();
    // The store namespaces every aggregated account, so the id the contacts
    // surface knows is `${login}::${id-as-returned-by-the-client}` (shared
    // books already carry their `${owner}:` prefix from searchContacts).
    const hits = found.slice(0, limit).map((contact) => toHit(
      { ...contact, localAccountId: account.localAccountId },
      account,
      `${account.localAccountId}${STORE_DELIMITER}${contact.id}`,
      'remote',
      addressBooks,
    ));
    return { hits, hasMore: found.length > limit };
  },
};
