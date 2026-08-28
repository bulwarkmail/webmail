"use client";

import { useMemo } from "react";
import { useContactStore, getContactDisplayName } from "@/stores/contact-store";
import type { ContactCard } from "@/lib/jmap/types";

/**
 * Build an email → display-name lookup from contact cards. The first contact
 * holding an address wins; cards with no resolvable name contribute nothing,
 * so whatever name the event itself carries always stays authoritative and
 * the contact card is a pure fallback for bare addresses.
 */
export function buildContactNameResolver(
  contacts: ReadonlyArray<ContactCard>
): (email: string) => string | undefined {
  const namesByEmail = new Map<string, string>();
  for (const contact of contacts) {
    const name = getContactDisplayName(contact).trim();
    if (!name || !contact.emails) continue;
    // getContactDisplayName falls back to the first email address, so a card
    // whose "name" is just one of its addresses has nothing to add over the
    // bare address every renderer already shows.
    const nameIsJustAnAddress = Object.values(contact.emails).some(
      (e) => e.address?.trim().toLowerCase() === name.toLowerCase()
    );
    if (nameIsJustAnAddress) continue;
    for (const { address } of Object.values(contact.emails)) {
      const key = address?.trim().toLowerCase();
      if (key && !namesByEmail.has(key)) namesByEmail.set(key, name);
    }
  }
  return (email: string) => {
    const key = email?.trim().toLowerCase();
    return key ? namesByEmail.get(key) : undefined;
  };
}

/**
 * Participant rows (calendar, and any address-rendering UI) show a contact's
 * display name — e.g. its 备注 name — when the event data itself carries only
 * a bare address. Memoised on the contact list, so it recomputes only when
 * contacts actually change.
 */
export function useContactNameResolver(): (email: string) => string | undefined {
  const contacts = useContactStore((s) => s.contacts);
  return useMemo(() => buildContactNameResolver(contacts), [contacts]);
}
