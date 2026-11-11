"use client";

import { useMemo } from "react";
import { IMPORTED_KEYWORD, authenticationResultsUsable, brandIndicatorDomain, isImportedMessage } from "@/lib/email-headers";
import { useInternalMailDomains } from "@/components/email/external-sender-chip";
import type { Email } from "@/lib/jmap/types";

/**
 * The From domain whose BIMI logo a message may show (see
 * brandIndicatorDomain): one it passed DMARC for on receipt, or one of the
 * organisation's own when the message was handed in on the same server.
 * Nothing for a message from an imported file, or one that does not show its
 * results were written on receipt (authenticationResultsUsable): a list row,
 * a search result.
 */
export function useBrandDomain(
  email: (Pick<Email, "from" | "authenticationResults" | "authenticationResultsOnReceipt" | "sourceClientAccountId"> & Partial<Pick<Email, "keywords" | "headers">>) | null | undefined,
): string | undefined {
  const from = email?.from;
  const authenticationResults = email?.authenticationResults;
  const imported = isImportedMessage(email ?? undefined);
  const flag = email?.authenticationResultsOnReceipt;
  const headers = email?.headers;
  // Worked out from the flag or the headers in message order, as the cards do.
  const authenticationResultsOnReceipt = useMemo(
    () => authenticationResultsUsable({ authenticationResultsOnReceipt: flag, headers }),
    [flag, headers],
  );
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
