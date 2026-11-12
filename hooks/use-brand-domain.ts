"use client";

import { useEffect, useMemo } from "react";
import { IMPORTED_KEYWORD, authenticationResultsEvidence, brandIndicatorDomain, isImportedMessage } from "@/lib/email-headers";
import { useInternalMailDomains } from "@/components/email/external-sender-chip";
import { receiptAnswerKey, useReceiptAnswers, type ReceiptAnswerAccount } from "@/lib/receipt-answers";
import type { Email } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";

/**
 * The From domain whose BIMI logo a message may show (see
 * brandIndicatorDomain): one it passed DMARC for on receipt, or one of the
 * organisation's own when the message was handed in on the same server.
 * Nothing for a message from an imported file, or one that does not show its
 * results were written on receipt (authenticationResultsEvidence). A list row
 * or a search result shows none by itself; it borrows the answer the full
 * message gave when it was shown (lib/receipt-answers.ts), and a message
 * shown in full with results written on receipt leaves that answer there.
 * Answers are kept per login and JMAP account: the ones a message is stamped
 * with in a list that mixes accounts, else the login on screen (the viewed or
 * the active one) when the hook first sees the message, with its own account.
 */
export function useBrandDomain(
  email: (Pick<Email, "from" | "authenticationResults" | "authenticationResultsOnReceipt" | "sourceClientAccountId"> & Partial<Pick<Email, "keywords" | "headers" | "blobId" | "size" | "sourceAccountId">>) | null | undefined,
): string | undefined {
  const from = email?.from;
  const authenticationResults = email?.authenticationResults;
  const imported = isImportedMessage(email ?? undefined);
  const flag = email?.authenticationResultsOnReceipt;
  const headers = email?.headers;
  // Worked out from the flag or the headers in message order, as the cards do.
  const evidence = useMemo(() => authenticationResultsEvidence({ authenticationResultsOnReceipt: flag, headers }), [flag, headers]);
  const viewingLogin = useEmailStore((state) => state.viewingAccountId);
  const activeLogin = useAuthStore((state) => state.activeAccountId);
  // Taken again only for another message: one still on screen keeps its login and account
  // when another login is opened meanwhile, and leaves no answer under that one.
  const blobId = email?.blobId;
  const size = email?.size;
  const sourceLogin = email?.sourceClientAccountId;
  const sourceAccount = email?.sourceAccountId;
  const account = useMemo<ReceiptAnswerAccount>(
    () => ({ login: sourceLogin ?? viewingLogin ?? activeLogin ?? "", accountId: sourceAccount ?? "" }),
    [blobId, size, sourceLogin, sourceAccount], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const answerKey = receiptAnswerKey(email, account);
  // Only a message with nothing of its own to go by borrows an answer.
  const remembered = useReceiptAnswers((state) => evidence === undefined && answerKey !== null && state.known.has(answerKey));
  const remember = useReceiptAnswers((state) => state.remember);
  useEffect(() => {
    if (evidence === true && answerKey && !imported) remember(answerKey);
  }, [evidence, answerKey, imported, remember]);
  const authenticationResultsOnReceipt = evidence ?? remembered;
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
