import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContactStore } from '../contact-store';
import { setClientLookup } from '../client-registry';
import type { ContactCard } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// A group made from another login's cards, afterwards: renaming it, removing
// a member and deleting it go to that login too, under its raw id. And a
// member id that is no longer listed never decides the login.

function makeClient(created: string) {
  return {
    createContact: vi.fn(async (card: Partial<ContactCard>) => ({ ...card, id: created, addressBookIds: { b: true } }) as ContactCard),
    updateContact: vi.fn(async () => {}),
    deleteContact: vi.fn(async () => {}),
  };
}
const card = (login: string, id: string, uid: string) => ({
  id: `${login}::${id}`, originalId: id, localAccountId: login, uid, kind: 'individual',
  name: { full: uid }, addressBookIds: { [`${login}::b`]: true },
}) as unknown as ContactCard;
const initial = useContactStore.getState();

describe('a contact group of another login, after it was made', () => {
  let a: ReturnType<typeof makeClient>;
  let b: ReturnType<typeof makeClient>;
  const asA = () => a as unknown as IJMAPClient;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    a = makeClient('ga');
    b = makeClient('gb');
    setClientLookup((id) => (id === 'login-a' ? a : id === 'login-b' ? b : undefined) as unknown as IJMAPClient);
    useContactStore.setState({
      supportsSync: true,
      contacts: [card('login-a', 'c', 'urn:uuid:a-1'), card('login-b', 'c', 'urn:uuid:b-1'), card('login-b', 'd', 'urn:uuid:b-2')],
    } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    useContactStore.setState(initial);
    setClientLookup(() => undefined);
  });

  it('is renamed, loses a member and is deleted through its own login', async () => {
    const store = () => useContactStore.getState();
    await store().createGroup(asA(), 'B team', ['login-b::c', 'login-b::d']);
    const group = store().contacts.find((c) => c.kind === 'group')!;
    expect(group.id).toBe('login-b::gb');

    await store().updateGroup(asA(), group.id, 'B team 2');
    await store().removeMembersFromGroup(asA(), group.id, ['login-b::d']);
    await store().deleteGroup(asA(), group.id);

    expect(a.updateContact).not.toHaveBeenCalled();
    expect(a.deleteContact).not.toHaveBeenCalled();
    expect(b.updateContact.mock.calls.map((call: unknown[]) => call[0])).toEqual(['gb', 'gb']);
    expect(b.deleteContact.mock.calls.map((call: unknown[]) => call[0])).toEqual(['gb']);
  });

  it('a member that is no longer listed does not send the group to the active login', async () => {
    // `login-b::x` left the list (deleted elsewhere) while the form was open.
    let refused = false;
    try {
      await useContactStore.getState().createGroup(asA(), 'B team', ['login-b::c', 'login-b::x'], 'login-a');
    } catch {
      refused = true;
    }
    expect(a.createContact).not.toHaveBeenCalled();
    // Refused, or made in login B, where the listed member is.
    expect(refused || b.createContact.mock.calls.length === 1).toBe(true);
  });

  it('members that are all gone from the list are not made into a group of the active login by their ids', async () => {
    try {
      await useContactStore.getState().createGroup(asA(), 'B team', ['login-b::x', 'login-b::y'], 'login-a');
    } catch { /* refusing is fine */ }
    const made = a.createContact.mock.calls.map((call: unknown[]) => Object.keys((call[0] as ContactCard).members ?? {}));
    // If it is made in login A at all, it holds none of login B's ids.
    expect(made.flat().filter((key) => key.startsWith('login-b::'))).toEqual([]);
  });

  it('a member added to it that is no longer listed is refused, and nothing is written', async () => {
    const store = () => useContactStore.getState();
    await store().createGroup(asA(), 'B team', ['login-b::c']);
    const group = store().contacts.find((c) => c.kind === 'group')!;
    await expect(store().addMembersToGroup(asA(), group.id, ['login-b::x'])).rejects.toThrow();
    expect(a.updateContact).not.toHaveBeenCalled();
    expect(b.updateContact).not.toHaveBeenCalled();
  });
});
