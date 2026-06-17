import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ContactCard, AddressBook, AddressBookRights, ContactName } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { generateUUID } from '@/lib/utils';
import { debug } from '@/lib/debug';
import { getClientByLocalAccountId } from './client-registry';

/** One connected JMAP account for contact multi-account aggregation. */
export interface ContactAccountClient {
  localAccountId: string;
  client: IJMAPClient;
}

/**
 * Prefix used to namespace contact/address-book IDs that belong to a
 * non-active JMAP account when the Pro shell aggregates across accounts.
 * The active account's IDs are left untouched so existing single-account
 * code paths keep working unchanged.
 */
const CROSS_ACCOUNT_ID_DELIMITER = '::';

function buildCrossAccountIdPrefix(localAccountId: string): string {
  return `${localAccountId}${CROSS_ACCOUNT_ID_DELIMITER}`;
}

function prefixAddressBooksWithLocalAccount(
  books: AddressBook[],
  localAccountId: string,
  isActiveAccount: boolean,
): AddressBook[] {
  if (isActiveAccount) {
    return books.map((b) => ({ ...b, localAccountId }));
  }
  const prefix = buildCrossAccountIdPrefix(localAccountId);
  return books.map((b) => ({
    ...b,
    id: `${prefix}${b.id}`,
    localAccountId,
  }));
}

function prefixContactsWithLocalAccount(
  contacts: ContactCard[],
  localAccountId: string,
  isActiveAccount: boolean,
): ContactCard[] {
  if (isActiveAccount) {
    return contacts.map((c) => ({ ...c, localAccountId }));
  }
  const prefix = buildCrossAccountIdPrefix(localAccountId);
  return contacts.map((c) => ({
    ...c,
    id: `${prefix}${c.id}`,
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

export function getContactPhotoUri(contact: ContactCard): string | undefined {
  if (!contact.media) return undefined;
  for (const media of Object.values(contact.media)) {
    if (media.kind === 'photo' && media.uri) {
      return normalizeContactPhotoUri(media.uri, media.mediaType);
    }
  }
  return undefined;
}

export const TRUSTED_SENDERS_BOOK_NAME = 'Trusted Senders';

interface ContactStore {
  contacts: ContactCard[];
  addressBooks: AddressBook[];
  selectedContactId: string | null;
  searchQuery: string;
  isLoading: boolean;
  error: string | null;
  supportsSync: boolean;

  // Trusted senders address book cache (runtime only, not persisted)
  trustedSenderEmails: string[];
  trustedSendersBookId: string | null;
  trustedSendersLoaded: boolean;
  trustedSendersLoading: boolean;

  selectedContactIds: Set<string>;
  lastSelectedContactId: string | null;
  activeTab: 'all' | 'groups';

  // Directory (RFC 9670 principals) — other users/groups on the server, used to
  // augment recipient autocomplete. Runtime only, not persisted.
  directoryPrincipals: Array<{ name: string; email: string; description?: string }>;
  directoryLoaded: boolean;

  fetchContacts: (client: IJMAPClient) => Promise<void>;
  fetchDirectory: (client: IJMAPClient) => Promise<void>;
  fetchAddressBooks: (client: IJMAPClient) => Promise<void>;
  fetchAllAccountsContacts: (accounts: ContactAccountClient[], activeLocalAccountId: string) => Promise<void>;
  fetchAllAccountsAddressBooks: (accounts: ContactAccountClient[], activeLocalAccountId: string) => Promise<void>;
  createContact: (client: IJMAPClient, contact: Partial<ContactCard>) => Promise<void>;
  updateContact: (client: IJMAPClient, id: string, updates: Partial<ContactCard>) => Promise<void>;
  deleteContact: (client: IJMAPClient, id: string) => Promise<void>;

  addLocalContact: (contact: ContactCard) => void;
  updateLocalContact: (id: string, updates: Partial<ContactCard>) => void;
  deleteLocalContact: (id: string) => void;

  setSelectedContact: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setSupportsSync: (supports: boolean) => void;
  setActiveTab: (tab: 'all' | 'groups') => void;
  clearContacts: () => void;

  getAutocomplete: (query: string) => Array<{ name: string; email: string }>;

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
  bulkDeleteContacts: (client: IJMAPClient | null, ids: string[]) => Promise<void>;
  bulkAddToGroup: (client: IJMAPClient | null, groupId: string, contactIds: string[]) => Promise<void>;
  moveContactToAddressBook: (client: IJMAPClient, contactIds: string[], addressBook: AddressBook) => Promise<void>;
  renameAddressBook: (client: IJMAPClient, addressBook: AddressBook, newName: string) => Promise<void>;
  removeAddressBook: (client: IJMAPClient, addressBook: AddressBook) => Promise<void>;
  shareAddressBook: (client: IJMAPClient, addressBook: AddressBook, principalId: string, rights: AddressBookRights | null) => Promise<void>;
  renameKeyword: (client: IJMAPClient | null, oldKeyword: string, newKeyword: string) => Promise<void>;

  importContacts: (client: IJMAPClient | null, contacts: ContactCard[]) => Promise<number>;

  // Trusted senders address book
  loadTrustedSendersBook: (client: IJMAPClient) => Promise<void>;
  addToTrustedSendersBook: (client: IJMAPClient, email: string) => Promise<void>;
  removeFromTrustedSendersBook: (client: IJMAPClient, email: string) => Promise<void>;
  isTrustedAddressBookSender: (email: string) => boolean;
}

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
      trustedSenderEmails: [],
      trustedSendersBookId: null,
      trustedSendersLoaded: false,
      trustedSendersLoading: false,
      selectedContactIds: new Set<string>(),
      lastSelectedContactId: null,
      activeTab: 'all' as const,
      directoryPrincipals: [],
      directoryLoaded: false,

      fetchContacts: async (client) => {
        set({ isLoading: true, error: null });
        try {
          const contacts = await client.getAllContacts();
          set({ contacts, isLoading: false });
        } catch (error) {
          console.error('Failed to fetch contacts:', error);
          set({ error: 'Failed to fetch contacts', isLoading: false });
        }
      },

      fetchDirectory: async (client) => {
        if (!client.supportsPrincipals()) return;
        try {
          const principals = await client.getPrincipals();
          const entries: Array<{ name: string; email: string; description?: string }> = [];
          for (const p of principals) {
            // Stalwart reports a principal's account name in `email`; only those
            // with an address are usable as recipients.
            const email = p.email?.trim();
            if (!email) continue;
            entries.push({
              name: p.description || p.name || email,
              email,
              description: p.description ?? undefined,
            });
          }
          set({ directoryPrincipals: entries, directoryLoaded: true });
        } catch (error) {
          debug.error('Failed to fetch directory principals:', error);
        }
      },

      fetchAddressBooks: async (client) => {
        try {
          const addressBooks = await client.getAllAddressBooks();
          set({ addressBooks });
        } catch (error) {
          console.error('Failed to fetch address books:', error);
          set({ error: 'Failed to fetch address books' });
        }
      },

      fetchAllAccountsContacts: async (accounts, activeLocalAccountId) => {
        set({ isLoading: true, error: null });
        try {
          const results = await Promise.all(
            accounts.map(async ({ client, localAccountId }) => {
              try {
                const list = await client.getAllContacts();
                return prefixContactsWithLocalAccount(
                  list,
                  localAccountId,
                  localAccountId === activeLocalAccountId,
                );
              } catch (error) {
                debug.error(`Failed to fetch contacts for account ${localAccountId}:`, error);
                return [] as ContactCard[];
              }
            }),
          );
          set({ contacts: results.flat(), isLoading: false });
        } catch (error) {
          console.error('Failed to fetch all-account contacts:', error);
          set({ error: 'Failed to fetch contacts', isLoading: false });
        }
      },

      fetchAllAccountsAddressBooks: async (accounts, activeLocalAccountId) => {
        try {
          const results = await Promise.all(
            accounts.map(async ({ client, localAccountId }) => {
              try {
                const list = await client.getAllAddressBooks();
                return prefixAddressBooksWithLocalAccount(
                  list,
                  localAccountId,
                  localAccountId === activeLocalAccountId,
                );
              } catch (error) {
                debug.error(`Failed to fetch address books for account ${localAccountId}:`, error);
                return [] as AddressBook[];
              }
            }),
          );
          set({ addressBooks: results.flat() });
        } catch (error) {
          console.error('Failed to fetch all-account address books:', error);
          set({ error: 'Failed to fetch address books' });
        }
      },

      createContact: async (client, contact) => {
        set({ isLoading: true, error: null });
        try {
          // Determine target account from the selected address book. Also
          // pin the local account so we route through the right server's
          // client in multi-account Pro mode.
          let accountId = contact.isShared ? contact.accountId : undefined;
          let cleanedContact = contact;
          let localAccountId = contact.localAccountId;

          // De-namespace addressBookIds if they reference a shared address book
          if (contact.addressBookIds) {
            const books = get().addressBooks;
            const deNamespaced: Record<string, boolean> = {};
            let sharedAccountId: string | undefined;
            for (const [bookId, value] of Object.entries(contact.addressBookIds)) {
              const book = books.find(b => b.id === bookId);
              if (book?.localAccountId) localAccountId = book.localAccountId;
              if (book?.isShared && book.originalId) {
                deNamespaced[book.originalId] = value;
                sharedAccountId = book.accountId;
              } else if (book?.originalId) {
                deNamespaced[book.originalId] = value;
              } else {
                deNamespaced[bookId] = value;
              }
            }
            if (sharedAccountId) {
              accountId = sharedAccountId;
              cleanedContact = { ...contact, addressBookIds: deNamespaced, isShared: true, accountId: sharedAccountId };
            } else {
              cleanedContact = { ...contact, addressBookIds: deNamespaced };
            }
          }

          client = resolveAccountClient(client, localAccountId);
          const created = await client.createContact(cleanedContact, accountId);
          // Preserve shared account metadata
          if (contact.isShared && contact.accountId) {
            created.accountId = contact.accountId;
            created.accountName = contact.accountName;
            created.isShared = true;
            created.id = `${contact.accountId}:${created.id}`;
            created.originalId = created.id.includes(':') ? created.id.split(':').slice(1).join(':') : created.id;
          }
          set((state) => ({
            contacts: [...state.contacts, created],
            isLoading: false,
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to create contact';
          set({ error: msg, isLoading: false });
          throw error;
        }
      },

      updateContact: async (client, id, updates) => {
        set({ error: null });
        try {
          const contact = get().contacts.find(c => c.id === id);
          const originalId = contact?.originalId || stripLocalAccountPrefix(id, contact?.localAccountId);
          const accountId = contact?.isShared ? contact.accountId : undefined;
          client = resolveAccountClient(client, contact?.localAccountId);

          // De-namespace addressBookIds for shared contacts before sending to JMAP server
          let cleanedUpdates = updates;
          if (contact?.isShared && contact?.accountId && updates.addressBookIds) {
            const prefix = `${contact.accountId}:`;
            const deNamespaced = Object.fromEntries(
              Object.entries(updates.addressBookIds).map(([k, v]) => [
                k.startsWith(prefix) ? k.slice(prefix.length) : k,
                v
              ])
            );
            cleanedUpdates = { ...updates, addressBookIds: deNamespaced };
          }

          await client.updateContact(originalId, cleanedUpdates, accountId);
          set((state) => ({
            contacts: state.contacts.map(c =>
              c.id === id ? { ...c, ...updates } : c
            ),
          }));
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to update contact';
          set({ error: msg });
          throw error;
        }
      },

      deleteContact: async (client, id) => {
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
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to delete contact';
          set({ error: msg });
          throw error;
        }
      },

      addLocalContact: (contact) => set((state) => ({
        contacts: [...state.contacts, contact],
      })),

      updateLocalContact: (id, updates) => set((state) => ({
        contacts: state.contacts.map(c =>
          c.id === id ? { ...c, ...updates } : c
        ),
      })),

      deleteLocalContact: (id) => set((state) => {
        const removedIds = new Set([id]);
        const cleaned = cleanGroupMembers(state.contacts, removedIds);
        return {
          contacts: cleaned.filter(c => c.id !== id),
          selectedContactId: state.selectedContactId === id ? null : state.selectedContactId,
        };
      }),

      setSelectedContact: (id) => set({ selectedContactId: id }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setSupportsSync: (supports) => set({ supportsSync: supports }),
      setActiveTab: (tab) => set({ activeTab: tab }),

      clearContacts: () => set({
        contacts: [],
        addressBooks: [],
        selectedContactId: null,
        searchQuery: '',
        error: null,
        selectedContactIds: new Set<string>(),
        activeTab: 'all',
        directoryPrincipals: [],
        directoryLoaded: false,
      }),

      getAutocomplete: (query) => {
        const { contacts } = get();
        if (!query || query.length < 1) return [];

        const lower = query.toLowerCase();
        const results: Array<{ name: string; email: string }> = [];

        for (const contact of contacts) {
          if (contact.kind === 'group') {
            const groupName = getContactDisplayName(contact);
            if (groupName.toLowerCase().includes(lower)) {
              const members = get().getGroupMembers(contact.id);
              for (const member of members) {
                const memberName = getContactDisplayName(member);
                const memberEmails = member.emails ? Object.values(member.emails) : [];
                for (const emailEntry of memberEmails) {
                  if (!emailEntry.address) continue;
                  results.push({ name: memberName, email: emailEntry.address });
                }
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

        return results;
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
          name: { components: [{ kind: 'given', value: name }], isOrdered: true },
          members,
        };

        if (client && get().supportsSync) {
          const created = await client.createContact(groupData);
          set((state) => ({ contacts: [...state.contacts, created] }));
        } else {
          const localGroup: ContactCard = {
            id: `local-${generateUUID()}`,
            addressBookIds: {},
            ...groupData,
          } as ContactCard;
          set((state) => ({ contacts: [...state.contacts, localGroup] }));
        }
      },

      updateGroup: async (client, groupId, name) => {
        const updates: Partial<ContactCard> = {
          name: { components: [{ kind: 'given', value: name }], isOrdered: true },
        };
        if (client && get().supportsSync) {
          const group = get().contacts.find(c => c.id === groupId);
          const originalId = group?.originalId || groupId;
          const accountId = group?.isShared ? group.accountId : undefined;
          await client.updateContact(originalId, updates, accountId);
        }
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === groupId ? { ...c, ...updates } : c
          ),
        }));
      },

      addMembersToGroup: async (client, groupId, memberIds) => {
        const { contacts } = get();
        const group = contacts.find(c => c.id === groupId);
        if (!group) return;

        const newMembers = { ...group.members };
        memberIds.forEach(id => {
          const contact = contacts.find(c => c.id === id);
          const key = contact?.uid || contact?.originalId || id;
          newMembers[key] = true;
        });

        const updates: Partial<ContactCard> = { members: newMembers };
        if (client && get().supportsSync) {
          const originalId = group.originalId || groupId;
          const accountId = group.isShared ? group.accountId : undefined;
          await client.updateContact(originalId, updates, accountId);
        }
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === groupId ? { ...c, members: newMembers } : c
          ),
        }));
      },

      removeMembersFromGroup: async (client, groupId, memberIds) => {
        const { contacts } = get();
        const group = contacts.find(c => c.id === groupId);
        if (!group?.members) return;

        const newMembers = { ...group.members };
        memberIds.forEach(id => {
          // Try direct id match first
          if (newMembers[id] !== undefined) {
            delete newMembers[id];
            return;
          }
          // Try uid-based match
          const contact = contacts.find(c => c.id === id);
          if (contact?.uid && newMembers[contact.uid] !== undefined) {
            delete newMembers[contact.uid];
          } else {
            // Try stripping urn:uuid: prefix matching
            for (const key of Object.keys(newMembers)) {
              const bareKey = key.startsWith('urn:uuid:') ? key.slice(9) : key;
              const bareUid = contact?.uid?.startsWith('urn:uuid:') ? contact.uid.slice(9) : contact?.uid;
              if (bareKey === id || bareKey === bareUid) {
                delete newMembers[key];
                break;
              }
            }
          }
        });

        const updates: Partial<ContactCard> = { members: newMembers };
        if (client && get().supportsSync) {
          const originalId = group.originalId || groupId;
          const accountId = group.isShared ? group.accountId : undefined;
          await client.updateContact(originalId, updates, accountId);
        }
        set((state) => ({
          contacts: state.contacts.map(c =>
            c.id === groupId ? { ...c, members: newMembers } : c
          ),
        }));
      },

      deleteGroup: async (client, groupId) => {
        if (client && get().supportsSync) {
          const group = get().contacts.find(c => c.id === groupId);
          const originalId = group?.originalId || groupId;
          const accountId = group?.isShared ? group.accountId : undefined;
          await client.deleteContact(originalId, accountId);
        }
        set((state) => ({
          contacts: state.contacts.filter(c => c.id !== groupId),
          selectedContactId: state.selectedContactId === groupId ? null : state.selectedContactId,
        }));
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
        set({ error: null });
        const { supportsSync, contacts } = get();
        const deletedIds = new Set(ids);

        if (client && supportsSync) {
          for (const id of ids) {
            try {
              const contact = contacts.find(c => c.id === id);
              const originalId = contact?.originalId || id;
              const accountId = contact?.isShared ? contact.accountId : undefined;
              await client.deleteContact(originalId, accountId);
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
        const primaryAccountId = client.getContactsAccountId();

        for (const id of contactIds) {
          const contact = contacts.find(c => c.id === id);
          if (!contact) continue;

          const originalId = contact.originalId || id;
          const sourceAccountId = contact.isShared ? contact.accountId : undefined;

          // Same account: just update the addressBookIds
          if ((sourceAccountId || primaryAccountId) === (targetAccountId || primaryAccountId)) {
            await client.updateContact(originalId, { addressBookIds: { [targetBookOriginalId]: true } }, sourceAccountId);
            const isTargetPrimary = !targetAccountId || targetAccountId === primaryAccountId;
            const localBookId = isTargetPrimary ? targetBookOriginalId : `${targetAccountId}:${targetBookOriginalId}`;
            set((state) => ({
              contacts: state.contacts.map(c =>
                c.id === id ? { ...c, addressBookIds: { [localBookId]: true } } : c
              ),
            }));
          } else {
            // Cross-account: create in target, delete from source
            const { originalId: _oid, accountId: _aid, accountName: _an, isShared: _is, id: _id, ...contactData } = contact;
            const newContact = await client.createContact(
              { ...contactData, addressBookIds: { [targetBookOriginalId]: true } },
              targetAccountId
            );
            await client.deleteContact(originalId, sourceAccountId);

            // Update local state
            const isPrimary = !targetAccountId || targetAccountId === primaryAccountId;
            const localBookId = isPrimary ? targetBookOriginalId : `${targetAccountId}:${targetBookOriginalId}`;
            set((state) => ({
              contacts: state.contacts.map(c => {
                if (c.id !== id) return c;
                return {
                  ...newContact,
                  id: isPrimary ? newContact.id : `${targetAccountId}:${newContact.id}`,
                  originalId: newContact.id,
                  accountId: targetAccountId,
                  accountName: addressBook.accountName || targetAccountId,
                  isShared: !isPrimary,
                  addressBookIds: { [localBookId]: true },
                };
              }),
            }));
          }
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

      removeAddressBook: async (client, addressBook) => {
        set({ error: null });
        try {
          const originalId = addressBook.originalId || stripLocalAccountPrefix(addressBook.id, addressBook.localAccountId);
          const accountId = addressBook.isShared ? addressBook.accountId : undefined;
          client = resolveAccountClient(client, addressBook.localAccountId);
          await client.deleteAddressBook(originalId, accountId);
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

      loadTrustedSendersBook: async (client) => {
        if (get().trustedSendersLoading) return;
        set({ trustedSendersLoading: true });
        try {
          debug.log('contacts', 'Loading trusted senders address book');
          const books = await client.getAddressBooks();
          let book = books.find(b => b.name === TRUSTED_SENDERS_BOOK_NAME);
          if (!book) {
            debug.log('contacts', 'Creating new trusted senders address book');
            book = await client.createAddressBook(TRUSTED_SENDERS_BOOK_NAME);
          }
          const bookId = book.id;
          debug.log('contacts', 'Trusted senders book id:', bookId);
          const contacts = await client.getContacts(bookId);
          debug.log('contacts', 'Loaded', contacts.length, 'trusted sender contacts');
          const emails = contacts.flatMap(c =>
            c.emails ? Object.values(c.emails).map(e => e.address.toLowerCase().trim()) : []
          ).filter(Boolean);
          set({ trustedSendersBookId: bookId, trustedSenderEmails: emails, trustedSendersLoaded: true, trustedSendersLoading: false });
        } catch (error) {
          debug.error('Failed to load trusted senders address book:', error);
          set({ trustedSendersLoaded: true, trustedSendersLoading: false });
        }
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
        set((state) => ({ trustedSenderEmails: state.trustedSenderEmails.filter(e => e !== normalizedEmail) }));
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

        for (const contact of contacts) {
          try {
            if (client && supportsSync) {
              const { id: _id, ...data } = contact;
              const created = await client.createContact(data);
              set((state) => ({ contacts: [...state.contacts, created] }));
            } else {
              const localContact: ContactCard = {
                ...contact,
                id: `local-${generateUUID()}`,
              };
              set((state) => ({ contacts: [...state.contacts, localContact] }));
            }
            imported++;
          } catch (error) {
            console.error('Failed to import contact:', error);
          }
        }

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

export type { ContactName };
