import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useContactStore,
  findContactPhotoEntry,
  getContactPhotoIndex,
  getContactPhotoRef,
  getContactPhotoUri,
  hasContactPhoto,
  normalizeContactPhotoUri,
  TRUSTED_SENDERS_BOOK_NAME,
} from '../contact-store';
import type { ContactCard, ContactMedia } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { clearContactPhotoCache } from '@/lib/contact-photo-cache';
import { PrincipalsRequestError } from '@/lib/jmap/principals-error';
import { setClientLookup } from '../client-registry';

vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-0000-0000-000000000000' });

const makeContact = (overrides: Partial<ContactCard> = {}): ContactCard => ({
  id: 'contact-1',
  addressBookIds: { 'ab-1': true },
  name: { components: [{ kind: 'given', value: 'John' }, { kind: 'surname', value: 'Doe' }], isOrdered: true },
  emails: { e0: { address: 'john@example.com' } },
  ...overrides,
});

const makeGroup = (overrides: Partial<ContactCard> = {}): ContactCard => ({
  id: 'group-1',
  addressBookIds: {},
  kind: 'group',
  name: { components: [{ kind: 'given', value: 'Team' }], isOrdered: true },
  members: {},
  ...overrides,
});

const defaultState = {
  contacts: [],
  addressBooks: [],
  selectedContactId: null,
  searchQuery: '',
  isLoading: false,
  error: null,
  supportsSync: false,
  selectedContactIds: new Set<string>(),
  activeTab: 'all' as const,
  directoryPrincipals: [],
  directoryLoaded: false,
  directoryStatus: 'idle' as const,
};

describe('contact-store', () => {
  beforeEach(() => {
    useContactStore.setState(defaultState);
  });

  describe('addLocalContact', () => {
    it('should append contact to array', async () => {
      await useContactStore.getState().addLocalContact(makeContact());
      expect(useContactStore.getState().contacts).toHaveLength(1);
      expect(useContactStore.getState().contacts[0].id).toBe('contact-1');
    });

    it('should preserve existing contacts', async () => {
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c1' }));
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c2' }));
      expect(useContactStore.getState().contacts).toHaveLength(2);
    });
  });

  describe('updateLocalContact', () => {
    it('should update matching contact', async () => {
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c1' }));
      await useContactStore.getState().updateLocalContact('c1', {
        emails: { e0: { address: 'updated@example.com' } },
      });
      expect(useContactStore.getState().contacts[0].emails!.e0.address).toBe('updated@example.com');
    });

    it('should not modify other contacts', async () => {
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c1' }));
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c2', emails: { e0: { address: 'c2@test.com' } } }));
      await useContactStore.getState().updateLocalContact('c1', { emails: { e0: { address: 'new@test.com' } } });
      expect(useContactStore.getState().contacts[1].emails!.e0.address).toBe('c2@test.com');
    });

    it('should no-op for non-existent id', async () => {
      await useContactStore.getState().addLocalContact(makeContact());
      await useContactStore.getState().updateLocalContact('nonexistent', { kind: 'org' });
      expect(useContactStore.getState().contacts).toHaveLength(1);
      expect(useContactStore.getState().contacts[0].kind).toBeUndefined();
    });
  });

  describe('deleteLocalContact', () => {
    it('should remove contact by id', async () => {
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c1' }));
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c2' }));
      await useContactStore.getState().deleteLocalContact('c1');
      expect(useContactStore.getState().contacts).toHaveLength(1);
      expect(useContactStore.getState().contacts[0].id).toBe('c2');
    });

    it('should clear selectedContactId when deleting selected', async () => {
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c1' }));
      useContactStore.getState().setSelectedContact('c1');
      await useContactStore.getState().deleteLocalContact('c1');
      expect(useContactStore.getState().selectedContactId).toBeNull();
    });

    it('should preserve selectedContactId when deleting other', async () => {
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c1' }));
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c2' }));
      useContactStore.getState().setSelectedContact('c1');
      await useContactStore.getState().deleteLocalContact('c2');
      expect(useContactStore.getState().selectedContactId).toBe('c1');
    });
  });

  describe('setSelectedContact', () => {
    it('should set selectedContactId', () => {
      useContactStore.getState().setSelectedContact('c1');
      expect(useContactStore.getState().selectedContactId).toBe('c1');
    });

    it('should allow null to deselect', () => {
      useContactStore.getState().setSelectedContact('c1');
      useContactStore.getState().setSelectedContact(null);
      expect(useContactStore.getState().selectedContactId).toBeNull();
    });
  });

  describe('setSearchQuery', () => {
    it('should set search query', () => {
      useContactStore.getState().setSearchQuery('john');
      expect(useContactStore.getState().searchQuery).toBe('john');
    });
  });

  describe('setSupportsSync', () => {
    it('should set supportsSync flag', () => {
      useContactStore.getState().setSupportsSync(true);
      expect(useContactStore.getState().supportsSync).toBe(true);
    });
  });

  describe('setActiveTab', () => {
    it('should set active tab', () => {
      useContactStore.getState().setActiveTab('groups');
      expect(useContactStore.getState().activeTab).toBe('groups');
    });
  });

  describe('clearContacts', () => {
    it('should reset all contact-related state', () => {
      useContactStore.setState({
        contacts: [makeContact()],
        addressBooks: [{ id: 'ab-1', name: 'Default', isDefault: true }],
        selectedContactId: 'c1',
        searchQuery: 'test',
        error: 'some error',
        selectedContactIds: new Set(['c1', 'c2']),
        activeTab: 'groups',
      });

      useContactStore.getState().clearContacts();
      const state = useContactStore.getState();
      expect(state.contacts).toEqual([]);
      expect(state.addressBooks).toEqual([]);
      expect(state.selectedContactId).toBeNull();
      expect(state.searchQuery).toBe('');
      expect(state.error).toBeNull();
      expect(state.selectedContactIds.size).toBe(0);
      expect(state.activeTab).toBe('all');
    });
  });

  describe('setDefaultAddressBook', () => {
    const makeClient = () => ({
      setDefaultAddressBook: vi.fn().mockResolvedValue(undefined),
    });

    it('should move the default flag to the chosen book', async () => {
      const books = [
        { id: 'ab-1', name: 'Personal', isDefault: true },
        { id: 'ab-2', name: 'Work', isDefault: false },
      ];
      useContactStore.setState({ addressBooks: books });
      const client = makeClient();

      await useContactStore.getState().setDefaultAddressBook(
        client as unknown as IJMAPClient,
        books[1],
      );

      expect(client.setDefaultAddressBook).toHaveBeenCalledWith('ab-2', undefined);
      expect(useContactStore.getState().addressBooks.map((b) => b.isDefault)).toEqual([false, true]);
    });

    it('should send the un-namespaced id and leave other accounts alone', async () => {
      const book = {
        id: 'local-2::ab-9',
        originalId: 'ab-9',
        localAccountId: 'local-2',
        name: 'Work',
      };
      useContactStore.setState({
        addressBooks: [
          { id: 'local-1::ab-1', originalId: 'ab-1', localAccountId: 'local-1', name: 'Personal', isDefault: true },
          book,
        ],
      });
      const client = makeClient();

      await useContactStore.getState().setDefaultAddressBook(client as unknown as IJMAPClient, book);

      expect(client.setDefaultAddressBook).toHaveBeenCalledWith('ab-9', undefined);
      // The other account keeps its own default.
      expect(useContactStore.getState().addressBooks.map((b) => b.isDefault)).toEqual([true, true]);
    });

    it('should target the owning account for a shared book', async () => {
      const book = { id: 'ab-3', name: 'Team', isShared: true, accountId: 'account-2' };
      useContactStore.setState({ addressBooks: [book] });
      const client = makeClient();

      await useContactStore.getState().setDefaultAddressBook(client as unknown as IJMAPClient, book);

      expect(client.setDefaultAddressBook).toHaveBeenCalledWith('ab-3', 'account-2');
    });

    it('should surface the error and keep the previous default on failure', async () => {
      const books = [
        { id: 'ab-1', name: 'Personal', isDefault: true },
        { id: 'ab-2', name: 'Work', isDefault: false },
      ];
      useContactStore.setState({ addressBooks: books });
      const client = {
        setDefaultAddressBook: vi.fn().mockRejectedValue(new Error('Not allowed')),
      };

      await expect(
        useContactStore.getState().setDefaultAddressBook(client as unknown as IJMAPClient, books[1]),
      ).rejects.toThrow('Not allowed');
      expect(useContactStore.getState().error).toBe('Not allowed');
      expect(useContactStore.getState().addressBooks.map((b) => b.isDefault)).toEqual([true, false]);
    });
  });

  describe('toggleContactSelection', () => {
    it('should add id to selection', () => {
      useContactStore.getState().toggleContactSelection('c1');
      expect(useContactStore.getState().selectedContactIds.has('c1')).toBe(true);
    });

    it('should remove id when already selected', () => {
      useContactStore.getState().toggleContactSelection('c1');
      useContactStore.getState().toggleContactSelection('c1');
      expect(useContactStore.getState().selectedContactIds.has('c1')).toBe(false);
    });

    it('should handle multiple selections independently', () => {
      useContactStore.getState().toggleContactSelection('c1');
      useContactStore.getState().toggleContactSelection('c2');
      expect(useContactStore.getState().selectedContactIds.size).toBe(2);
      useContactStore.getState().toggleContactSelection('c1');
      expect(useContactStore.getState().selectedContactIds.has('c1')).toBe(false);
      expect(useContactStore.getState().selectedContactIds.has('c2')).toBe(true);
    });
  });

  describe('selectAllContacts', () => {
    it('should set all provided ids', () => {
      useContactStore.getState().selectAllContacts(['c1', 'c2', 'c3']);
      expect(useContactStore.getState().selectedContactIds.size).toBe(3);
    });

    it('should replace previous selection', () => {
      useContactStore.getState().toggleContactSelection('c0');
      useContactStore.getState().selectAllContacts(['c1', 'c2']);
      expect(useContactStore.getState().selectedContactIds.has('c0')).toBe(false);
      expect(useContactStore.getState().selectedContactIds.size).toBe(2);
    });
  });

  describe('clearSelection', () => {
    it('should empty the selection set', () => {
      useContactStore.getState().selectAllContacts(['c1', 'c2']);
      useContactStore.getState().clearSelection();
      expect(useContactStore.getState().selectedContactIds.size).toBe(0);
    });
  });

  describe('getAutocomplete', () => {
    beforeEach(() => {
      useContactStore.setState({
        contacts: [
          makeContact({ id: 'c1' }),
          makeContact({ id: 'c2', name: { components: [{ kind: 'given', value: 'Jane' }, { kind: 'surname', value: 'Smith' }], isOrdered: true }, emails: { e0: { address: 'jane@example.com' } } }),
          makeContact({ id: 'c3', name: { components: [{ kind: 'given', value: 'Bob' }], isOrdered: true }, emails: { e0: { address: 'bob@test.org' } } }),
        ],
      });
    });

    it('should return empty for empty query', () => {
      expect(useContactStore.getState().getAutocomplete('')).toEqual([]);
    });

    it('should match by name', () => {
      const results = useContactStore.getState().getAutocomplete('john');
      expect(results).toHaveLength(1);
      expect(results[0].email).toBe('john@example.com');
    });

    it('should match by email address', () => {
      const results = useContactStore.getState().getAutocomplete('test.org');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Bob');
    });

    it('should be case insensitive', () => {
      const results = useContactStore.getState().getAutocomplete('JANE');
      expect(results).toHaveLength(1);
      expect(results[0].email).toBe('jane@example.com');
    });

    it('should cap results at 10', () => {
      const manyContacts = Array.from({ length: 15 }, (_, i) =>
        makeContact({ id: `c${i}`, name: { components: [{ kind: 'given', value: `User${i}` }], isOrdered: true }, emails: { e0: { address: `user${i}@test.com` } } })
      );
      useContactStore.setState({ contacts: manyContacts });
      const results = useContactStore.getState().getAutocomplete('user');
      expect(results.length).toBeLessThanOrEqual(10);
    });

    it('should suggest a matching group as a single entry with member count', () => {
      const member1 = makeContact({ id: 'm1', name: { components: [{ kind: 'given', value: 'Alice' }], isOrdered: true }, emails: { e0: { address: 'alice@test.com' } } });
      const member2 = makeContact({ id: 'm2', name: { components: [{ kind: 'given', value: 'Bob' }], isOrdered: true }, emails: { e0: { address: 'bob@test.com' } } });
      const group = makeGroup({ id: 'g1', members: { m1: true, m2: true } });
      useContactStore.setState({ contacts: [member1, member2, group] });

      const results = useContactStore.getState().getAutocomplete('Team');
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ name: 'Team', email: '', group: { id: 'g1', memberCount: 2 } });
    });

    it('should not suggest a group with no addressable members', () => {
      const group = makeGroup({ id: 'g1' });
      useContactStore.setState({ contacts: [group] });
      const results = useContactStore.getState().getAutocomplete('Team');
      expect(results).toHaveLength(0);
    });

    it('should return contacts with multiple emails as separate results', () => {
      const multi = makeContact({
        id: 'multi',
        name: { components: [{ kind: 'given', value: 'Multi' }], isOrdered: true },
        emails: { e0: { address: 'a@test.com' }, e1: { address: 'b@test.com' } },
      });
      useContactStore.setState({ contacts: [multi] });
      const results = useContactStore.getState().getAutocomplete('Multi');
      expect(results).toHaveLength(2);
    });

    it('should augment results with directory principals', () => {
      useContactStore.setState({
        contacts: [],
        directoryPrincipals: [{ name: 'Dana Director', email: 'dana@example.com' }],
      });
      const results = useContactStore.getState().getAutocomplete('dana');
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ name: 'Dana Director', email: 'dana@example.com' });
    });

    it('should not duplicate a directory principal already matched as a contact', () => {
      useContactStore.setState({
        contacts: [
          makeContact({ id: 'c1', name: { components: [{ kind: 'given', value: 'Jane' }], isOrdered: true }, emails: { e0: { address: 'jane@example.com' } } }),
        ],
        directoryPrincipals: [{ name: 'Jane From Directory', email: 'JANE@example.com' }],
      });
      const results = useContactStore.getState().getAutocomplete('jane');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Jane');
    });

    // #672: a flattened vCard import leaves the whole mailbox in the name (and
    // sometimes in the address too). Suggesting that raw string composes a
    // recipient the receiving server rejects.
    it('should split a display name that carries the address', () => {
      useContactStore.setState({
        contacts: [
          makeContact({ id: 'raw', name: { full: 'Jane Doe <jane.doe@example.com>' }, emails: { e0: { address: 'jane.doe@example.com' } } }),
        ],
      });
      const results = useContactStore.getState().getAutocomplete('jane');
      expect(results).toEqual([{ name: 'Jane Doe', email: 'jane.doe@example.com' }]);
    });

    it('should split a whole mailbox stored as the address', () => {
      useContactStore.setState({
        contacts: [
          makeContact({ id: 'raw', name: { full: 'Jane Doe <jane.doe@example.com>' }, emails: { e0: { address: 'Jane Doe <jane.doe@example.com>' } } }),
        ],
      });
      const results = useContactStore.getState().getAutocomplete('jane');
      expect(results).toEqual([{ name: 'Jane Doe', email: 'jane.doe@example.com' }]);
    });

    it('should not surface a raw duplicate of an already parsed contact', () => {
      useContactStore.setState({
        contacts: [
          makeContact({ id: 'clean', name: { components: [{ kind: 'given', value: 'Jane' }, { kind: 'surname', value: 'Doe' }], isOrdered: true }, emails: { e0: { address: 'jane.doe@example.com' } } }),
          makeContact({ id: 'raw', name: { full: 'Jane Doe <jane.doe@example.com>' }, emails: { e0: { address: 'jane.doe@example.com' } } }),
        ],
      });
      const results = useContactStore.getState().getAutocomplete('jane');
      expect(results).toEqual([{ name: 'Jane Doe', email: 'jane.doe@example.com' }]);
    });

    it('should repair a recent recipient whose address lost its closing bracket', () => {
      useContactStore.setState({
        contacts: [],
        recentRecipients: [{ name: '', email: 'janedoe<jane.doe@example.com' }],
      });
      const results = useContactStore.getState().getAutocomplete('jane');
      expect(results).toEqual([{ name: 'janedoe', email: 'jane.doe@example.com' }]);
    });
  });

  describe('fetchDirectory', () => {
    it('keeps what a restricted listing offers on Stalwart 1.0 with directory queries off, without logging an error', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const client = {
        supportsPrincipals: () => true,
        getPrincipals: vi.fn(),
        listPrincipals: vi.fn().mockResolvedValue({
          status: 'restricted',
          principals: [{ id: 'grp', type: 'group', name: 'sales@example.com', description: 'Sales', email: 'sales@example.com' }],
        }),
      } as unknown as IJMAPClient;

      await useContactStore.getState().fetchDirectory(client);

      const state = useContactStore.getState();
      // Browsing says the directory is closed, but shows who the user knows.
      expect(state.directoryStatus).toBe('forbidden');
      expect(state.directoryLoaded).toBe(true);
      expect(state.directoryPrincipals).toEqual([{ id: 'grp', name: 'Sales', email: 'sales@example.com', description: 'Sales', type: 'group' }]);
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });

    it('counts a client without listPrincipals (demo) as a complete listing', async () => {
      const client = {
        supportsPrincipals: () => true,
        getPrincipals: vi.fn().mockResolvedValue([{ id: 'a', type: 'individual', name: 'anna@example.com', email: 'anna@example.com' }]),
      } as unknown as IJMAPClient;

      await useContactStore.getState().fetchDirectory(client);

      expect(useContactStore.getState().directoryStatus).toBe('ready');
      expect(useContactStore.getState().directoryPrincipals).toEqual([{ id: 'a', name: 'anna@example.com', email: 'anna@example.com', description: undefined, type: 'individual' }]);
    });
  });

  describe('getGroups', () => {
    it('should return only group contacts', () => {
      useContactStore.setState({ contacts: [makeContact(), makeGroup()] });
      const groups = useContactStore.getState().getGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].kind).toBe('group');
    });

    it('should return empty when no groups', () => {
      useContactStore.setState({ contacts: [makeContact()] });
      expect(useContactStore.getState().getGroups()).toHaveLength(0);
    });
  });

  describe('getIndividuals', () => {
    it('should return non-group contacts', () => {
      useContactStore.setState({ contacts: [makeContact(), makeGroup()] });
      const individuals = useContactStore.getState().getIndividuals();
      expect(individuals).toHaveLength(1);
      expect(individuals[0].kind).not.toBe('group');
    });

    it('should include org and undefined kind', () => {
      useContactStore.setState({
        contacts: [
          makeContact({ id: 'c1' }),
          makeContact({ id: 'c2', kind: 'org' }),
          makeGroup(),
        ],
      });
      expect(useContactStore.getState().getIndividuals()).toHaveLength(2);
    });
  });

  describe('getGroupMembers', () => {
    it('should return contacts whose ids are in group members', () => {
      const m1 = makeContact({ id: 'm1' });
      const m2 = makeContact({ id: 'm2' });
      const nonMember = makeContact({ id: 'nm' });
      const group = makeGroup({ id: 'g1', members: { m1: true, m2: true } });
      useContactStore.setState({ contacts: [m1, m2, nonMember, group] });

      const members = useContactStore.getState().getGroupMembers('g1');
      expect(members).toHaveLength(2);
      expect(members.map(m => m.id).sort()).toEqual(['m1', 'm2']);
    });

    it('should return empty for group with no members', () => {
      useContactStore.setState({ contacts: [makeGroup({ id: 'g1', members: {} })] });
      expect(useContactStore.getState().getGroupMembers('g1')).toHaveLength(0);
    });

    it('should return empty for non-existent group', () => {
      expect(useContactStore.getState().getGroupMembers('nonexistent')).toHaveLength(0);
    });

    it('should match by uid as well as id', () => {
      const m1 = makeContact({ id: 'm1', uid: 'uid-m1' });
      const group = makeGroup({ id: 'g1', members: { 'uid-m1': true } });
      useContactStore.setState({ contacts: [m1, group] });
      expect(useContactStore.getState().getGroupMembers('g1')).toHaveLength(1);
    });

    it('should exclude members with false value', () => {
      const m1 = makeContact({ id: 'm1' });
      const m2 = makeContact({ id: 'm2' });
      const group = makeGroup({ id: 'g1', members: { m1: true, m2: false } });
      useContactStore.setState({ contacts: [m1, m2, group] });
      expect(useContactStore.getState().getGroupMembers('g1')).toHaveLength(1);
    });
  });

  describe('createGroup (local mode)', () => {
    it('should create group with local- prefix id', async () => {
      await useContactStore.getState().createGroup(null, 'Friends', ['c1', 'c2']);
      const contacts = useContactStore.getState().contacts;
      expect(contacts).toHaveLength(1);
      expect(contacts[0].id).toMatch(/^local-/);
      expect(contacts[0].kind).toBe('group');
    });

    it('should set members from provided ids', async () => {
      await useContactStore.getState().createGroup(null, 'Team', ['m1', 'm2']);
      const group = useContactStore.getState().contacts[0];
      expect(group.members).toEqual({ m1: true, m2: true });
    });

    it('should set group name', async () => {
      await useContactStore.getState().createGroup(null, 'Work', []);
      const group = useContactStore.getState().contacts[0];
      expect(group.name?.components?.[0]?.value).toBe('Work');
    });
  });

  describe('updateGroup (local mode)', () => {
    it('should update group name', async () => {
      await useContactStore.getState().createGroup(null, 'Old', []);
      const groupId = useContactStore.getState().contacts[0].id;
      await useContactStore.getState().updateGroup(null, groupId, 'New');
      expect(useContactStore.getState().contacts[0].name?.components?.[0]?.value).toBe('New');
    });

    it('should preserve group members when renaming', async () => {
      await useContactStore.getState().createGroup(null, 'Team', ['m1']);
      const groupId = useContactStore.getState().contacts[0].id;
      await useContactStore.getState().updateGroup(null, groupId, 'Renamed');
      expect(useContactStore.getState().contacts[0].members).toEqual({ m1: true });
    });
  });

  describe('addMembersToGroup (local mode)', () => {
    it('should add new members to group', async () => {
      await useContactStore.getState().createGroup(null, 'Team', ['m1']);
      const groupId = useContactStore.getState().contacts[0].id;
      await useContactStore.getState().addMembersToGroup(null, groupId, ['m2', 'm3']);
      const members = useContactStore.getState().contacts[0].members;
      expect(members).toEqual({ m1: true, m2: true, m3: true });
    });

    it('should no-op for non-existent group', async () => {
      await useContactStore.getState().addMembersToGroup(null, 'nonexistent', ['m1']);
      expect(useContactStore.getState().contacts).toHaveLength(0);
    });
  });

  describe('removeMembersFromGroup (local mode)', () => {
    it('should remove members from group', async () => {
      await useContactStore.getState().createGroup(null, 'Team', ['m1', 'm2', 'm3']);
      const groupId = useContactStore.getState().contacts[0].id;
      await useContactStore.getState().removeMembersFromGroup(null, groupId, ['m2']);
      const members = useContactStore.getState().contacts[0].members;
      expect(members).toEqual({ m1: true, m3: true });
    });

    it('should no-op for group without members', async () => {
      const group = makeGroup({ id: 'g1', members: undefined });
      useContactStore.setState({ contacts: [group] });
      await useContactStore.getState().removeMembersFromGroup(null, 'g1', ['m1']);
      expect(useContactStore.getState().contacts[0].members).toBeUndefined();
    });
  });

  describe('deleteGroup (local mode)', () => {
    it('should remove group from contacts', async () => {
      await useContactStore.getState().createGroup(null, 'Team', []);
      const groupId = useContactStore.getState().contacts[0].id;
      await useContactStore.getState().deleteGroup(null, groupId);
      expect(useContactStore.getState().contacts).toHaveLength(0);
    });

    it('should clear selectedContactId when deleting selected group', async () => {
      await useContactStore.getState().createGroup(null, 'Team', []);
      const groupId = useContactStore.getState().contacts[0].id;
      useContactStore.getState().setSelectedContact(groupId);
      await useContactStore.getState().deleteGroup(null, groupId);
      expect(useContactStore.getState().selectedContactId).toBeNull();
    });

    it('should preserve selectedContactId when deleting other group', async () => {
      await useContactStore.getState().addLocalContact(makeContact({ id: 'c1' }));
      useContactStore.getState().setSelectedContact('c1');
      await useContactStore.getState().createGroup(null, 'Team', []);
      const groupId = useContactStore.getState().contacts[1].id;
      await useContactStore.getState().deleteGroup(null, groupId);
      expect(useContactStore.getState().selectedContactId).toBe('c1');
    });
  });

  describe('bulkDeleteContacts (local mode)', () => {
    it('should remove multiple contacts', async () => {
      useContactStore.setState({
        contacts: [makeContact({ id: 'c1' }), makeContact({ id: 'c2' }), makeContact({ id: 'c3' })],
      });
      await useContactStore.getState().bulkDeleteContacts(null, ['c1', 'c3']);
      expect(useContactStore.getState().contacts).toHaveLength(1);
      expect(useContactStore.getState().contacts[0].id).toBe('c2');
    });

    it('should clear selection after bulk delete', async () => {
      useContactStore.setState({
        contacts: [makeContact({ id: 'c1' })],
        selectedContactIds: new Set(['c1']),
      });
      await useContactStore.getState().bulkDeleteContacts(null, ['c1']);
      expect(useContactStore.getState().selectedContactIds.size).toBe(0);
    });

    it('should clear selectedContactId if deleted', async () => {
      useContactStore.setState({
        contacts: [makeContact({ id: 'c1' }), makeContact({ id: 'c2' })],
        selectedContactId: 'c1',
      });
      await useContactStore.getState().bulkDeleteContacts(null, ['c1']);
      expect(useContactStore.getState().selectedContactId).toBeNull();
    });
  });

  // Multi-account Pro mode lists every login's cards together. Card ids
  // repeat across logins (each account numbers its own), so a write sent
  // through the active login with another login's card id hits the active
  // login's card of that id.
  describe('writes to another login\'s cards', () => {
    const loginClient = () => ({
      getContactsAccountId: vi.fn(() => 'acct-primary'),
      updateContact: vi.fn().mockResolvedValue(undefined),
      deleteContact: vi.fn().mockResolvedValue(undefined),
    });
    let active: ReturnType<typeof loginClient>;
    let other: ReturnType<typeof loginClient>;

    beforeEach(() => {
      active = loginClient();
      other = loginClient();
      setClientLookup((localAccountId) => (localAccountId === 'b@host' ? other as unknown as IJMAPClient : undefined));
      useContactStore.setState({
        supportsSync: true,
        contacts: [
          makeContact({ id: 'a@host::c', originalId: 'c', localAccountId: 'a@host' }),
          makeContact({ id: 'b@host::c', originalId: 'c', localAccountId: 'b@host' }),
          makeGroup({ id: 'b@host::g', originalId: 'g', localAccountId: 'b@host', members: { 'urn:uuid:x': true } }),
        ],
      });
    });

    afterEach(() => {
      setClientLookup(() => undefined);
    });

    it('deletes selected cards through the login they belong to', async () => {
      await useContactStore.getState().bulkDeleteContacts(active as unknown as IJMAPClient, ['b@host::c']);

      expect(other.deleteContact).toHaveBeenCalledWith('c', undefined);
      expect(active.deleteContact).not.toHaveBeenCalled();
    });

    it('changes and deletes a group through the login it belongs to', async () => {
      const client = active as unknown as IJMAPClient;
      await useContactStore.getState().updateGroup(client, 'b@host::g', 'Renamed');
      await useContactStore.getState().addMembersToGroup(client, 'b@host::g', ['b@host::c']);
      await useContactStore.getState().removeMembersFromGroup(client, 'b@host::g', ['urn:uuid:x']);
      await useContactStore.getState().deleteGroup(client, 'b@host::g');

      expect(other.updateContact).toHaveBeenCalledTimes(3);
      expect(other.updateContact.mock.calls.every(([id, , accountId]) => id === 'g' && accountId === undefined)).toBe(true);
      expect(other.deleteContact).toHaveBeenCalledWith('g', undefined);
      expect(active.updateContact).not.toHaveBeenCalled();
      expect(active.deleteContact).not.toHaveBeenCalled();
    });

    it('moves a card between two books of its own login there', async () => {
      // Each login's own books carry that login's primary account.
      other.getContactsAccountId.mockReturnValue('acct-b');
      const target = { id: 'b@host::ab-2', originalId: 'ab-2', localAccountId: 'b@host', accountId: 'acct-b', name: 'Work' };

      await useContactStore.getState().moveContactToAddressBook(active as unknown as IJMAPClient, ['b@host::c'], target);

      expect(other.updateContact).toHaveBeenCalledWith('c', { addressBookIds: { 'ab-2': true } }, undefined);
      expect(active.updateContact).not.toHaveBeenCalled();
      expect(active.deleteContact).not.toHaveBeenCalled();
    });

    it('moves a card into a shared book of its login by creating it and deleting the old one there', async () => {
      other.getContactsAccountId.mockReturnValue('acct-b');
      const created = makeContact({ id: 'n', addressBookIds: { 'ab-7': true } });
      const otherCreate = vi.fn().mockResolvedValue(created);
      Object.assign(other, { createContact: otherCreate });
      const target = { id: 'b@host::acct-s:ab-7', originalId: 'ab-7', localAccountId: 'b@host', accountId: 'acct-s', accountName: 'Team', isShared: true, name: 'Team' };

      await useContactStore.getState().moveContactToAddressBook(active as unknown as IJMAPClient, ['b@host::c'], target);

      expect(otherCreate).toHaveBeenCalledWith(expect.objectContaining({ addressBookIds: { 'ab-7': true } }), 'acct-s');
      expect(other.deleteContact).toHaveBeenCalledWith('c', undefined);
      expect(active.deleteContact).not.toHaveBeenCalled();
      expect(useContactStore.getState().contacts.find((c) => c.originalId === 'n')).toMatchObject({
        id: 'b@host::acct-s:n', localAccountId: 'b@host', isShared: true, accountId: 'acct-s',
        addressBookIds: { 'b@host::acct-s:ab-7': true },
      });
    });
  });

  describe('bulkAddToGroup (local mode)', () => {
    it('should add contacts to group and clear selection', async () => {
      const m1 = makeContact({ id: 'm1' });
      const group = makeGroup({ id: 'g1', members: {} });
      useContactStore.setState({
        contacts: [m1, group],
        selectedContactIds: new Set(['m1']),
      });
      await useContactStore.getState().bulkAddToGroup(null, 'g1', ['m1']);
      expect(useContactStore.getState().contacts.find(c => c.id === 'g1')?.members).toEqual({ m1: true });
      expect(useContactStore.getState().selectedContactIds.size).toBe(0);
    });
  });

  describe('importContacts (local mode)', () => {
    it('should import contacts with local- prefix ids', async () => {
      const toImport = [makeContact({ id: 'orig-1' }), makeContact({ id: 'orig-2' })];
      const count = await useContactStore.getState().importContacts(null, toImport);
      expect(count).toBe(2);
      expect(useContactStore.getState().contacts).toHaveLength(2);
      expect(useContactStore.getState().contacts[0].id).toMatch(/^local-/);
    });
  });

  describe('normalizeContactPhotoUri', () => {
    it('rewrites malformed data:base64,... URIs using the media mediaType', () => {
      expect(normalizeContactPhotoUri('data:base64,AAAA', 'image/png'))
        .toBe('data:image/png;base64,AAAA');
    });

    it('rewrites data:;base64,... URIs using the media mediaType', () => {
      expect(normalizeContactPhotoUri('data:;base64,AAAA', 'image/gif'))
        .toBe('data:image/gif;base64,AAAA');
    });

    it('defaults to image/jpeg when no mediaType is available', () => {
      expect(normalizeContactPhotoUri('data:base64,AAAA'))
        .toBe('data:image/jpeg;base64,AAAA');
    });

    it('leaves well-formed data URIs unchanged', () => {
      const good = 'data:image/png;base64,AAAA';
      expect(normalizeContactPhotoUri(good)).toBe(good);
    });

    it('leaves http(s) URIs unchanged', () => {
      const url = 'https://example.com/photo.jpg';
      expect(normalizeContactPhotoUri(url)).toBe(url);
    });
  });

  describe('getContactPhotoUri', () => {
    it('returns a normalized data URI for malformed Stalwart photos (#307)', () => {
      const contact = makeContact({
        media: { m0: { kind: 'photo', uri: 'data:base64,AAAA', mediaType: 'image/png' } },
      });
      expect(getContactPhotoUri(contact)).toBe('data:image/png;base64,AAAA');
    });

    it('returns undefined when no photo media is present', () => {
      expect(getContactPhotoUri(makeContact())).toBeUndefined();
    });

    it('returns undefined for a Stalwart 1.0 blob photo, which has no URI', () => {
      expect(getContactPhotoUri(makeContact({
        media: { photo: { kind: 'photo', blobId: 'dbcX', mediaType: 'image/jpeg' } },
      }))).toBeUndefined();
    });
  });

  describe('getContactPhotoRef / hasContactPhoto', () => {
    // The shapes ContactCard/get returns for the same PHOTO.
    const photo0_16_23 = { kind: 'photo' as const, uri: 'data:image/jpeg;base64,/9j/', mediaType: 'image/jpeg' };
    const photo0_16_0 = { kind: 'photo' as const, uri: 'data:base64,/9j/' };
    const photo1_0 = { kind: 'photo' as const, blobId: 'dbcX', mediaType: 'image/jpeg' };

    it('returns the data URI on Stalwart 0.16.23', () => {
      const contact = makeContact({ media: { m0: photo0_16_23 } });
      expect(getContactPhotoRef(contact)).toEqual({ uri: 'data:image/jpeg;base64,/9j/' });
      expect(hasContactPhoto(contact)).toBe(true);
    });

    it('returns a data URI with a media type for the Stalwart 0.16.0 shape', () => {
      const contact = makeContact({ media: { m0: photo0_16_0 } });
      expect(getContactPhotoRef(contact)).toEqual({ uri: 'data:image/jpeg;base64,/9j/' });
      expect(hasContactPhoto(contact)).toBe(true);
    });

    it('returns the blob and where to download it on Stalwart 1.0', () => {
      const contact = makeContact({
        media: { m0: photo1_0 },
        accountId: 'shared-1',
        localAccountId: 'me@host',
      });
      expect(getContactPhotoRef(contact)).toEqual({
        blobId: 'dbcX', mediaType: 'image/jpeg', accountId: 'shared-1', localAccountId: 'me@host',
      });
      expect(hasContactPhoto(contact)).toBe(true);
    });

    it('keeps an https photo as it is', () => {
      const contact = makeContact({ media: { m0: { kind: 'photo', uri: 'https://x.test/p.jpg' } } });
      expect(getContactPhotoRef(contact)).toEqual({ uri: 'https://x.test/p.jpg' });
    });

    it('finds no photo on a card with only a logo, an empty entry or a null entry', () => {
      const contact = makeContact({
        media: {
          logo: { kind: 'logo', blobId: 'dbcLogo', mediaType: 'image/png' },
          empty: { kind: 'photo' },
          gone: null as unknown as ContactMedia,
        },
      });
      expect(getContactPhotoRef(contact)).toBeUndefined();
      expect(hasContactPhoto(contact)).toBe(false);
      expect(hasContactPhoto(makeContact())).toBe(false);
    });

    it('prefers the photo with the lowest pref', () => {
      const contact = makeContact({
        media: {
          a: { kind: 'photo', uri: 'https://x.test/a.jpg' },
          b: { kind: 'photo', blobId: 'dbcB', pref: 1 },
        },
      });
      expect(findContactPhotoEntry(contact)?.[0]).toBe('b');
    });
  });

  describe('getContactPhotoIndex', () => {
    it('maps each address to the photo of the first contact that has one', () => {
      const contacts = [
        makeContact({ id: 'c1', emails: { e0: { address: 'Ann@Example.com' } } }),
        makeContact({
          id: 'c2',
          emails: { e0: { address: 'ann@example.com' }, e1: { address: 'boss@example.com' } },
          media: { photo: { kind: 'photo', blobId: 'dbcAnn', mediaType: 'image/jpeg' } },
        }),
        makeContact({ id: 'c3', emails: { e0: { address: 'ann@example.com' } }, media: { photo: { kind: 'photo', uri: 'https://x.test/other.jpg' } } }),
      ];

      const index = getContactPhotoIndex(contacts);

      expect(index.get('ann@example.com')).toEqual(expect.objectContaining({ blobId: 'dbcAnn' }));
      expect(index.get('boss@example.com')).toEqual(expect.objectContaining({ blobId: 'dbcAnn' }));
      expect(getContactPhotoIndex(contacts)).toBe(index);
    });
  });

  describe('saving a new photo (P0-3)', () => {
    const NEW_PHOTO = 'data:image/jpeg;base64,/9j/4AAQ';

    const makeClient = (blobMedia: boolean) => ({
      getContactsAccountId: vi.fn(() => 'acct-primary'),
      supportsContactBlobMedia: vi.fn(() => blobMedia),
      rejectContactBlobMedia: vi.fn(),
      uploadBlob: vi.fn(async (file: File) => ({ blobId: 'Gupload1', size: file.size, type: file.type })),
      createContact: vi.fn(async (c: Partial<ContactCard>) => ({ ...makeContact(), ...c, id: 'created-id' })),
      updateContact: vi.fn().mockResolvedValue(undefined),
    });

    it('uploads the photo and sends its blobId on Stalwart 1.0', async () => {
      useContactStore.setState({ contacts: [makeContact({ id: 'c-1' })] });
      const client = makeClient(true);

      await useContactStore.getState().updateContact(
        client as unknown as IJMAPClient,
        'c-1',
        { media: { photo: { kind: 'photo', uri: NEW_PHOTO, mediaType: 'image/jpeg' } } },
        { photoKey: 'photo' },
      );

      expect(client.uploadBlob).toHaveBeenCalledWith(expect.any(File), 'acct-primary');
      expect(client.updateContact).toHaveBeenCalledWith(
        'c-1',
        { media: { photo: { kind: 'photo', mediaType: 'image/jpeg', blobId: 'Gupload1' } } },
        undefined,
      );
      // The list shows the picked photo until the next fetch brings the blob.
      expect(useContactStore.getState().contacts[0].media?.photo.uri).toBe(NEW_PHOTO);
    });

    it('sends the data: URI without uploading on Stalwart 0.16', async () => {
      const client = makeClient(false);

      await useContactStore.getState().createContact(
        client as unknown as IJMAPClient,
        { media: { photo: { kind: 'photo', uri: NEW_PHOTO, mediaType: 'image/jpeg' } } },
        { photoKey: 'photo' },
      );

      expect(client.uploadBlob).not.toHaveBeenCalled();
      expect(client.createContact).toHaveBeenCalledWith(
        { media: { photo: { kind: 'photo', uri: NEW_PHOTO, mediaType: 'image/jpeg' } } },
        undefined,
      );
    });

    it('checks the capability of the shared account the card is written to', async () => {
      useContactStore.setState({
        contacts: [makeContact({ id: 'shared-1:c-9', originalId: 'c-9', isShared: true, accountId: 'shared-1' })],
      });
      const client = makeClient(true);

      await useContactStore.getState().updateContact(
        client as unknown as IJMAPClient,
        'shared-1:c-9',
        { media: { photo: { kind: 'photo', uri: NEW_PHOTO, mediaType: 'image/jpeg' } } },
        { photoKey: 'photo' },
      );

      expect(client.supportsContactBlobMedia).toHaveBeenCalledWith('shared-1');
      expect(client.uploadBlob).toHaveBeenCalledWith(expect.any(File), 'acct-primary');
      expect(client.updateContact).toHaveBeenCalledWith('c-9', expect.anything(), 'shared-1');
    });
  });

  describe('fetchContactFromServer', () => {
    // The contact form rebuilds `media` on this when the photo changed: the
    // list's copy may carry a blobId Stalwart 1.0 no longer resolves.
    it('reads a shared card from its account by its server id', async () => {
      useContactStore.setState({
        contacts: [makeContact({ id: 'shared-1:c-9', originalId: 'c-9', isShared: true, accountId: 'shared-1' })],
      });
      const current = makeContact({ id: 'c-9', media: { logo: { kind: 'logo', blobId: 'dbcLogoNew' } } });
      const client = { getContact: vi.fn(async () => current) };

      const card = await useContactStore.getState().fetchContactFromServer(client as unknown as IJMAPClient, 'shared-1:c-9');

      expect(client.getContact).toHaveBeenCalledWith('c-9', 'shared-1');
      expect(card).toBe(current);
    });

    it('reads an own card from the default account', async () => {
      useContactStore.setState({ contacts: [makeContact({ id: 'c-1' })] });
      const client = { getContact: vi.fn(async () => null) };

      expect(await useContactStore.getState().fetchContactFromServer(client as unknown as IJMAPClient, 'c-1')).toBeNull();
      expect(client.getContact).toHaveBeenCalledWith('c-1', undefined);
    });
  });

  describe('moving a contact to another account', () => {
    beforeEach(() => {
      clearContactPhotoCache();
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    });

    afterEach(() => {
      clearContactPhotoCache();
      vi.restoreAllMocks();
    });

    it('sends the bytes of a Stalwart 1.0 blob photo, not the source blobId', async () => {
      useContactStore.setState({
        contacts: [makeContact({
          id: 'c-1',
          originalId: 'c-1',
          accountId: 'acct-primary',
          media: { photo: { kind: 'photo', blobId: 'dbcX', mediaType: 'image/jpeg' } },
        })],
      });
      const client = {
        getContactsAccountId: vi.fn(() => 'acct-primary'),
        fetchBlob: vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' })),
        createContact: vi.fn(async (c: Partial<ContactCard>) => ({ ...makeContact(), ...c, id: 'moved-id' })),
        deleteContact: vi.fn().mockResolvedValue(undefined),
      };

      await useContactStore.getState().moveContactToAddressBook(
        client as unknown as IJMAPClient,
        ['c-1'],
        { id: 'shared-1:ab-7', originalId: 'ab-7', name: 'Team', isShared: true, accountId: 'shared-1' },
      );

      expect(client.fetchBlob).toHaveBeenCalledWith('dbcX', 'photo', 'image/jpeg', 'acct-primary');
      expect(client.createContact).toHaveBeenCalledWith(
        expect.objectContaining({
          media: { photo: { kind: 'photo', mediaType: 'image/jpeg', uri: 'data:image/jpeg;base64,/9j/' } },
          addressBookIds: { 'ab-7': true },
        }),
        'shared-1',
      );
      expect(client.deleteContact).toHaveBeenCalledWith('c-1', undefined);
    });
  });

  describe('loadTrustedSendersBook (#730)', () => {
    const trustedBook = (id: string) => ({ id, name: TRUSTED_SENDERS_BOOK_NAME });

    const makeClient = (overrides: Record<string, unknown> = {}) => ({
      getAddressBooks: vi.fn().mockResolvedValue([]),
      createAddressBook: vi.fn(async (name: string) => ({ id: 'created-book', name })),
      getContacts: vi.fn().mockResolvedValue([]),
      createContact: vi.fn(),
      updateContact: vi.fn().mockResolvedValue(undefined),
      deleteContact: vi.fn().mockResolvedValue(undefined),
      deleteAddressBook: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    beforeEach(() => {
      useContactStore.setState({
        trustedSendersBookId: null,
        trustedSendersLoaded: false,
        trustedSendersLoading: false,
        trustedSenderEmails: [],
      });
    });

    it('does not create a book when the address book fetch fails', async () => {
      const client = makeClient({ getAddressBooks: vi.fn().mockRejectedValue(new Error('429 rate limited')) });

      await useContactStore.getState().loadTrustedSendersBook(client as never);

      expect(client.createAddressBook).not.toHaveBeenCalled();
      expect(useContactStore.getState().trustedSendersBookId).toBeNull();
    });

    it('creates the book exactly once for a genuinely empty account', async () => {
      const client = makeClient();

      await useContactStore.getState().loadTrustedSendersBook(client as never);

      expect(client.createAddressBook).toHaveBeenCalledTimes(1);
      expect(useContactStore.getState().trustedSendersBookId).toBe('created-book');
    });

    it('shares one in-flight load between concurrent callers', async () => {
      const client = makeClient();

      await Promise.all([
        useContactStore.getState().loadTrustedSendersBook(client as never),
        useContactStore.getState().loadTrustedSendersBook(client as never),
        useContactStore.getState().loadTrustedSendersBook(client as never),
      ]);

      expect(client.createAddressBook).toHaveBeenCalledTimes(1);
    });

    it('picks the same book on every client when duplicates already exist', async () => {
      const client = makeClient({
        getAddressBooks: vi.fn().mockResolvedValue([trustedBook('book-c'), trustedBook('book-a'), trustedBook('book-b')]),
      });

      await useContactStore.getState().loadTrustedSendersBook(client as never);

      expect(client.createAddressBook).not.toHaveBeenCalled();
      expect(useContactStore.getState().trustedSendersBookId).toBe('book-a');
    });

    it('merges duplicate books into the canonical one and deletes the leftovers', async () => {
      const contactsByBook: Record<string, ContactCard[]> = {
        'book-a': [makeContact({ id: 'c1', addressBookIds: { 'book-a': true }, emails: { e0: { address: 'kept@example.com' } } })],
        'book-b': [makeContact({ id: 'c2', addressBookIds: { 'book-b': true }, emails: { e0: { address: 'moved@example.com' } } })],
      };
      const client = makeClient({
        getAddressBooks: vi.fn().mockResolvedValue([trustedBook('book-a'), trustedBook('book-b')]),
        getContacts: vi.fn(async (bookId: string) => contactsByBook[bookId] ?? []),
      });

      await useContactStore.getState().loadTrustedSendersBook(client as never);

      expect(client.updateContact).toHaveBeenCalledWith('c2', { addressBookIds: { 'book-a': true } });
      expect(client.deleteAddressBook).toHaveBeenCalledWith('book-b');
      expect(useContactStore.getState().trustedSenderEmails.sort()).toEqual(['kept@example.com', 'moved@example.com']);
    });

    it('drops a duplicate card instead of copying it when the address is already trusted', async () => {
      const duplicate = makeContact({ id: 'c2', addressBookIds: { 'book-b': true }, emails: { e0: { address: 'kept@example.com' } } });
      const contactsByBook: Record<string, ContactCard[]> = {
        'book-a': [makeContact({ id: 'c1', addressBookIds: { 'book-a': true }, emails: { e0: { address: 'kept@example.com' } } })],
        'book-b': [duplicate],
      };
      const client = makeClient({
        getAddressBooks: vi.fn().mockResolvedValue([trustedBook('book-a'), trustedBook('book-b')]),
        getContacts: vi.fn(async (bookId: string) => contactsByBook[bookId] ?? []),
      });

      await useContactStore.getState().loadTrustedSendersBook(client as never);

      expect(client.deleteContact).toHaveBeenCalledWith('c2');
      expect(useContactStore.getState().trustedSenderEmails).toEqual(['kept@example.com']);
    });

    it('unfiles rather than destroys a card that also lives in another book', async () => {
      const contactsByBook: Record<string, ContactCard[]> = {
        'book-a': [makeContact({ id: 'c1', addressBookIds: { 'book-a': true }, emails: { e0: { address: 'kept@example.com' } } })],
        'book-b': [makeContact({ id: 'c2', addressBookIds: { 'book-b': true, personal: true }, emails: { e0: { address: 'kept@example.com' } } })],
      };
      const client = makeClient({
        getAddressBooks: vi.fn().mockResolvedValue([trustedBook('book-a'), trustedBook('book-b')]),
        getContacts: vi.fn(async (bookId: string) => contactsByBook[bookId] ?? []),
      });

      await useContactStore.getState().loadTrustedSendersBook(client as never);

      expect(client.deleteContact).not.toHaveBeenCalled();
      expect(client.updateContact).toHaveBeenCalledWith('c2', { addressBookIds: { personal: true } });
    });

    it('keeps a duplicate book when its contacts cannot be read', async () => {
      const client = makeClient({
        getAddressBooks: vi.fn().mockResolvedValue([trustedBook('book-a'), trustedBook('book-b')]),
        getContacts: vi.fn(async (bookId: string) => {
          if (bookId === 'book-b') throw new Error('Network error');
          return [];
        }),
      });

      await useContactStore.getState().loadTrustedSendersBook(client as never);

      expect(client.deleteAddressBook).not.toHaveBeenCalled();
      expect(useContactStore.getState().trustedSendersBookId).toBe('book-a');
    });
  });

  describe('address-book id namespacing on mutations (#133, #1043)', () => {
    const makeClient = () => ({
      getContactsAccountId: vi.fn(() => 'acct-primary'),
      createContact: vi.fn(async (c: Partial<ContactCard>) => ({ ...makeContact(), ...c, id: 'created-id' })),
      updateContact: vi.fn().mockResolvedValue(undefined),
      deleteContact: vi.fn().mockResolvedValue(undefined),
    });

    it('strips the local-account prefix from a personal book on update', async () => {
      // Multi-account Pro mode namespaces EVERY book, including the active
      // account's own default one, as `local::bookId`. Updating such a contact
      // used to send the namespaced id and Stalwart rejected the card with
      // "Contact has to belong to at least one address book".
      useContactStore.setState({
        addressBooks: [
          { id: 'me@host::ab-1', originalId: 'ab-1', localAccountId: 'me@host', name: 'Personal', isDefault: true },
        ],
        contacts: [makeContact({
          id: 'me@host::c-1',
          originalId: 'c-1',
          localAccountId: 'me@host',
          addressBookIds: { 'me@host::ab-1': true },
        })],
      });
      const client = makeClient();

      await useContactStore.getState().updateContact(
        client as unknown as IJMAPClient,
        'me@host::c-1',
        { name: { components: [{ kind: 'given', value: 'Jane' }], isOrdered: true }, addressBookIds: { 'me@host::ab-1': true } },
      );

      expect(client.updateContact).toHaveBeenCalledWith(
        'c-1',
        expect.objectContaining({ addressBookIds: { 'ab-1': true } }),
        undefined,
      );
      // Local state keeps the namespaced form the sidebar filters by.
      expect(useContactStore.getState().contacts[0].addressBookIds).toEqual({ 'me@host::ab-1': true });
    });

    it('strips both local-account and shared-account prefixes on update', async () => {
      useContactStore.setState({
        addressBooks: [
          { id: 'me@host::group-1:ab-7', originalId: 'ab-7', localAccountId: 'me@host', name: 'Team', isShared: true, accountId: 'group-1' },
        ],
        contacts: [makeContact({
          id: 'me@host::group-1:c-9',
          originalId: 'c-9',
          localAccountId: 'me@host',
          isShared: true,
          accountId: 'group-1',
          addressBookIds: { 'me@host::group-1:ab-7': true },
        })],
      });
      const client = makeClient();

      await useContactStore.getState().updateContact(
        client as unknown as IJMAPClient,
        'me@host::group-1:c-9',
        { addressBookIds: { 'me@host::group-1:ab-7': true } },
      );

      expect(client.updateContact).toHaveBeenCalledWith('c-9', { addressBookIds: { 'ab-7': true } }, 'group-1');
    });

    it('falls back to prefix stripping when the book is not in state', async () => {
      useContactStore.setState({
        addressBooks: [],
        contacts: [makeContact({
          id: 'me@host::group-1:c-9',
          originalId: 'c-9',
          localAccountId: 'me@host',
          isShared: true,
          accountId: 'group-1',
        })],
      });
      const client = makeClient();

      await useContactStore.getState().updateContact(
        client as unknown as IJMAPClient,
        'me@host::group-1:c-9',
        { addressBookIds: { 'me@host::group-1:ab-7': true } },
      );

      expect(client.updateContact).toHaveBeenCalledWith('c-9', { addressBookIds: { 'ab-7': true } }, 'group-1');
    });

    it('leaves raw ids untouched in single-account mode', async () => {
      useContactStore.setState({
        addressBooks: [{ id: 'ab-1', name: 'Personal', isDefault: true }],
        contacts: [makeContact({ id: 'c-1' })],
      });
      const client = makeClient();

      await useContactStore.getState().updateContact(
        client as unknown as IJMAPClient,
        'c-1',
        { addressBookIds: { 'ab-1': true } },
      );

      expect(client.updateContact).toHaveBeenCalledWith('c-1', { addressBookIds: { 'ab-1': true } }, undefined);
    });

    it('strips the local-account prefix on create too', async () => {
      useContactStore.setState({
        addressBooks: [
          { id: 'me@host::ab-1', originalId: 'ab-1', localAccountId: 'me@host', name: 'Personal', isDefault: true },
        ],
      });
      const client = makeClient();

      await useContactStore.getState().createContact(
        client as unknown as IJMAPClient,
        { addressBookIds: { 'me@host::ab-1': true } },
      );

      expect(client.createContact).toHaveBeenCalledWith(
        expect.objectContaining({ addressBookIds: { 'ab-1': true } }),
        undefined,
      );
    });

    // Card ids repeat across accounts (live on 0.16 and 1.0: the sharee's own
    // card and one it creates in the owner's shared book both got "c"). A card
    // created in a shared book was kept under its bare id: deleting it right
    // after deleted the own card with that id.
    it('keeps a card created in a shared book apart from an own card with the same id', async () => {
      useContactStore.setState({
        addressBooks: [
          { id: 'ab-1', name: 'Personal', isDefault: true },
          { id: 'acct-a:ab-7', originalId: 'ab-7', name: 'Team', isShared: true, accountId: 'acct-a', accountName: 'Alice' },
        ],
        contacts: [makeContact({ id: 'c', addressBookIds: { 'ab-1': true } })],
      });
      const client = makeClient();
      client.createContact.mockImplementation(async (c: Partial<ContactCard>) => ({ ...makeContact(), ...c, id: 'c' }));

      await useContactStore.getState().createContact(
        client as unknown as IJMAPClient,
        { addressBookIds: { 'acct-a:ab-7': true } },
      );

      expect(client.createContact).toHaveBeenCalledWith(expect.objectContaining({ addressBookIds: { 'ab-7': true } }), 'acct-a');
      const created = useContactStore.getState().contacts[1];
      expect(created).toMatchObject({
        id: 'acct-a:c', originalId: 'c', isShared: true, accountId: 'acct-a', accountName: 'Alice',
        addressBookIds: { 'acct-a:ab-7': true },
      });

      await useContactStore.getState().deleteContact(client as unknown as IJMAPClient, 'acct-a:c');

      expect(client.deleteContact).toHaveBeenCalledWith('c', 'acct-a');
      expect(useContactStore.getState().contacts.map((c) => c.id)).toEqual(['c']);
    });

    it('namespaces a card created through another login like that login\'s listing', async () => {
      useContactStore.setState({
        addressBooks: [
          { id: 'me@host::ab-1', originalId: 'ab-1', localAccountId: 'me@host', name: 'Personal', isDefault: true },
        ],
      });
      const client = makeClient();

      await useContactStore.getState().createContact(
        client as unknown as IJMAPClient,
        { addressBookIds: { 'me@host::ab-1': true } },
      );

      expect(useContactStore.getState().contacts[0]).toMatchObject({
        id: 'me@host::created-id', originalId: 'created-id', localAccountId: 'me@host',
        addressBookIds: { 'me@host::ab-1': true },
      });
    });

    it('moves to a namespaced personal book with the raw id and keeps the display id locally', async () => {
      const target = { id: 'me@host::ab-2', originalId: 'ab-2', localAccountId: 'me@host', name: 'Work' };
      useContactStore.setState({
        addressBooks: [
          { id: 'me@host::ab-1', originalId: 'ab-1', localAccountId: 'me@host', name: 'Personal', isDefault: true },
          target,
        ],
        contacts: [makeContact({
          id: 'me@host::c-1',
          originalId: 'c-1',
          localAccountId: 'me@host',
          addressBookIds: { 'me@host::ab-1': true },
        })],
      });
      const client = makeClient();

      await useContactStore.getState().moveContactToAddressBook(
        client as unknown as IJMAPClient,
        ['me@host::c-1'],
        target,
      );

      expect(client.updateContact).toHaveBeenCalledWith('c-1', { addressBookIds: { 'ab-2': true } }, undefined);
      expect(useContactStore.getState().contacts[0].addressBookIds).toEqual({ 'me@host::ab-2': true });
    });
  });

  describe('persistence/partialize', () => {
    it('should persist contacts when supportsSync is false', () => {
      const { partialize } = (useContactStore as unknown as { persist: { getOptions: () => { partialize: (state: Record<string, unknown>) => Record<string, unknown> } } }).persist.getOptions();
      const state = { contacts: [makeContact()], supportsSync: false };
      const persisted = partialize(state);
      expect(persisted.contacts).toHaveLength(1);
      expect(persisted.supportsSync).toBe(false);
    });

    it('should persist empty contacts array when supportsSync is true', () => {
      const { partialize } = (useContactStore as unknown as { persist: { getOptions: () => { partialize: (state: Record<string, unknown>) => Record<string, unknown> } } }).persist.getOptions();
      const state = { contacts: [makeContact()], supportsSync: true };
      const persisted = partialize(state);
      expect(persisted.contacts).toEqual([]);
      expect(persisted.supportsSync).toBe(true);
    });
  });

  describe('fetchDirectory', () => {
    const principal = (id: string, email: string | null, description?: string) =>
      ({ id, type: 'individual' as const, name: email ?? id, email, description });

    it('maps principals with an address to entries named by their description', async () => {
      const client = {
        supportsPrincipals: () => true,
        getPrincipals: vi.fn().mockResolvedValue([
          principal('a', 'ana@example.org', 'Ana Silva'),
          principal('b', null),
          principal('c', 'ANA@example.org', 'Duplicate'),
        ]),
      } as unknown as IJMAPClient;
      await useContactStore.getState().fetchDirectory(client);
      const state = useContactStore.getState();
      expect(state.directoryStatus).toBe('ready');
      expect(state.directoryPrincipals).toEqual([
        { id: 'a', name: 'Ana Silva', email: 'ana@example.org', description: 'Ana Silva', type: 'individual' },
      ]);
    });

    it('marks a refused query as forbidden, not as an empty directory', async () => {
      // JMAPClient.listPrincipals reports Principal/query's `forbidden` so.
      const client = {
        supportsPrincipals: () => true,
        getPrincipals: vi.fn(),
        listPrincipals: vi.fn().mockResolvedValue({ status: 'restricted', principals: [] }),
      } as unknown as IJMAPClient;
      await useContactStore.getState().fetchDirectory(client);
      expect(useContactStore.getState().directoryStatus).toBe('forbidden');
    });

    it('keeps the last list when a refresh fails', async () => {
      useContactStore.setState({ directoryPrincipals: [{ name: 'Ana', email: 'ana@example.org' }], directoryStatus: 'ready' });
      const client = {
        supportsPrincipals: () => true,
        getPrincipals: vi.fn().mockRejectedValue(new PrincipalsRequestError(null, 'network down')),
      } as unknown as IJMAPClient;
      await useContactStore.getState().fetchDirectory(client);
      expect(useContactStore.getState().directoryStatus).toBe('error');
      expect(useContactStore.getState().directoryPrincipals).toHaveLength(1);
    });

    it('reports a server without principals as unavailable', async () => {
      const getPrincipals = vi.fn();
      const client = { supportsPrincipals: () => false, getPrincipals } as unknown as IJMAPClient;
      await useContactStore.getState().fetchDirectory(client);
      expect(useContactStore.getState().directoryStatus).toBe('unavailable');
      expect(getPrincipals).not.toHaveBeenCalled();
    });
  });
});
