"use client";

import { useMemo } from "react";
import { IMPORTED_KEYWORD, brandIndicatorDomain, isImportedMessage } from "@/lib/email-headers";
import { useInternalMailDomains } from "@/components/email/external-sender-chip";
import type { Email } from "@/lib/jmap/types";

/**
 * The From domain whose BIMI logo a message may show (see
 * brandIndicatorDomain): one it passed DMARC for on receipt, or one of the
 * organisation's own when the message was handed in on the same server.
 * Nothing for a message from an imported file.
 */
export function useBrandDomain(
  email: (Pick<Email, "from" | "authenticationResults" | "authenticationResultsOnReceipt" | "sourceClientAccountId"> & Partial<Pick<Email, "keywords">>) | null | undefined,
): string | undefined {
  const from = email?.from;
  const authenticationResults = email?.authenticationResults;
  const authenticationResultsOnReceipt = email?.authenticationResultsOnReceipt;
  const imported = isImportedMessage(email ?? undefined);
  // Only mail without the header goes by the organisation's domains; the rest
  // costs no lookup of another account's identities.
  const internalDomains = useInternalMailDomains(email?.sourceClientAccountId, !!from?.[0]?.email && !authenticationResults);
  return useMemo(
    () => brandIndicatorDomain(
      { from, authenticationResults, authenticationResultsOnReceipt, keywords: imported ? { [IMPORTED_KEYWORD]: true } : undefined },
      internalDomains,
    ),
    [from, authenticationResults, authenticationResultsOnReceipt, imported, internalDomains],
  );
}
