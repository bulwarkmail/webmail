import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ContactCard, AddressBook, AddressBookRights, ContactName, ContactMedia } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { loadPrincipalDirectory } from '@/lib/jmap/principal-directory';
import { generateUUID } from '@/lib/utils';
import { debug } from '@/lib/debug';
import { settingsHooks } from '@/lib/plugin-hooks';
import { getClientByLocalAccountId } from './client-registry';
import { sanitizeDisplayName, splitMailbox } from '@/lib/rfc5322-mailbox';
import { inlineContactMedia, writeContactWithNewPhoto, type ContactSaveOptions } from '@/lib/contact-media';
import { contactHooks } from '@/lib/plugin-hooks';
import { contactToView } from '@/lib/plugin-projection';
import { PrincipalsRequestError } from '@/lib/jmap/principals-error';
import type { Principal } from '@/lib/jmap/types';
import { currentStoreEpoch } from '@/lib/store-epoch';

/** A contact that is about to be created, projected for plugins (no id yet). */
function draftContactView(contact: Partial<ContactCard>) {
  return contactToView({ addressBookIds: {}, ...contact, id: contact.id ?? '' } as ContactCard);
}

function sameIdSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** One compose-autocomplete suggestion: a person, or a contact group. */
type RecipientSuggestion = { name: string; email: string; group?: { id: string; memberCount: number } };

/**
 * Reduces every suggestion to a clean display name plus a bare address and
 * collapses the ones that resolve to the same address.
 *
 * Contacts whose stored name is really a whole mailbox ("Jane <j@x.com>", the
 * usual result of a flattened vCard import) otherwise show up next to the
 * properly parsed card as a second, raw-looking suggestion, and picking that
 * one composes a malformed recipient the receiving server rejects (#672).
 * Groups carry no address and pass through untouched.
 */
function normalizeSuggestions(results: RecipientSuggestion[]): RecipientSuggestion[] {
  const out: RecipientSuggestion[] = [];
  const indexByEmail = new Map<string, number>();
  for (const r of results) {
    if (r.group) {
      out.push(r);
      continue;
    }
    const mailbox = splitMailbox(r.email);
    if (!mailbox.email) continue;
    // The name loses any address it carries; when that leaves nothing, the one
    // the address field itself carried ("Jane <j@x.com>" stored as the address)
    // stands in.
    const name = sanitizeDisplayName(r.name) || mailbox.name || '';
    const suggestion = { name: name === mailbox.email ? '' : name, email: mailbox.email };
    const key = mailbox.email.toLowerCase();
    const seenAt = indexByEmail.get(key);
    if (seenAt === undefined) {
      indexByEmail.set(key, out.length);
      out.push(suggestion);
    } else if (!out[seenAt].name && suggestion.name) {
      // Keep the first hit's position but take a display name it was missing.
      out[seenAt].name = suggestion.name;
    }
  }
  return out;
}

/** One connected JMAP account for contact multi-account aggregation. */
export interface ContactAccountClient {
  localAccountId: string;
  client: IJMAPClient;
}

/**
 * Prefix used to namespace contact/address-book IDs when the Pro shell
 * aggregates across accounts. EVERY aggregated account is namespaced (including
 * the active one); single-account paths carry no localAccountId and stay raw.
 */
const CROSS_ACCOUNT_ID_DELIMITER = '::';

function buildCrossAccountIdPrefix(localAccountId: string): string {
  return `${localAccountId}${CROSS_ACCOUNT_ID_DELIMITER}`;
}

// EVERY aggregated account is namespaced, including the active one, so an id
// stably identifies (account, entity) regardless of which account is active -
// otherwise switching accounts flipped the id form and broke mutation routing /
// selection. Invariant: namespaced iff `localAccountId` is set; `originalId`
// holds the raw id. Mutations already resolve raw via `originalId ||
// stripLocalAccountPrefix`, so they keep working. Mirrors the calendar store.
function prefixAddressBooksWithLocalAccount(
  books: AddressBook[],
  localAccountId: string,
): AddressBook[] {
  const prefix = buildCrossAccountIdPrefix(localAccountId);
  return books.map((b) => ({
    ...b,
    id: `${prefix}${b.id}`,
    originalId: b.originalId ?? b.id,
    localAccountId,
  }));
}

function prefixContactsWithLocalAccount(
  contacts: ContactCard[],
  localAccountId: string,
): ContactCard[] {
  const prefix = buildCrossAccountIdPrefix(localAccountId);
  return contacts.map((c) => ({
    ...c,
    id: `${prefix}${c.id}`,
    originalId: c.originalId ?? c.id,
    localAccountId,
    addressBookIds: c.addressBookIds
      ? Object.fromEntries(
          Object.entries(c.addressBookIds).map(([bookId, v]) => [`${prefix}${bookId}`, v]),
        )
      : c.addressBookIds,
  }));
}

/**
 * Route mutations back through the client that owns the target entity
 * when in multi-account Pro mode. See [[useProMultiAccountContacts]].
 *
 * Lookup goes through `client-registry` (not a direct auth-store import)
 * to avoid a top-level cycle: auth-store already imports this module to
 * bootstrap feature stores after login.
 */
function resolveAccountClient<T extends IJMAPClient>(active: T, localAccountId?: string): T {
  if (!localAccountId) return active;
  const lookup = getClientByLocalAccountId(localAccountId) as T | undefined;
  return lookup ?? active;
}

function stripLocalAccountPrefix(id: string, localAccountId?: string): string {
  if (!localAccountId) return id;
  const prefix = `${localAccountId}${CROSS_ACCOUNT_ID_DELIMITER}`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * Map the address-book ids the UI works with (namespaced per shared account
 * as `accountId:bookId`, and per local account as `local::bookId` in
 * multi-account Pro mode - possibly both) back to the raw server ids that
 * `ContactCard/set` accepts. Resolution goes through the loaded address-book
 * list first, since every book carries its `originalId`; ids that are not in
 * the list (stale state, tests) fall back to stripping the known prefixes.
 * Sending a namespaced id makes Stalwart reject the card with "Contact has
 * to belong to at least one address book" (#133, #1043).
 */
function resolveRawAddressBookIds(
  addressBookIds: Record<string, boolean>,
  books: AddressBook[],
  owner?: { localAccountId?: string; accountId?: string; isShared?: boolean },
): { addressBookIds: Record<string, boolean>; sharedAccountId?: string; localAccountId?: string } {
  const raw: Record<string, boolean> = {};
  let sharedAccountId: string | undefined;
  let localAccountId = owner?.localAccountId;
  for (const [bookId, value] of Object.entries(addressBookIds)) {
    const book = books.find(b => b.id === bookId);
    if (book?.localAccountId) localAccountId = book.localAccountId;
    if (book?.isShared && book.accountId) sharedAccountId = book.accountId;
    if (book?.originalId) {
      raw[book.originalId] = value;
      continue;
    }
    let stripped = stripLocalAccountPrefix(bookId, localAccountId);
    if (owner?.isShared && owner.accountId && stripped.startsWith(`${owner.accountId}:`)) {
      stripped = stripped.slice(owner.accountId.length + 1);
    }
    raw[stripped] = value;
  }
  return { addressBookIds: raw, sharedAccountId, localAccountId };
}

export function getContactDisplayName(contact: ContactCard): string {
  if (contact.name) {
    // Try given + surname from components first
    if (contact.name.components && contact.name.components.length > 0) {
      const given = contact.name.components.find(c => c.kind === 'given')?.value || '';
      const surname = contact.name.components.find(c => c.kind === 'surname')?.value || '';
      const full = [given, surname].filter(Boolean).join(' ');
      if (full) return full;
    }
    // Fall back to name.full (RFC 9553 - used by Stalwart and other JMAP servers)
    if (contact.name.full) return contact.name.full;
  }
  if (contact.nicknames) {
    const nick = Object.values(contact.nicknames)[0];
    if (nick?.name) return nick.name;
  }
  if (contact.organizations) {
    const org = Object.values(contact.organizations)[0];
    if (org?.name) return org.name;
  }
  if (contact.emails) {
    const email = Object.values(contact.emails)[0];
    if (email?.address) return email.address;
  }
  return '';
}

// Name used to order (and letter-group) the contact list. With `byLastName`
// the surname leads ("Smith, Alice") so family members sit together (#963).
// Contacts without a structured surname fall back to the last word of
// `name.full`; everything else (nickname, org, email) keeps the display name.
export function getContactSortName(contact: ContactCard, byLastName: boolean): string {
  const display = getContactDisplayName(contact);
  if (!byLastName) return display;
  const components = contact.name?.components;
  if (components && components.length > 0) {
    const pick = (...kinds: string[]) =>
      components.filter(c => kinds.includes(c.kind) && c.value).map(c => c.value).join(' ');
    const surname = pick('surname', 'surname2');
    if (surname) {
      const rest = pick('given', 'given2', 'middle', 'additional');
      return rest ? `${surname}, ${rest}` : surname;
    }
  }
  const full = contact.name?.full;
  if (full && display === full) {
    const words = full.trim().split(/\s+/);
    if (words.length > 1) {
      const last = words[words.length - 1];
      return `${last}, ${words.slice(0, -1).join(' ')}`;
    }
  }
  return display;
}

export function getContactPrimaryEmail(contact: ContactCard): string {
  if (!contact.emails) return '';
  return Object.values(contact.emails)[0]?.address || '';
}

// Some JMAP servers (notably Stalwart, see issue #307) emit photo data URIs
// without a mediatype, like `data:base64,...` or `data:;base64,...`. Per
// RFC 2397 the missing/empty mediatype defaults to `text/plain`, so browsers
// won't render the bytes as an image. Rewrite to include a mediatype.
export function normalizeContactPhotoUri(uri: string, mediaType?: string): string {
  const mime = mediaType && mediaType.includes('/') ? mediaType : 'image/jpeg';
  if (uri.startsWith('data:base64,')) {
    return `data:${mime};base64,${uri.slice('data:base64,'.length)}`;
  }
  if (uri.startsWith('data:;base64,')) {
    return `data:${mime};base64,${uri.slice('data:;base64,'.length)}`;
  }
  return uri;
}

/**
 * A contact photo as something to show: a URI (https, or a data: URI with
 * its media type fixed), or a blob that still has to be downloaded. Stalwart
 * 1.0 returns every embedded photo as a blob; 0.16 as a data: URI.
 */
export type ContactPhotoRef =
  | { uri: string }
  | { blobId: string; mediaType?: string; accountId?: string; localAccountId?: string };

/**
 * The card's photo entry and its key: the `media` entry of kind photo with
 * the lowest `pref` (RFC 9553: unset counts as least preferred), the first
 * one on a tie.
 */
export function findContactPhotoEntry(contact: Pick<ContactCard, 'media'>): [string, ContactMedia] | undefined {
  let found: [string, ContactMedia] | undefined;
  for (const [key, media] of Object.entries(contact.media ?? {})) {
    if (media?.kind !== 'photo' || !(media.uri || media.blobId)) continue;
    if (!found || (media.pref ?? Infinity) < (found[1].pref ?? Infinity)) found = [key, media];
  }
  return found;
}

export function getContactPhotoRef(contact: ContactCard): ContactPhotoRef | undefined {
  const media = findContactPhotoEntry(contact)?.[1];
  if (media?.uri) return { uri: normalizeContactPhotoUri(media.uri, media.mediaType) };
  if (media?.blobId) {
    return { blobId: media.blobId, mediaType: media.mediaType, accountId: contact.accountId, localAccountId: contact.localAccountId };
  }
  return undefined;
}

export function hasContactPhoto(contact: ContactCard): boolean {
  return !!findContactPhotoEntry(contact);
}

/** The photo URI, for callers that cannot download a blob photo. */
export function getContactPhotoUri(contact: ContactCard): string | undefined {
  const ref = getContactPhotoRef(contact);
  return ref && 'uri' in ref ? ref.uri : undefined;
}

const photoIndexes = new WeakMap<ContactCard[], Map<string, ContactPhotoRef>>();

/**
 * Lowercased address to the photo of the first contact that has both, built
 * once per contacts array. Every avatar looks its sender up here; scanning
 * all contacts per avatar was quadratic on the mail list.
 */
export function getContactPhotoIndex(contacts: ContactCard[]): Map<string, ContactPhotoRef> {
  let index = photoIndexes.get(contacts);
  if (!index) {
    index = new Map();
    for (const contact of contacts) {
      const photo = getContactPhotoRef(contact);
      if (!photo) continue;
      for (const entry of Object.values(contact.emails ?? {})) {
        const address = entry?.address?.toLowerCase();
        if (address && !index.has(address)) index.set(address, photo);
      }
    }
    photoIndexes.set(contacts, index);
  }
  return index;
}

export const TRUSTED_SENDERS_BOOK_NAME = 'Trusted Senders';

/** In-flight trusted senders load, shared by all callers to keep it single-flight. */
let trustedSendersLoadPromise: Promise<void> | null = null;

/** Every e-mail address held by the given contacts, lowercased and de-duplicated. */
export function collectContactEmails(contacts: ContactCard[]): string[] {
  const seen = new Set<string>();
  for (const contact of contacts) {
    if (!contact.emails) continue;
    for (const entry of Object.values(contact.emails)) {
      const address = entry.address?.toLowerCase().trim();
      if (address) seen.add(address);
    }
  }
  return Array.from(seen);
}

/**
 * Fold duplicate "Trusted Senders" books into the canonical one and delete the
 * emptied leftovers (#730).  Contacts that already exist in the canonical book
 * are dropped rather than copied, so merging never produces two cards for the
 * same address.  A duplicate is only destroyed once every one of its contacts
 * has been moved or removed - if any step fails the book is left untouched so
 * no trusted sender is lost.
 */
export async function consolidateTrustedSenderBooks(
  client: IJMAPClient,
  canonicalBookId: string,
  duplicates: AddressBook[],
  knownEmails: string[]
): Promise<string[]> {
  const emails = new Set(knownEmails);

  for (const duplicate of duplicates) {
    try {
      const contacts = await client.getContacts(duplicate.id, { throwOnError: true });
      for (const contact of contacts) {
        const addresses = collectContactEmails([contact]);
        // Cards filed in other books too must never be destroyed - only unfiled
        // from the duplicate.
        const otherBookIds = Object.keys(contact.addressBookIds || {}).filter(id => id !== duplicate.id);
        const addressBookIds: Record<string, boolean> = {};
        for (const id of otherBookIds) addressBookIds[id] = true;

        if (addresses.some(address => !emails.has(address))) {
          addressBookIds[canonicalBookId] = true;
          await client.updateContact(contact.id, { addressBookIds });
          addresses.forEach(address => emails.add(address));
        } else if (otherBookIds.length > 0) {
          await client.updateContact(contact.id, { addressBookIds });
        } else {
          await client.deleteContact(contact.id);
        }
      }
      await client.deleteAddressBook(duplicate.id);
      debug.log('contacts', 'Merged duplicate trusted senders book:', duplicate.id);
    } catch (error) {
      debug.error('Failed to merge duplicate trusted senders book:', duplicate.id, error);
    }
  }

  return Array.from(emails);
}

interface ContactStore {
  contacts: ContactCard[];
  addressBooks: AddressBook[];
  selectedContactId: string | null;
  searchQuery: string;
  isLoading: boolean;
  error: string | null;
  supportsSync: boolean;
  /** False until the first fetch from the server has finished (runtime only). */
  contactsLoaded: boolean;

  // Trusted senders address book cache (runtime only, not persisted)
  trustedSenderEmails: string[];
  trustedSendersBookId: string | null;
  trustedSendersLoaded: boolean;
  trustedSendersLoading: boolean;

  // Recent recipients (from the Sent folder) for compose autocomplete - runtime only
  recentRecipients: Array<{ name: string; email: string }>;
  recentRecipientsLoaded: boolean;
  sentMailboxId: string | null;

  selectedContactIds: Set<string>;
  lastSelectedContactId: string | null;
  activeTab: 'all' | 'groups';

  // Directory (RFC 9670 principals) — other users/groups on the server, used to
  // augment recipient autocomplete and for the browsable company directory.
  // Runtime only, not persisted.
  directoryPrincipals: DirectoryEntry[];
  directoryLoaded: boolean;
  directoryStatus: DirectoryStatus;

  fetchContacts: (client: IJMAPClient) => Promise<void>;
  fetchDirectory: (client: IJMAPClient) => Promise<void>;
  fetchAddressBooks: (client: IJMAPClient) => Promise<void>;
  fetchAllAccountsContacts: (accounts: ContactAccountClient[]) => Promise<void>;
  fetchAllAccountsAddressBooks: (accounts: ContactAccountClient[]) => Promise<void>;
  // The contact actions resolve to false when a plugin stopped them
  // (onBeforeContactCreate / Update / Delete); nothing changed then.
  createContact: (client: IJMAPClient, contact: Partial<ContactCard>, options?: ContactSaveOptions) => Promise<boolean>;
  updateContact: (client: IJMAPClient, id: string, updates: Partial<ContactCard>, options?: ContactSaveOptions) => Promise<boolean>;
  /** The card as its server has it now, or null when it can't be read. */
  fetchContactFromServer: (client: IJMAPClient, id: string) => Promise<ContactCard | null>;
  deleteContact: (client: IJMAPClient, id: string) => Promise<boolean>;

  addLocalContact: (contact: ContactCard) => Promise<boolean>;
  updateLocalContact: (id: string, updates: Partial<ContactCard>) => Promise<boolean>;
  deleteLocalContact: (id: string) => Promise<boolean>;

  setSelectedContact: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setSupportsSync: (supports: boolean) => void;
  setActiveTab: (tab: 'all' | 'groups') => void;
  clearContacts: () => void;

  getAutocomplete: (query: string) => Array<{ name: string; email: string; group?: { id: string; memberCount: number } }>;

  getGroups: () => ContactCard[];
  getIndividuals: () => ContactCard[];
  getGroupMembers: (groupId: string) => ContactCard[];
  createGroup: (client: IJMAPClient | null, name: string, memberIds: string[]) => Promise<void>;
  updateGroup: (client: IJMAPClient | null, groupId: string, name: string) => Promise<void>;
  addMembersToGroup: (client: IJMAPClient | null, groupId: string, memberIds: string[]) => Promise<void>;
  removeMembersFromGroup: (client: IJMAPClient | null, groupId: string, memberIds: string[]) => Promise<void>;
  deleteGroup: (client: IJMAPClient | null, groupId: string) => Promise<void>;

  toggleContactSelection: (id: string) => void;
  selectRangeContacts: (targetId: string, sortedIds: string[]) => void;
  selectAllContacts: (ids: string[]) => void;
  clearSelection: () => void;
  /** false when a plugin stopped it (the plugin tells the user why). */
  bulkDeleteContacts: (client: IJMAPClient | null, ids: string[]) => Promise<boolean>;
  bulkAddToGroup: (client: IJMAPClient | null, groupId: string, contactIds: string[]) => Promise<void>;
  moveContactToAddressBook: (client: IJMAPClient, contactIds: string[], addressBook: AddressBook) => Promise<void>;
  createAddressBook: (client: IJMAPClient, name: string) => Promise<AddressBook>;
  renameAddressBook: (client: IJMAPClient, addressBook: AddressBook, newName: string) => Promise<void>;
  setDefaultAddressBook: (client: IJMAPClient, addressBook: AddressBook) => Promise<void>;
  removeAddressBook: (client: IJMAPClient, addressBook: AddressBook) => Promise<void>;
  shareAddressBook: (client: IJMAPClient, addressBook: AddressBook, principalId: string, rights: AddressBookRights | null) => Promise<void>;
  renameKeyword: (client: IJMAPClient | null, oldKeyword: string, newKeyword: string) => Promise<void>;

  importContacts: (client: IJMAPClient | null, contacts: ContactCard[]) => Promise<number>;

  // Trusted senders address book
  loadTrustedSendersBook: (client: IJMAPClient) => Promise<void>;
  addToTrustedSendersBook: (client: IJMAPClient, email: string) => Promise<void>;
  removeFromTrustedSendersBook: (client: IJMAPClient, email: string) => Promise<void>;
  isTrustedAddressBookSender: (email: string) => boolean;

  // Recent recipients (compose autocomplete, derived from the Sent folder)
  loadRecentRecipients: (client: IJMAPClient, sentMailboxId: string) => Promise<void>;
  // On-demand "search the server" for recipients not in the recent cache
  searchRecipients: (client: IJMAPClient, query: string) => Promise<Array<{ name: string; email: string }>>;
}

/** One entry of the company directory: a principal that has an address. */
export interface DirectoryEntry {
  id?: string;
  /** Display name: the principal's description, else its name, else the address. */
  name: string;
  email: string;
  description?: string;
  type?: Principal['type'];
}

/**
 * Where the directory fetch stands. `unavailable`: the server has no
 * principals capability. `forbidden`: the server refused this account's
 * directory query. `error`: the request failed.
 */
export type DirectoryStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'forbidden' | 'error';

export function principalsToDirectory(principals: Principal[]): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
  const seen = new Set<string>();
  for (const p of principals) {
    // Stalwart reports a principal's account name in `email`; only those
    // with an address are usable as recipients.
    const email = p.email?.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    entries.push({
      id: p.id,
      name: p.description || p.name || email,
      email,
      description: p.description ?? undefined,
      type: p.type,
    });
  }
  return entries;
}

/** The Sent-folder read loadRecentRecipients has in flight, if any. */
let recentRecipientsLoading: Promise<void> | null = null;

export const useContactStore = create<ContactStore>()(
  persist(
    (set, get) => {

      // Clean group member references when contacts are removed
      function cleanGroupMembers(contacts: ContactCard[], removedIds: Set<string>): ContactCard[] {
        // Collect uid/id variants of removed contacts for matching
        const removedKeys = new Set<string>();
        for (const c of contacts) {
          if (!removedIds.has(c.id)) continue;
          removedKeys.add(c.id);
          if (c.uid) {
            removedKeys.add(c.uid);
            const bare = c.uid.startsWith('urn:uuid:') ? c.uid.slice(9) : c.uid;
            removedKeys.add(bare);
          }
          if (c.originalId) removedKeys.add(c.originalId);
        }
        return contacts.map(c => {
          if (c.kind !== 'group' || !c.members) return c;
          let changed = false;
          const newMembers: Record<string, boolean> = {};
          for (const [key, val] of Object.entries(c.members)) {
            const bareKey = key.startsWith('urn:uuid:') ? key.slice(9) : key;
            if (removedKeys.has(key) || removedKeys.has(bareKey)) {
              changed = true;
            } else {
              newMembers[key] = val;
            }
          }
          return changed ? { ...c, members: newMembers } : c;
        });
      }

      return ({
      contacts: [],
      addressBooks: [],
      selectedContactId: null,
      searchQuery: '',
      isLoading: false,
      error: null,
      supportsSync: false,
      contactsLoaded: false,
      trustedSenderEmails: [],
      trustedSendersBookId: null,
      trustedSendersLoaded: false,
      trustedSendersLoading: false,
      recentRecipients: [],
      recentRecipientsLoaded: false,
      sentMailboxId: null,
      selectedContactIds: new Set<string>(),
      lastSelectedContactId: null,
      activeTab: 'all' as const,
      directoryPrincipals: [],
      directoryLoaded: false,
      directoryStatus: 'idle' as DirectoryStatus,

      // Every fetch below captures the store epoch before awaiting the server
      // and drops its result once the stores were cleared for another account
      // (lib/store-epoch.ts): a slow answer for account A must not become
      // account B's address book, autocomplete and contact list.
      fetchContacts: async (client) => {
        const epoch = currentStoreEpoch();
        set({ isLoading: true, error: null });
        try {
          const contacts = await client.getAllContacts();
          if (currentStoreEpoch() !== epoch) return;
          set({ contacts, isLoading: false, contactsLoaded: true });
        } catch (error) {
          if (currentStoreEpoch() !== epoch) return;
          console.error('Failed to fetch contacts:', error);
          set({ error: 'Failed to fetch contacts', isLoading: false, contactsLoaded: true });
        }
      },

      fetchDirectory: async (client) => {
        if (!client.supportsPrincipals()) {
          set({ directoryStatus: 'unavailable' });
          return;
        }
        const epoch = currentStoreEpoch();
        set({ directoryStatus: 'loading' });
        try {
          // Shared with the share dialog and free/busy (loadPrincipalDirectory).
          const { principals, status } = await loadPrincipalDirectory(client);
          if (currentStoreEpoch() !== epoch) return;
          if (status === 'error') throw new PrincipalsRequestError(null);
          if (status !== 'ok') debug.log('contacts', `Directory listing is ${status}; autocomplete offers ${principals.length} principals`);
          // A restricted listing (Stalwart 1.0 without directory queries) still
          // holds the principals the user knows, for autocomplete and browsing.
          set({
            directoryPrincipals: principalsToDirectory(principals),
            directoryLoaded: true,
            directoryStatus: status === 'restricted' ? 'forbidden' : 'ready',
          });
        } catch (error) {
          if (currentStoreEpoch() !== epoch) return;
          debug.error('Failed to fetch directory principals:', error);
          // Keep what an earlier fetch returned: autocomplete still works off it.
          const forbidden = error instanceof PrincipalsRequestError && error.type === 'forbidden';
          set({ directoryStatus: forbidden ? 'forbidden' : 'error' });
        }
      },

      fetchAddressBooks: async (client) => {
        const epoch = currentStoreEpoch();
        try {
          const addressBooks = await client.getAllAddressBooks();
          if (currentStoreEpoch() !== epoch) return;
          set({ addressBooks });
        } catch (error) {
          if (currentStoreEpoch() !== epoch) return;
          console.error('Failed to fetch address books:', error);
          set({ error: 'Failed to fetch address books' });
        }
      },

      fetchAllAccountsContacts: async (accounts) => {
        const epoch = currentStoreEpoch();
        set({ isLoading: true, error: null });
        try {
          const results = await Promise.all(
            accounts.map(async ({ client, localAccountId }) => {
              try {
                const list = await client.getAllContacts();
                return prefixContactsWithLocalAccount(list, localAccountId);
              } catch (error) {
                debug.error(`Failed to fetch contacts for account ${localAccountId}:`, error);
                return [] as ContactCard[];
              }
            }),
          );
          if (currentStoreEpoch() !== epoch) return;
          set({ contacts: results.flat(), isLoading: false, contactsLoaded: true });
        } catch (error) {
          if (currentStoreEpoch() !== epoch) return;
          console.error('Failed to fetch all-account contacts:', error);
          set({ error: 'Failed to fetch contacts', isLoading: false, contactsLoaded: true });
        }
      },

      fetchAllAccountsAddressBooks: async (accounts) => {
        const epoch = currentStoreEpoch();
        try {
          const results = await Promise.all(
            accounts.map(async ({ client, localAccountId }) => {
              try {
                const list = await client.getAllAddressBooks();
                return prefixAddressBooksWithLocalAccount(list, localAccountId);
              } catch (error) {
                debug.error(`Failed to fetch address books for account ${localAccountId}:`, error);
                return [] as AddressBook[];
              }
            }),
          );
          if (currentStoreEpoch() !== epoch) return;
          set({ addressBooks: results.flat() });
        } catch (error) {
          if (currentStoreEpoch() !== epoch) return;
          console.error('Failed to fetch all-account address books:', error);
          set({ error: 'Failed to fetch address books' });
        }
      },

      createContact: async (client, contact, options) => {
        if (!(await contactHooks.onBeforeContactCreate.intercept(draftContactView(contact)))) return false;
        set({ isLoading: true, error: null });
        try {
          // Determine target account from the selected address book. Also
          // pin the local account so we route through the right server's
          // client in multi-account Pro mode.
          let accountId = contact.isShared ? contact.accountId : undefined;
          let cleanedContact = contact;
          let localAccountId = contact.localAccountId;

          // De-namespace addressBookIds (shared and/or local-account prefixes)
          if (contact.addressBookIds) {
            const resolved = resolveRawAddressBookIds(contact.addressBookIds, get().addressBooks, contact);
            localAccountId = resolved.localAccountId;
            if (resolved.sharedAccountId) {
              accountId = resolved.sharedAccountId;
              cleanedContact = { ...contact, addressBookIds: resolved.addressBookIds, isShared: true, accountId: resolved.sharedAccountId };
            } else {
              cleanedContact = { ...contact, addressBookIds: resolved.addressBookIds };
            }
          }

          const owner = resolveAccountClient(client, localAccountId);
          const created = options?.photoKey
            ? await writeContactWithNewPhoto(owner, accountId, cleanedContact, options.photoKey,
              (card) => owner.createContact(card, accountId))
            : await owner.createContact(cleanedContact, accountId);
          // The card under the id the listings give it (getAllContacts, then
          // prefixContactsWithLocalAccount): card ids repeat across accounts,
          // and one from a shared book kept under its bare id was taken for
          // the own card of that id by the next change or delete.
          let stored = created;
          if (accountId) {
            stored = {
              ...created,
              id: `${accountId}:${created.id}`,
              originalId: created.id,
              accountId,
              accountName: contact.accountName
                ?? get().addressBooks.find(b => b.isShared && b.accountId === accountId)?.accountName,
              isShared: true,
              addressBookIds: Object.fromEntries(
                Object.entries(created.addressBookIds ?? {}).map(([bookId, v]) => [`${accountId}:${bookId}`, v]),
              ),
            };
          }
          if (localAccountId) stored = prefixContactsWithLocalAccount([stored], localAccountId)[0];
          set((state) => ({
            contacts: [...state.contacts, stored],
            isLoading: false,
          }));
          void contactHooks.onAfterContactCreate.emit(contactToView(stored));
          return true;
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to create contact';
          set({ error: msg, isLoading: false });
          throw error;
        }
      },

      updateContact: async (client, id, updates, options) => {
        if (!(await contactHooks.onBeforeContactUpdate.intercept({ contactId: id, patch: updates }))) return false;
        set({ error: null });
        try {
          const contact = get().contacts.find(c => c.id === id);
          const originalId = contact?.originalId || stripLocalAccountPrefix(id, contact?.localAccountId);
          const accountId = contact?.isShared ? contact.accountId : undefined;
          const owner = resolveAccountClient(client, contact?.localAccountId);

          // De-namespace addressBookIds before sending to the JMAP server. This
          // applies to personal books too: in multi-account Pro mode every id
          // carries the `local::` prefix, and the server rejects it (#1043).
          let cleanedUpdates = updates;
          if (updates.addressBookIds) {
            const resolved = resolveRawAddressBookIds(updates.addressBookIds, get().addressBooks, contact);
            cleanedUpdates = { ...updates, addressBookIds: resolved.addressBookIds };
          }

          if (options?.photoKey) {
            await writeContactWithNewPhoto(owner, accountId, cleanedUpdates, options.photoKey,
              (card) => owner.updateContact(originalId, card, accountId));
          } else {
            await owner.updateContact(originalId, cleanedUpdates, accountId);
          }
          set((state) => ({
            contacts: state.contacts.map(c =>
              c.id === id ? { ...c, ...updates } : c
            ),
          }));
          const updated = get().contacts.find(c => c.id === id);
          if (updated) void contactHooks.onAfterContactUpdate.emit(contactToView(updated));
          return true;
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to update contact';
          set({ error: msg });
          throw error;
        }
      },

      fetchContactFromServer: async (client, id) => {
        const contact = get().contacts.find(c => c.id === id);
        const originalId = contact?.originalId || stripLocalAccountPrefix(id, contact?.localAccountId);
        const accountId = contact?.isShared ? contact.accountId : undefined;
        return resolveAccountClient(client, contact?.localAccountId).getContact(originalId, accountId);
      },

      deleteContact: async (client, id) => {
        if (!(await contactHooks.onBeforeContactDelete.intercept({ contactIds: [id] }))) return false;
        set({ error: null });
        try {
          const contact = get().contacts.find(c => c.id === id);
          const originalId = contact?.originalId || stripLocalAccountPrefix(id, contact?.localAccountId);
          const accountId = contact?.isShared ? contact.accountId : undefined;
          client = resolveAccountClient(client, contact?.localAccountId);
          await client.deleteContact(originalId, accountId);
          set((state) => {
            const removedIds = new Set([id]);
            const cleaned = cleanGroupMembers(state.contacts, removedIds);
            return {
              contacts: cleaned.filter(c => c.id !== id),
              selectedContactId: state.selectedContactId === id ? null : state.selectedContactId,
            };
          });
          void contactHooks.onAfterContactDelete.emit({ contactIds: [id] });
          return true;
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to delete contact';
          set({ error: msg });
          throw error;
        }
      },

      addLocalContact: async (contact) => {
        if (!(await contactHooks.onBeforeContactCreate.intercept(draftContactView(contact)))) return false;
        set((state) => ({ contacts: [...state.contacts, contact] }));
        void contactHooks.onAfterContactCreate.emit(contactToView(contact));
        return true;
      },

      updateLocalContact: async (id, updates) => {
        if (!(await contactHooks.onBeforeContactUpdate.intercept({ contactId: id, patch: updates }))) return false;
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === id ? { ...c, ...updates } : c
          ),
        }));
        const updated = get().contacts.find(c => c.id === id);
        if (updated) void contactHooks.onAfterContactUpdate.emit(contactToView(updated));
        return true;
      },

      deleteLocalContact: async (id) => {
        if (!(await contactHooks.onBeforeContactDelete.intercept({ contactIds: [id] }))) return false;
        set((state) => {
          const removedIds = new Set([id]);
          const cleaned = cleanGroupMembers(state.contacts, removedIds);
          return {
            contacts: cleaned.filter(c => c.id !== id),
            selectedContactId: state.selectedContactId === id ? null : state.selectedContactId,
          };
        });
        void contactHooks.onAfterContactDelete.emit({ contactIds: [id] });
        return true;
      },

      setSelectedContact: (id) => set({ selectedContactId: id }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSupportsSync: (supports) => set({ supportsSync: supports }),
      setActiveTab: (tab) => set({ activeTab: tab }),

      clearContacts: () => set({
        contacts: [],
        contactsLoaded: false,
        addressBooks: [],
        selectedContactId: null,
        searchQuery: '',
        error: null,
        selectedContactIds: new Set<string>(),
        activeTab: 'all',
        directoryPrincipals: [],
        directoryLoaded: false,
        directoryStatus: 'idle',
      }),

      getAutocomplete: (query) => {
        const { contacts } = get();
        if (!query || query.length < 1) return [];

        const lower = query.toLowerCase();
        const results: RecipientSuggestion[] = [];

        for (const contact of contacts) {
          if (contact.kind === 'group') {
            // Suggest the group itself as a single entry (Outlook-style);
            // the composer turns it into one chip carrying the members.
            const groupName = getContactDisplayName(contact);
            if (groupName && groupName.toLowerCase().includes(lower)) {
              const memberCount = get().getGroupMembers(contact.id)
                .filter(m => getContactPrimaryEmail(m).trim()).length;
              if (memberCount > 0) {
                results.push({ name: groupName, email: '', group: { id: contact.id, memberCount } });
              }
            }
            continue;
          }

          const name = getContactDisplayName(contact);
          const emails = contact.emails ? Object.values(contact.emails) : [];

          for (const emailEntry of emails) {
            if (!emailEntry.address) continue;
            if (
              name.toLowerCase().includes(lower) ||
              emailEntry.address.toLowerCase().includes(lower)
            ) {
              results.push({ name, email: emailEntry.address });
            }
          }

          if (results.length >= 10) break;
        }

        // Augment with directory principals (other users on the server, RFC 9670).
        // Contacts take precedence, so skip any address already suggested.
        const { directoryPrincipals } = get();
        if (directoryPrincipals.length > 0) {
          const seen = new Set(results.map(r => r.email.toLowerCase()));
          for (const p of directoryPrincipals) {
            if (results.length >= 10) break;
            const addr = p.email.toLowerCase();
            if (seen.has(addr)) {
              const betterName = p.description || p.name;
              if (betterName && betterName !== p.email) {
                const existing = results.find(r => r.email.toLowerCase() === addr);
                if (existing && (!existing.name || existing.name === existing.email)) {
                  existing.name = betterName;
                }
              }
              continue;
            }
            if (p.name.toLowerCase().includes(lower) || addr.includes(lower) || (p.description && p.description.toLowerCase().includes(lower))) {
              const displayName = p.description || p.name;
              const name = displayName !== p.email ? displayName : '';
              results.push({ name, email: p.email });
              seen.add(addr);
            }
          }
        }

        // Finally fold in recent recipients from the Sent folder (people you've
        // written to - the OWA-style autocomplete cache). Contacts and directory
        // principals take precedence, so skip any address already suggested (no
        // duplicates). These carry the display name from the message, so match
        // on name or address.
        const { recentRecipients } = get();
        if (recentRecipients.length > 0 && results.length < 10) {
          const seenRecent = new Set(results.map(r => r.email.toLowerCase()));
          for (const rec of recentRecipients) {
            if (results.length >= 10) break;
            const addr = rec.email.toLowerCase();
            if (seenRecent.has(addr)) continue;
            if (addr.includes(lower) || (rec.name && rec.name.toLowerCase().includes(lower))) {
              results.push({ name: rec.name, email: rec.email });
              seenRecent.add(addr);
            }
          }
        }

        return normalizeSuggestions(results);
      },

      getGroups: () => {
        return get().contacts.filter(c => c.kind === 'group');
      },

      getIndividuals: () => {
        return get().contacts.filter(c => c.kind !== 'group');
      },

      getGroupMembers: (groupId) => {
        const { contacts } = get();
        const group = contacts.find(c => c.id === groupId);
        if (!group?.members) return [];
        const memberKeys = Object.keys(group.members).filter(k => group.members![k]);
        // Normalize: strip urn:uuid: prefix for matching
        const normalizedKeys = memberKeys.map(k => k.startsWith('urn:uuid:') ? k.slice(9) : k);
        return contacts.filter(c => {
          if (memberKeys.includes(c.id) || normalizedKeys.includes(c.id)) return true;
          if (c.uid) {
            const bareUid = c.uid.startsWith('urn:uuid:') ? c.uid.slice(9) : c.uid;
            return memberKeys.includes(c.uid) || normalizedKeys.includes(bareUid);
          }
          return false;
        });
      },

      createGroup: async (client, name, memberIds) => {
        const { contacts } = get();
        const members: Record<string, boolean> = {};
        memberIds.forEach(id => {
          const contact = contacts.find(c => c.id === id);
          const key = contact?.uid || id;
          members[key] = true;
        });

        const groupData: Partial<ContactCard> = {
          kind: 'group',
          // `full` feeds the mandatory vCard FN; without it strict CardDAV
          // clients (Apple Contacts) drop the card entirely (#430).
          name: { components: [{ kind: 'given', value: name }], isOrdered: true, full: name },
          members,
        };

        let groupId: string;
        if (client && get().supportsSync) {
          const created = await client.createContact(groupData);
          set((state) => ({ contacts: [...state.contacts, created] }));
          groupId = created.id;
        } else {
          const localGroup: ContactCard = {
            id: `local-${generateUUID()}`,
            addressBookIds: {},
            ...groupData,
          } as ContactCard;
          set((state) => ({ contacts: [...state.contacts, localGroup] }));
          groupId = localGroup.id;
        }
        void contactHooks.onContactGroupChange.emit({ groupId, change: 'created' });
      },

      updateGroup: async (client, groupId, name) => {
        const updates: Partial<ContactCard> = {
          name: { components: [{ kind: 'given', value: name }], isOrdered: true, full: name },
        };
        if (client && get().supportsSync) {
          const group = get().contacts.find(c => c.id === groupId);
          const originalId = group?.originalId || groupId;
          const accountId = group?.isShared ? group.accountId : undefined;
          await resolveAccountClient(client, group?.localAccountId).updateContact(originalId, updates, accountId);
        }
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === groupId ? { ...c, ...updates } : c
          ),
        }));
        void contactHooks.onContactGroupChange.emit({ groupId, change: 'updated' });
      },

      addMembersToGroup: async (client, groupId, memberIds) => {
        const { contacts } = get();
        const group = contacts.find(c => c.id === groupId);
        if (!group) return;

        const newMembers = { ...group.members };
        const added: string[] = [];
        memberIds.forEach(id => {
          const contact = contacts.find(c => c.id === id);
          const key = contact?.uid || contact?.originalId || id;
          if (!newMembers[key]) added.push(id);
          newMembers[key] = true;
        });

        const updates: Partial<ContactCard> = { members: newMembers };
        if (client && get().supportsSync) {
          const originalId = group.originalId || groupId;
          const accountId = group.isShared ? group.accountId : undefined;
          await resolveAccountClient(client, group.localAccountId).updateContact(originalId, updates, accountId);
        }
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === groupId ? { ...c, members: newMembers } : c
          ),
        }));
        if (added.length > 0) {
          void contactHooks.onContactGroupMemberChange.emit({ groupId, added, removed: [] });
        }
      },

      removeMembersFromGroup: async (client, groupId, memberIds) => {
        const { contacts } = get();
        const group = contacts.find(c => c.id === groupId);
        if (!group?.members) return;

        const newMembers = { ...group.members };
        const removed: string[] = [];
        memberIds.forEach(id => {
          // Try direct id match first
          if (newMembers[id] !== undefined) {
            delete newMembers[id];
            removed.push(id);
            return;
          }
          // Try uid-based match
          const contact = contacts.find(c => c.id === id);
          if (contact?.uid && newMembers[contact.uid] !== undefined) {
            delete newMembers[contact.uid];
            removed.push(id);
          } else {
            // Try stripping urn:uuid: prefix matching
            for (const key of Object.keys(newMembers)) {
              const bareKey = key.startsWith('urn:uuid:') ? key.slice(9) : key;
              const bareUid = contact?.uid?.startsWith('urn:uuid:') ? contact.uid.slice(9) : contact?.uid;
              if (bareKey === id || bareKey === bareUid) {
                delete newMembers[key];
                removed.push(id);
                break;
              }
            }
          }
        });

        const updates: Partial<ContactCard> = { members: newMembers };
        if (client && get().supportsSync) {
          const originalId = group.originalId || groupId;
          const accountId = group.isShared ? group.accountId : undefined;
          await resolveAccountClient(client, group.localAccountId).updateContact(originalId, updates, accountId);
        }
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === groupId ? { ...c, members: newMembers } : c
          ),
        }));
        if (removed.length > 0) {
          void contactHooks.onContactGroupMemberChange.emit({ groupId, added: [], removed });
        }
      },

      deleteGroup: async (client, groupId) => {
        if (client && get().supportsSync) {
          const group = get().contacts.find(c => c.id === groupId);
          const originalId = group?.originalId || groupId;
          const accountId = group?.isShared ? group.accountId : undefined;
          await resolveAccountClient(client, group?.localAccountId).deleteContact(originalId, accountId);
        }
        set((state) => ({
          contacts: state.contacts.filter(c => c.id !== groupId),
          selectedContactId: state.selectedContactId === groupId ? null : state.selectedContactId,
        }));
        void contactHooks.onContactGroupChange.emit({ groupId, change: 'deleted' });
      },

      toggleContactSelection: (id) => set((state) => {
        const next = new Set(state.selectedContactIds);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return { selectedContactIds: next, lastSelectedContactId: id };
      }),

      selectRangeContacts: (targetId, sortedIds) => {
        const { lastSelectedContactId, selectedContactIds } = get();
        const anchorId = lastSelectedContactId || sortedIds[0];
        if (!anchorId) return;
        const anchorIndex = sortedIds.indexOf(anchorId);
        const targetIndex = sortedIds.indexOf(targetId);
        if (anchorIndex === -1 || targetIndex === -1) return;
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        const newSelection = new Set(selectedContactIds);
        for (let i = start; i <= end; i++) {
          newSelection.add(sortedIds[i]);
        }
        set({ selectedContactIds: newSelection });
      },

      selectAllContacts: (ids) => set({ selectedContactIds: new Set(ids) }),

      clearSelection: () => set({ selectedContactIds: new Set<string>(), lastSelectedContactId: null }),

      bulkDeleteContacts: async (client, ids) => {
        if (ids.length === 0) return true;
        if (!(await contactHooks.onBeforeContactDelete.intercept({ contactIds: [...ids] }))) return false;
        set({ error: null });
        const { supportsSync, contacts } = get();
        const deletedIds = new Set(ids);

        if (client && supportsSync) {
          for (const id of ids) {
            try {
              const contact = contacts.find(c => c.id === id);
              const originalId = contact?.originalId || id;
              const accountId = contact?.isShared ? contact.accountId : undefined;
              await resolveAccountClient(client, contact?.localAccountId).deleteContact(originalId, accountId);
            } catch (error) {
              console.error(`Failed to delete contact ${id}:`, error);
              deletedIds.delete(id);
            }
          }
          if (deletedIds.size < ids.length) {
            set({ error: `Failed to delete ${ids.length - deletedIds.size} contact(s)` });
          }
        }

        set((state) => {
          const cleaned = cleanGroupMembers(state.contacts, deletedIds);
          return {
            contacts: cleaned.filter(c => !deletedIds.has(c.id)),
            selectedContactId: deletedIds.has(state.selectedContactId || '') ? null : state.selectedContactId,
            selectedContactIds: new Set<string>(),
          };
        });
        if (deletedIds.size > 0) {
          void contactHooks.onAfterContactDelete.emit({ contactIds: ids.filter(id => deletedIds.has(id)) });
        }
        return true;
      },

      bulkAddToGroup: async (client, groupId, contactIds) => {
        await get().addMembersToGroup(client, groupId, contactIds);
        set({ selectedContactIds: new Set<string>() });
      },

      moveContactToAddressBook: async (client, contactIds, addressBook) => {
        set({ error: null });
        const { contacts } = get();
        const targetBookOriginalId = addressBook.originalId || addressBook.id;
        const targetAccountId = addressBook.accountId;
        // Each card and the book are written through the login they belong
        // to: card ids repeat across logins.
        const targetClient = resolveAccountClient(client, addressBook.localAccountId);
        const primaryAccountId = targetClient.getContactsAccountId();

        for (const id of contactIds) {
          const contact = contacts.find(c => c.id === id);
          if (!contact) continue;

          const originalId = contact.originalId || id;
          const sourceAccountId = contact.isShared ? contact.accountId : undefined;
          const ownerClient = resolveAccountClient(client, contact.localAccountId);

          // Same account: just update the addressBookIds
          if (ownerClient === targetClient
            && (sourceAccountId || primaryAccountId) === (targetAccountId || primaryAccountId)) {
            await ownerClient.updateContact(originalId, { addressBookIds: { [targetBookOriginalId]: true } }, sourceAccountId);
            // Keep the id in the same (possibly namespaced) form the sidebar
            // filters by; `addressBook.id` already is that form.
            set((state) => ({
              contacts: state.contacts.map(c =>
                c.id === id ? { ...c, addressBookIds: { [addressBook.id]: true } } : c
              ),
            }));
            void contactHooks.onContactMove.emit({ contactId: id, toAddressBookId: addressBook.id });
          } else {
            // Cross-account: create in target, delete from source
            const { originalId: _oid, accountId: _aid, accountName: _an, isShared: _is, id: _id, ...contactData } = contact;
            // A blobId names a photo in the source account and need not resolve
            // for the target one; send the bytes. If a download fails the entry
            // goes as it is: the create then either resolves it or fails, and
            // the source card is only deleted after a successful create.
            const media = await inlineContactMedia(contact.media, {
              client: ownerClient,
              accountId: contact.accountId,
              localAccountId: contact.localAccountId,
            }, 'keep');
            const newContact = await targetClient.createContact(
              { ...contactData, media, addressBookIds: { [targetBookOriginalId]: true } },
              targetAccountId
            );
            await ownerClient.deleteContact(originalId, sourceAccountId);

            // Update local state
            const isPrimary = !targetAccountId || targetAccountId === primaryAccountId;
            const localBookId = isPrimary ? targetBookOriginalId : `${targetAccountId}:${targetBookOriginalId}`;
            let moved: ContactCard = {
              ...newContact,
              id: isPrimary ? newContact.id : `${targetAccountId}:${newContact.id}`,
              originalId: newContact.id,
              accountId: targetAccountId,
              accountName: addressBook.accountName || targetAccountId,
              isShared: !isPrimary,
              addressBookIds: { [localBookId]: true },
            };
            if (addressBook.localAccountId) moved = prefixContactsWithLocalAccount([moved], addressBook.localAccountId)[0];
            set((state) => ({
              contacts: state.contacts.map(c => (c.id === id ? moved : c)),
            }));
            void contactHooks.onContactMove.emit({ contactId: id, toAddressBookId: addressBook.id });
          }
        }
      },

      createAddressBook: async (client, name) => {
        set({ error: null });
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Address book name is required');
        try {
          // New books always belong to the active account; the caller refreshes
          // the list afterwards (single- or multi-account aware) so the freshly
          // created book lands in state with its full server-set properties.
          return await client.createAddressBook(trimmed);
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to create address book';
          set({ error: msg });
          throw error;
        }
      },

      renameAddressBook: async (client, addressBook, newName) => {
        set({ error: null });
        const trimmed = newName.trim();
        if (!trimmed) return;
        try {
          const originalId = addressBook.originalId || stripLocalAccountPrefix(addressBook.id, addressBook.localAccountId);
          const accountId = addressBook.isShared ? addressBook.accountId : undefined;
          client = resolveAccountClient(client, addressBook.localAccountId);
          await client.updateAddressBook(originalId, { name: trimmed }, accountId);
          set((state) => ({
            addressBooks: state.addressBooks.map(b =>
              b.id === addressBook.id ? { ...b, name: trimmed } : b
            ),
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to rename address book';
          set({ error: msg });
          throw error;
        }
      },

      setDefaultAddressBook: async (client, addressBook) => {
        set({ error: null });
        try {
          const originalId = addressBook.originalId || stripLocalAccountPrefix(addressBook.id, addressBook.localAccountId);
          const accountId = addressBook.isShared ? addressBook.accountId : undefined;
          client = resolveAccountClient(client, addressBook.localAccountId);
          await client.setDefaultAddressBook(originalId, accountId);
          set((state) => ({
            addressBooks: state.addressBooks.map(b => {
              if (b.id === addressBook.id) return { ...b, isDefault: true };
              // Only one default per account - clear the flag on siblings in the
              // same local account / shared-account scope.
              if (
                b.isDefault
                && (b.localAccountId ?? null) === (addressBook.localAccountId ?? null)
                && (b.accountId ?? null) === (addressBook.accountId ?? null)
              ) {
                return { ...b, isDefault: false };
              }
              return b;
            }),
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to set default address book';
          set({ error: msg });
          throw error;
        }
      },

      removeAddressBook: async (client, addressBook) => {
        set({ error: null });
        try {
          const originalId = addressBook.originalId || stripLocalAccountPrefix(addressBook.id, addressBook.localAccountId);
          const accountId = addressBook.isShared ? addressBook.accountId : undefined;
          client = resolveAccountClient(client, addressBook.localAccountId);
          // The confirm dialog tells the user the contacts go with the book.
          await client.deleteAddressBook(originalId, accountId, { removeContents: true });
          set((state) => ({
            addressBooks: state.addressBooks.filter(b => b.id !== addressBook.id),
            contacts: state.contacts.filter(c => !c.addressBookIds?.[addressBook.id]),
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to delete address book';
          set({ error: msg });
          throw error;
        }
      },

      shareAddressBook: async (client, addressBook, principalId, rights) => {
        set({ error: null });
        try {
          const originalId = addressBook.originalId || stripLocalAccountPrefix(addressBook.id, addressBook.localAccountId);
          const accountId = addressBook.isShared ? addressBook.accountId : undefined;
          client = resolveAccountClient(client, addressBook.localAccountId);
          await client.setAddressBookShare(originalId, principalId, rights, accountId);
          set((state) => ({
            addressBooks: state.addressBooks.map(b => {
              if (b.id !== addressBook.id) return b;
              const next = { ...(b.shareWith ?? {}) };
              if (rights === null) delete next[principalId];
              else next[principalId] = rights;
              return { ...b, shareWith: next };
            }),
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to share address book';
          set({ error: msg });
          throw error;
        }
      },

      renameKeyword: async (client, oldKeyword, newKeyword) => {
        set({ error: null });
        const oldKw = oldKeyword.trim();
        const newKw = newKeyword.trim();
        if (!oldKw || !newKw || oldKw === newKw) return;

        const { contacts, supportsSync } = get();
        const affected = contacts.filter(c => c.keywords?.[oldKw]);

        for (const contact of affected) {
          const { [oldKw]: _old, ...rest } = contact.keywords || {};
          const updatedKeywords: Record<string, boolean> = { ...rest, [newKw]: true };
          try {
            if (supportsSync && client) {
              const originalId = contact.originalId || contact.id;
              const accountId = contact.isShared ? contact.accountId : undefined;
              await client.updateContact(originalId, { keywords: updatedKeywords }, accountId);
            }
            set((state) => ({
              contacts: state.contacts.map(c =>
                c.id === contact.id ? { ...c, keywords: updatedKeywords } : c
              ),
            }));
          } catch (error) {
            const msg = error instanceof Error ? error.message : 'Failed to rename category';
            set({ error: msg });
            throw error;
          }
        }
      },

      loadRecentRecipients: async (client, sentMailboxId) => {
        if (sentMailboxId) set({ sentMailboxId });
        if (get().recentRecipientsLoaded || !sentMailboxId) return;
        // One read of the Sent folder at a time: callers retry whenever the
        // folder list changes, which it does several times while signing in.
        if (recentRecipientsLoading) return recentRecipientsLoading;
        recentRecipientsLoading = (async () => {
          try {
            // Read the Sent folder and collect the people we've written to, so
            // compose autocomplete can suggest them (OWA-style). getEmails sorts
            // receivedAt desc, so keeping the first occurrence per address yields
            // the most recent one plus its display name.
            const { emails } = await client.getEmails(sentMailboxId, undefined, 300, 0);
            const byEmail = new Map<string, { name: string; email: string }>();
            for (const email of emails) {
              for (const r of [...(email.to || []), ...(email.cc || [])]) {
                if (!r.email) continue;
                const key = r.email.toLowerCase().trim();
                if (!key || byEmail.has(key)) continue;
                byEmail.set(key, { name: (r.name || '').trim(), email: r.email });
              }
            }
            set({ recentRecipients: Array.from(byEmail.values()), recentRecipientsLoaded: true });
            debug.log('contacts', 'Loaded', byEmail.size, 'recent recipients from Sent');
          } catch (error) {
            debug.error('Failed to load recent recipients:', error);
            set({ recentRecipientsLoaded: true });
          }
        })().finally(() => { recentRecipientsLoading = null; });
        return recentRecipientsLoading;
      },

      searchRecipients: async (client, query) => {
        const { sentMailboxId } = get();
        const q = query.trim();
        if (!sentMailboxId || q.length < 1) return [];
        try {
          return await client.searchSentRecipients(q, sentMailboxId);
        } catch (error) {
          debug.error('Recipient server search failed:', error);
          return [];
        }
      },

      loadTrustedSendersBook: async (client) => {
        // Share the in-flight load so parallel callers (mail view, settings,
        // the modal, addToTrustedSendersBook) can never create the book twice.
        if (trustedSendersLoadPromise) return trustedSendersLoadPromise;
        set({ trustedSendersLoading: true });

        trustedSendersLoadPromise = (async () => {
          try {
            debug.log('contacts', 'Loading trusted senders address book');
            // Must throw rather than yield [] on failure: treating a failed
            // fetch as "no book yet" minted a duplicate on every hiccup (#730).
            const books = await client.getAddressBooks({ throwOnError: true });
            // Sort so every client picks the same book when duplicates exist.
            const matches = books
              .filter(b => b.name === TRUSTED_SENDERS_BOOK_NAME)
              .sort((a, b) => a.id.localeCompare(b.id));

            let book = matches[0];
            if (!book) {
              debug.log('contacts', 'Creating new trusted senders address book');
              book = await client.createAddressBook(TRUSTED_SENDERS_BOOK_NAME);
            }
            const bookId = book.id;
            debug.log('contacts', 'Trusted senders book id:', bookId);
            const contacts = await client.getContacts(bookId, { throwOnError: true });
            debug.log('contacts', 'Loaded', contacts.length, 'trusted sender contacts');
            let emails = collectContactEmails(contacts);

            if (matches.length > 1) {
              debug.log('contacts', 'Found', matches.length, 'trusted senders books, merging duplicates');
              emails = await consolidateTrustedSenderBooks(client, bookId, matches.slice(1), emails);
            }

            set({ trustedSendersBookId: bookId, trustedSenderEmails: emails, trustedSendersLoaded: true, trustedSendersLoading: false });
          } catch (error) {
            debug.error('Failed to load trusted senders address book:', error);
            set({ trustedSendersLoaded: true, trustedSendersLoading: false });
          } finally {
            trustedSendersLoadPromise = null;
          }
        })();

        return trustedSendersLoadPromise;
      },

      addToTrustedSendersBook: async (client, email) => {
        // Parse "Name <email>" format to extract display name and email
        const trimmed = email.trim();
        const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
        const displayName = angleMatch ? angleMatch[1].trim() : undefined;
        const emailAddress = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
        const { trustedSenderEmails } = get();
        if (trustedSenderEmails.includes(emailAddress)) return;

        let bookId = get().trustedSendersBookId;
        if (!bookId) {
          await get().loadTrustedSendersBook(client);
          bookId = get().trustedSendersBookId;
        }
        if (!bookId) throw new Error('Could not find or create trusted senders address book');

        debug.log('contacts', 'Adding trusted sender:', emailAddress, 'to book:', bookId);
        await client.createContact({
          addressBookIds: { [bookId]: true },
          ...(displayName ? { name: { full: displayName } } : {}),
          emails: { email: { address: emailAddress } },
        });
        set((state) => ({ trustedSenderEmails: [...state.trustedSenderEmails, emailAddress] }));
        debug.log('contacts', 'Trusted sender added successfully');
        void settingsHooks.onTrustedSenderChange.emit({ email: emailAddress, trusted: true });
      },

      removeFromTrustedSendersBook: async (client, email) => {
        // Parse "Name <email>" format to extract just the email address
        const trimmed = email.trim();
        const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
        const normalizedEmail = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
        const { trustedSendersBookId } = get();
        if (!trustedSendersBookId) return;

        debug.log('contacts', 'Removing trusted sender:', normalizedEmail);
        const contacts = await client.getContacts(trustedSendersBookId);
        const match = contacts.find(c =>
          c.emails && Object.values(c.emails).some(e => e.address.toLowerCase().trim() === normalizedEmail)
        );
        if (match) {
          await client.deleteContact(match.id);
          debug.log('contacts', 'Trusted sender removed');
        }
        const wasTrusted = get().trustedSenderEmails.includes(normalizedEmail);
        set((state) => ({ trustedSenderEmails: state.trustedSenderEmails.filter(e => e !== normalizedEmail) }));
        if (wasTrusted) void settingsHooks.onTrustedSenderChange.emit({ email: normalizedEmail, trusted: false });
      },

      isTrustedAddressBookSender: (email) => {
        // Parse "Name <email>" format to extract just the email address
        const trimmed = email.trim();
        const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
        const normalizedEmail = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
        return get().trustedSenderEmails.includes(normalizedEmail);
      },

      importContacts: async (client, contacts) => {
        const { supportsSync } = get();
        let imported = 0;
        // The book the cards landed in, as the server filed the first one.
        let addressBookId = '';

        for (const contact of contacts) {
          try {
            let added: ContactCard;
            if (client && supportsSync) {
              const { id: _id, ...data } = contact;
              added = await client.createContact(data);
            } else {
              added = {
                ...contact,
                id: `local-${generateUUID()}`,
              };
            }
            set((state) => ({ contacts: [...state.contacts, added] }));
            if (!addressBookId) addressBookId = Object.keys(added.addressBookIds || {}).find(k => added.addressBookIds[k]) || '';
            imported++;
          } catch (error) {
            console.error('Failed to import contact:', error);
          }
        }

        if (imported > 0) void contactHooks.onContactsImport.emit({ addressBookId, imported });
        return imported;
      },
    });
    },
    {
      name: 'contact-storage',
      partialize: (state) => ({
        contacts: state.supportsSync ? [] : state.contacts,
        supportsSync: state.supportsSync,
      }),
    }
  )
);

// Tell plugins when the set of checked contacts changes, whichever action
// changed it (toggle, range, select all, clear, bulk actions). Re-setting the
// same ids is not a change.
useContactStore.subscribe((state, prev) => {
  if (state.selectedContactIds === prev.selectedContactIds) return;
  if (contactHooks.onContactSelectionChange.size === 0) return;
  const next = state.selectedContactIds ?? new Set<string>();
  if (sameIdSet(next, prev.selectedContactIds ?? new Set<string>())) return;
  void contactHooks.onContactSelectionChange.emit({ contactIds: [...next] });
});

export type { ContactName };
