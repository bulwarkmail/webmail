"use client";

import { useCallback, useMemo } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { toUnicodeEmailOnOwnDomains } from "@/lib/idn";

/**
 * Formats an address from a message for display: on one of the signed-in
 * user's own IDN domains it reads as written (`bücher.de`), anywhere else it
 * stays as the message has it (see toUnicodeEmailOnOwnDomains, #1100).
 */
export function useOwnDomainAddress(): (address: string) => string {
  const username = useAuthStore((s) => s.username);
  const identities = useAuthStore((s) => s.identities);
  const ownAddresses = useMemo(
    () => [username, ...(identities ?? []).map((i) => i.email)],
    [username, identities],
  );
  return useCallback(
    (address: string) => toUnicodeEmailOnOwnDomains(address, ownAddresses),
    [ownAddresses],
  );
}
