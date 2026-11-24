"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Email } from "@/lib/jmap/types";
import { avatarHooks } from "@/lib/plugin-hooks";
import { emailSummary } from "@/lib/plugin-projection";
import {
  cachedSender, resolveSender, senderCacheKey, senderGeneration, subscribeSenderResolve, type ResolvedSender,
} from "@/lib/plugin-sandbox/sender-resolve";
import { useRowSource } from "@/components/email/plugin-row-badges";

/**
 * The sender a plugin shows for this message in place of its From
 * (onSenderResolve, #633), or null: none answered, or no plugin listens.
 * For what the user sees only; anything that acts on the sender keeps
 * reading From.
 */
export function usePluginSender(email: Email | null | undefined): ResolvedSender | null {
  const listening = avatarHooks.onSenderResolve.size > 0;
  // The generation moves on when a handler comes or goes.
  useSyncExternalStore(subscribeSenderResolve, senderGeneration, senderGeneration);
  const source = useRowSource(email ?? EMPTY, listening && !!email);
  const key = listening && email?.from?.[0] ? senderCacheKey(email, source) : null;
  const [answer, setAnswer] = useState<{ key: string | null; sender: ResolvedSender | null }>(() => ({
    key,
    sender: key ? cachedSender(key) ?? null : null,
  }));

  useEffect(() => {
    if (!key || !email) return;
    let cancelled = false;
    void resolveSender(key, () => avatarHooks.onSenderResolve.transform(null, { email: emailSummary(email) }))
      .then((sender) => { if (!cancelled) setAnswer({ key, sender }); });
    return () => { cancelled = true; };
    // `key` covers the parts of the email the answer depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return null;
  return answer.key === key ? answer.sender : cachedSender(key) ?? null;
}

const EMPTY = { id: "" } as Email;
