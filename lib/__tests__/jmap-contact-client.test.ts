import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

const mockContact = {
  id: 'contact-1',
  addressBookIds: { 'ab-1': true },
  name: { components: [{ kind: 'given' as const, value: 'John' }, { kind: 'surname' as const, value: 'Doe' }], isOrdered: true },
  emails: { e0: { address: 'john@example.com' } },
};

const mockAddressBook = {
  id: 'ab-1',
  name: 'Default',
  isDefault: true,
};

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'account-1',
  });
  return client;
}

function mockFetch(response: object, ok = true, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  } as Response);
}

function mockFetchOnce(spy: ReturnType<typeof vi.spyOn>, response: object) {
  spy.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  } as Response);
  return spy;
}

describe('JMAPClient contact methods', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('supportsContacts', () => {
    it('should return true when contacts capability exists', () => {
      const client = createClient();
      Object.assign(client, { capabilities: { 'urn:ietf:params:jmap:contacts': {} } });
      expect(client.supportsContacts()).toBe(true);
    });

    it('should return false when contacts capability is missing', () => {
      const client = createClient();
      Object.assign(client, { capabilities: {} });
      expect(client.supportsContacts()).toBe(false);
    });

    it('should throw when capabilities is undefined', () => {
      const client = createClient();
      Object.assign(client, { capabilities: undefined });
      expect(() => client.supportsContacts()).toThrow();
    });
  });

  describe('getAddressBooks', () => {
    it('should return address books from server', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['AddressBook/get', { list: [mockAddressBook] }, '0']],
      });

      const result = await client.getAddressBooks();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('ab-1');
      expect(result[0].name).toBe('Default');
    });

    it('should return empty array when no address books', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['AddressBook/get', { list: [] }, '0']],
      });

      const result = await client.getAddressBooks();
      expect(result).toEqual([]);
    });

    it('should return empty array on network error', async () => {
      const client = createClient();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await client.getAddressBooks();
      expect(result).toEqual([]);
    });

    it('should return empty array for unexpected response method', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['SomethingElse', {}, '0']],
      });

      const result = await client.getAddressBooks();
      expect(result).toEqual([]);
    });

    it('should return empty array when list is missing', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['AddressBook/get', {}, '0']],
      });

      const result = await client.getAddressBooks();
      expect(result).toEqual([]);
    });
  });

  describe('getContacts', () => {
    it('should return contacts from server', async () => {
      const client = createClient();
      const spy = vi.spyOn(globalThis, 'fetch');
      mockFetchOnce(spy, {
        methodResponses: [
          ['ContactCard/query', { ids: ['contact-1'] }, 'q'],
        ],
      });
      mockFetchOnce(spy, {
        methodResponses: [
          ['ContactCard/get', { list: [mockContact] }, 'g'],
        ],
      });

      const result = await client.getContacts();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('contact-1');
    });

    it('should filter by addressBookId when provided', async () => {
      const client = createClient();
      const fetchSpy = mockFetch({
        methodResponses: [
          ['ContactCard/query', { ids: ['contact-1'] }, '0'],
          ['ContactCard/get', { list: [mockContact] }, '1'],
        ],
      });

      await client.getContacts('ab-1');

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.methodCalls[0][1].filter).toEqual({ inAddressBook: 'ab-1' });
    });

    it('should not include filter when no addressBookId', async () => {
      const client = createClient();
      const fetchSpy = mockFetch({
        methodResponses: [
          ['ContactCard/query', { ids: [] }, '0'],
          ['ContactCard/get', { list: [] }, '1'],
        ],
      });

      await client.getContacts();

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.methodCalls[0][1].filter).toBeUndefined();
    });

    it('should return empty array when no contacts', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [
          ['ContactCard/query', { ids: [] }, '0'],
          ['ContactCard/get', { list: [] }, '1'],
        ],
      });

      const result = await client.getContacts();
      expect(result).toEqual([]);
    });

    it('should return empty array on network error', async () => {
      const client = createClient();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await client.getContacts();
      expect(result).toEqual([]);
    });

    it('should return empty array for unexpected response at index 1', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [
          ['ContactCard/query', { ids: [] }, '0'],
          ['SomethingElse', {}, '1'],
        ],
      });

      const result = await client.getContacts();
      expect(result).toEqual([]);
    });
  });

  describe('getContact', () => {
    it('should return a single contact', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['ContactCard/get', { list: [mockContact] }, '0']],
      });

      const result = await client.getContact('contact-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('contact-1');
    });

    it('should pass contact id in the request', async () => {
      const client = createClient();
      const fetchSpy = mockFetch({
        methodResponses: [['ContactCard/get', { list: [mockContact] }, '0']],
      });

      await client.getContact('contact-1');

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.methodCalls[0][1].ids).toEqual(['contact-1']);
    });

    it('should return null when contact not found', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['ContactCard/get', { list: [] }, '0']],
      });

      const result = await client.getContact('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
      const client = createClient();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await client.getContact('contact-1');
      expect(result).toBeNull();
    });

    it('should return null for unexpected response method', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['SomethingElse', {}, '0']],
      });

      const result = await client.getContact('contact-1');
      expect(result).toBeNull();
    });
  });

  describe('createContact', () => {
    it('should create contact and refetch full object', async () => {
      const client = createClient();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      // 1: getAddressBooks
      mockFetchOnce(fetchSpy, {
        methodResponses: [['AddressBook/get', { list: [mockAddressBook] }, '0']],
      });
      // 2: ContactCard/set
      mockFetchOnce(fetchSpy, {
        methodResponses: [['ContactCard/set', { created: { 'new-contact': { id: 'new-id' } } }, '0']],
      });
      // 3: getContact refetch
      mockFetchOnce(fetchSpy, {
        methodResponses: [['ContactCard/get', { list: [{ ...mockContact, id: 'new-id' }] }, '0']],
      });

      const result = await client.createContact({ name: mockContact.name, emails: mockContact.emails });
      expect(result.id).toBe('new-id');
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('should skip getAddressBooks when addressBookIds provided', async () => {
      const client = createClient();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      // 1: ContactCard/set (no getAddressBooks needed)
      mockFetchOnce(fetchSpy, {
        methodResponses: [['ContactCard/set', { created: { 'new-contact': { id: 'new-id' } } }, '0']],
      });
      // 2: getContact refetch
      mockFetchOnce(fetchSpy, {
        methodResponses: [['ContactCard/get', { list: [{ ...mockContact, id: 'new-id' }] }, '0']],
      });

      const result = await client.createContact({
        name: mockContact.name,
        addressBookIds: { 'ab-1': true },
      });
      expect(result.id).toBe('new-id');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should throw on notCreated error with description', async () => {
      const client = createClient();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      mockFetchOnce(fetchSpy, {
        methodResponses: [['AddressBook/get', { list: [mockAddressBook] }, '0']],
      });
      mockFetchOnce(fetchSpy, {
        methodResponses: [['ContactCard/set', {
          notCreated: { 'new-contact': { type: 'invalidProperties', description: 'Missing required fields' } },
        }, '0']],
      });

      await expect(client.createContact({ name: mockContact.name }))
        .rejects.toThrow('Missing required fields');
    });

    it('should throw generic error when notCreated has no description', async () => {
      const client = createClient();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      mockFetchOnce(fetchSpy, {
        methodResponses: [['AddressBook/get', { list: [mockAddressBook] }, '0']],
      });
      mockFetchOnce(fetchSpy, {
        methodResponses: [['ContactCard/set', {
          notCreated: { 'new-contact': { type: 'forbidden' } },
        }, '0']],
      });

      await expect(client.createContact({ name: mockContact.name }))
        .rejects.toThrow('Failed to create contact');
    });

    it('should throw on unexpected response method', async () => {
      const client = createClient();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      mockFetchOnce(fetchSpy, {
        methodResponses: [['AddressBook/get', { list: [mockAddressBook] }, '0']],
      });
      mockFetchOnce(fetchSpy, {
        methodResponses: [['SomethingElse', {}, '0']],
      });

      await expect(client.createContact({ name: mockContact.name }))
        .rejects.toThrow('Failed to create contact');
    });

    it('should throw when created id is missing', async () => {
      const client = createClient();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      mockFetchOnce(fetchSpy, {
        methodResponses: [['AddressBook/get', { list: [mockAddressBook] }, '0']],
      });
      mockFetchOnce(fetchSpy, {
        methodResponses: [['ContactCard/set', { created: {} }, '0']],
      });

      await expect(client.createContact({ name: mockContact.name }))
        .rejects.toThrow('Failed to create contact');
    });

    it('should throw when refetch returns null', async () => {
      const client = createClient();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      mockFetchOnce(fetchSpy, {
        methodResponses: [['AddressBook/get', { list: [mockAddressBook] }, '0']],
      });
      mockFetchOnce(fetchSpy, {
        methodResponses: [['ContactCard/set', { created: { 'new-contact': { id: 'new-id' } } }, '0']],
      });
      mockFetchOnce(fetchSpy, {
        methodResponses: [['ContactCard/get', { list: [] }, '0']],
      });

      await expect(client.createContact({ name: mockContact.name }))
        .rejects.toThrow('Failed to create contact');
    });
  });

  describe('updateContact', () => {
    it('should update contact successfully', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['ContactCard/set', { updated: { 'contact-1': null } }, '0']],
      });

      await expect(client.updateContact('contact-1', { name: mockContact.name })).resolves.toBeUndefined();
    });

    it('should pass updates in the request body', async () => {
      const client = createClient();
      const fetchSpy = mockFetch({
        methodResponses: [['ContactCard/set', { updated: { 'contact-1': null } }, '0']],
      });

      const updates = { name: { components: [{ kind: 'given' as const, value: 'Jane' }], isOrdered: true } };
      await client.updateContact('contact-1', updates);

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.methodCalls[0][1].update['contact-1']).toEqual(updates);
    });

    it('should throw on notUpdated error with description', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['ContactCard/set', {
          notUpdated: { 'contact-1': { type: 'notFound', description: 'Contact not found' } },
        }, '0']],
      });

      await expect(client.updateContact('contact-1', { name: mockContact.name }))
        .rejects.toThrow('Contact not found');
    });

    it('should throw generic error when notUpdated has no description', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['ContactCard/set', {
          notUpdated: { 'contact-1': { type: 'forbidden' } },
        }, '0']],
      });

      await expect(client.updateContact('contact-1', { name: mockContact.name }))
        .rejects.toThrow('Failed to update contact');
    });

    it('should throw on unexpected response method', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['SomethingElse', {}, '0']],
      });

      await expect(client.updateContact('contact-1', { name: mockContact.name }))
        .rejects.toThrow('Failed to update contact');
    });
  });

  describe('deleteContact', () => {
    it('should delete contact successfully', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['ContactCard/set', { destroyed: ['contact-1'] }, '0']],
      });

      await expect(client.deleteContact('contact-1')).resolves.toBeUndefined();
    });

    it('should pass contact id in destroy array', async () => {
      const client = createClient();
      const fetchSpy = mockFetch({
        methodResponses: [['ContactCard/set', { destroyed: ['contact-1'] }, '0']],
      });

      await client.deleteContact('contact-1');

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.methodCalls[0][1].destroy).toEqual(['contact-1']);
    });

    it('should throw on notDestroyed error with description', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['ContactCard/set', {
          notDestroyed: { 'contact-1': { type: 'notFound', description: 'Contact not found' } },
        }, '0']],
      });

      await expect(client.deleteContact('contact-1'))
        .rejects.toThrow('Contact not found');
    });

    it('should throw generic error when notDestroyed has no description', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['ContactCard/set', {
          notDestroyed: { 'contact-1': { type: 'forbidden' } },
        }, '0']],
      });

      await expect(client.deleteContact('contact-1'))
        .rejects.toThrow('Failed to delete contact');
    });

    it('should throw on unexpected response method', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [['SomethingElse', {}, '0']],
      });

      await expect(client.deleteContact('contact-1'))
        .rejects.toThrow('Failed to delete contact');
    });
  });

  describe('searchContacts', () => {
    it('should return matching contacts', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [
          ['ContactCard/query', { ids: ['contact-1'] }, '0'],
          ['ContactCard/get', { list: [mockContact] }, '1'],
        ],
      });

      const result = await client.searchContacts('John');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('contact-1');
    });

    it('should pass query as text filter', async () => {
      const client = createClient();
      const fetchSpy = mockFetch({
        methodResponses: [
          ['ContactCard/query', { ids: [] }, '0'],
          ['ContactCard/get', { list: [] }, '1'],
        ],
      });

      await client.searchContacts('Jane');

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.methodCalls[0][1].filter).toEqual({ text: 'Jane' });
    });

    it('should return empty array when no results', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [
          ['ContactCard/query', { ids: [] }, '0'],
          ['ContactCard/get', { list: [] }, '1'],
        ],
      });

      const result = await client.searchContacts('nonexistent');
      expect(result).toEqual([]);
    });

    it('should return empty array on network error', async () => {
      const client = createClient();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await client.searchContacts('John');
      expect(result).toEqual([]);
    });

    it('should return empty array for unexpected response at index 1', async () => {
      const client = createClient();
      mockFetch({
        methodResponses: [
          ['ContactCard/query', { ids: [] }, '0'],
          ['SomethingElse', {}, '1'],
        ],
      });

      const result = await client.searchContacts('John');
      expect(result).toEqual([]);
    });
  });
});
