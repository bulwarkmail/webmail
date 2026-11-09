import type { ContactCard } from '@/lib/jmap/types';
import { generateUUID } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { useContactStore } from '@/stores/contact-store';

/**
 * Saves an address from a message as a new contact: on the server when the
 * account syncs contacts, in this browser otherwise. True when it was saved.
 */
export async function addAddressToContacts(address: string, name?: string): Promise<boolean> {
  const { createContact, addLocalContact, supportsSync } = useContactStore.getState();
  const client = useAuthStore.getState().client;
  const contactData: Partial<ContactCard> = {
    emails: { email: { address } },
    // `full` feeds the mandatory vCard FN — strict CardDAV clients
    // (Apple Contacts) drop cards without it (#430).
    ...(name ? { name: { components: name.includes(' ')
      ? [{ kind: 'given' as const, value: name.split(' ')[0] }, { kind: 'surname' as const, value: name.split(' ').slice(1).join(' ') }]
      : [{ kind: 'given' as const, value: name }],
      isOrdered: true, full: name,
    }} : {}),
  };
  const created = client && supportsSync
    ? await createContact(client, contactData)
    : await addLocalContact({ id: `local-${generateUUID()}`, addressBookIds: {}, ...contactData } as ContactCard);
  return !!created;
}
