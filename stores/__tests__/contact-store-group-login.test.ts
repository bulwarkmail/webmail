import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContactStore } from '../contact-store';
import { setClientLookup } from '../client-registry';
import type { ContactCard } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// With several logins the contacts list holds every login's cards under
// `<login>::<id>`. A group lists its members by their uids, which name cards
// of one login only: a group made from login B's cards is created in login B
// and kept under B's prefix, like every other card of B. Members from two
// logins can't be in one group.

function makeClient(created: string) {
  return {
    createContact: vi.fn(async (card: Partial<ContactCard>) => ({ ...card, id: created, addressBookIds: { b: true } }) as ContactCard),
    updateContact: vi.fn(async () => {}),
  };
}

const card = (login: string, id: string, uid: string) => ({
  id: `${login}::${id}`, originalId: id, localAccountId: login, uid, kind: 'individual',
  name: { full: uid }, addressBookIds: { [`${login}::b`]: true },
}) as unknown as ContactCard;

const initial = useContactStore.getState();

describe('a contact group made in a list of several logins', () => {
  let a: ReturnType<typeof makeClient>;
  let b: ReturnType<typeof makeClient>;

  beforeEach(() => {
    a = makeClient('ga');
    b = makeClient('gb');
    setClientLookup((id) => (id === 'login-a' ? a : id === 'login-b' ? b : undefined) as unknown as IJMAPClient);
    useContactStore.setState({
      supportsSync: true,
      contacts: [card('login-a', 'c', 'urn:uuid:a-1'), card('login-b', 'c', 'urn:uuid:b-1'), card('login-b', 'd', 'urn:uuid:b-2')],
    } as never);
  });

  afterEach(() => {
    useContactStore.setState(initial);
    setClientLookup(() => undefined);
  });

  it('is created through the login of its members and kept under its prefix', async () => {
    await useContactStore.getState().createGroup(a as unknown as IJMAPClient, 'B team', ['login-b::c', 'login-b::d']);

    expect(a.createContact).not.toHaveBeenCalled();
    expect(b.createContact).toHaveBeenCalledTimes(1);
    expect(b.createContact.mock.calls[0][0]).toMatchObject({ kind: 'group', members: { 'urn:uuid:b-1': true, 'urn:uuid:b-2': true } });
    const group = useContactStore.getState().contacts.find((c) => c.kind === 'group');
    expect(group).toMatchObject({ id: 'login-b::gb', originalId: 'gb', localAccountId: 'login-b' });
  });

  it('with members of two logins is refused, and nothing is created', async () => {
    await expect(useContactStore.getState().createGroup(a as unknown as IJMAPClient, 'Mixed', ['login-a::c', 'login-b::c']))
      .rejects.toThrow();
    expect(a.createContact).not.toHaveBeenCalled();
    expect(b.createContact).not.toHaveBeenCalled();
    expect(useContactStore.getState().contacts.some((c) => c.kind === 'group')).toBe(false);
  });

  it('without members goes to the login the caller names', async () => {
    await useContactStore.getState().createGroup(a as unknown as IJMAPClient, 'Empty', [], 'login-a');

    expect(a.createContact).toHaveBeenCalledTimes(1);
    expect(useContactStore.getState().contacts.find((c) => c.kind === 'group')).toMatchObject({ id: 'login-a::ga', localAccountId: 'login-a' });
  });

  it('takes no member of another login later either', async () => {
    const group = { id: 'login-b::g', originalId: 'g', localAccountId: 'login-b', kind: 'group', members: {}, addressBookIds: {} } as unknown as ContactCard;
    useContactStore.setState({ contacts: [...useContactStore.getState().contacts, group] } as never);
    await expect(useContactStore.getState().addMembersToGroup(a as unknown as IJMAPClient, 'login-b::g', ['login-a::c'])).rejects.toThrow();
    expect(a.updateContact).not.toHaveBeenCalled();
    expect(b.updateContact).not.toHaveBeenCalled();
    await useContactStore.getState().addMembersToGroup(a as unknown as IJMAPClient, 'login-b::g', ['login-b::d']);
    expect(b.updateContact).toHaveBeenCalledWith('g', { members: { 'urn:uuid:b-2': true } }, undefined);
  });

  it('of a login without a client is refused', async () => {
    useContactStore.setState({ contacts: [card('login-c', 'c', 'urn:uuid:c-1')] } as never);
    await expect(useContactStore.getState().createGroup(a as unknown as IJMAPClient, 'C team', ['login-c::c'])).rejects.toThrow('Not connected');
    expect(a.createContact).not.toHaveBeenCalled();
  });
});
