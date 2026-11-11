"use client";

import { useMemo } from "react";
import { brandIndicatorDomain } from "@/lib/email-headers";
import { useInternalMailDomains } from "@/components/email/external-sender-chip";
import type { Email } from "@/lib/jmap/types";

/**
 * The From domain whose BIMI logo a message may show (see
 * brandIndicatorDomain): one it passed DMARC for, or one of the
 * organisation's own when the message was handed in on the same server.
 */
export function useBrandDomain(
  email: Pick<Email, "from" | "authenticationResults" | "sourceClientAccountId"> | null | undefined,
): string | undefined {
  const from = email?.from;
  const authenticationResults = email?.authenticationResults;
  // Only mail without the header goes by the organisation's domains; the rest
  // costs no lookup of another account's identities.
  const internalDomains = useInternalMailDomains(email?.sourceClientAccountId, !!from?.[0]?.email && !authenticationResults);
  return useMemo(
    () => brandIndicatorDomain({ from, authenticationResults }, internalDomains),
    [from, authenticationResults, internalDomains],
  );
}
