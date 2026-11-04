"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Email } from "@/lib/jmap/types";
import type { EmailBlobContext } from "@/stores/email-store";
import { emailHooks } from "@/lib/plugin-hooks";

export interface ViewConversation {
  /** Every message of the open message's conversation, oldest first; undefined while there is none. */
  emails: Email[] | undefined;
  /** The conversation is on its way. */
  pending: boolean;
  /** Fetches a folded message's body when it unfolds. */
  loadBody: (target: Email) => Promise<Email | null>;
  /** An unfolded message was read. */
  markRead: (target: Email) => Promise<void>;
}

/**
 * The conversation around a message read outside the mail page (a message
 * window), fetched the way the mail page's reading pane fetches it: the
 * thread's ids, then their list properties, drafts left out except the open
 * one, oldest first. A conversation of one message is none.
 */
export function useViewConversation({ enabled, email, source, onChanged }: {
  enabled: boolean;
  email: Email | null;
  source: EmailBlobContext;
  onChanged?: () => void;
}): ViewConversation {
  const threadId = enabled ? email?.threadId ?? null : null;
  const openId = email?.id ?? null;
  const [result, setResult] = useState<{ threadId: string; emails: Email[] } | null>(null);
  const [pending, setPending] = useState(false);
  const seqRef = useRef(0);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    const seq = ++seqRef.current;
    const client = source.client;
    if (!threadId || !client) {
      setResult(null);
      setPending(false);
      return;
    }
    setPending(true);
    void (async () => {
      const thread = await client.getThread(threadId, source.accountId);
      const ids = thread?.emailIds ?? [];
      if (ids.length < 2) return null;
      const emails = await client.getSomeEmails(ids, source.accountId);
      return emails
        .filter((e) => e.id === openId || !e.keywords?.$draft)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    })().catch(() => null).then((emails) => {
      if (seq !== seqRef.current) return;
      setResult(emails && emails.length > 1 ? { threadId, emails } : null);
      setPending(false);
    });
  }, [threadId, openId, source.client, source.accountId]);

  const patch = useCallback((id: string, change: (e: Email) => Email) => {
    setResult((prev) => (prev ? { ...prev, emails: prev.emails.map((e) => (e.id === id ? change(e) : e)) } : prev));
  }, []);

  const loadBody = useCallback(async (target: Email) => {
    const client = source.client;
    if (!client) return null;
    const seq = seqRef.current;
    const full = await client.getEmail(target.id, source.accountId).catch(() => null);
    if (!full || seq !== seqRef.current) return null;
    patch(target.id, (e) => ({ ...full, keywords: e.keywords }));
    return full;
  }, [source.client, source.accountId, patch]);

  const markRead = useCallback(async (target: Email) => {
    const client = source.client;
    if (!client || target.keywords?.$seen) return;
    try {
      if (emailHooks.onBeforeEmailReadStateChange.size > 0
        && !(await emailHooks.onBeforeEmailReadStateChange.intercept({ emailIds: [target.id], read: true }))) {
        return;
      }
      await client.markAsRead(target.id, true, source.accountId);
      void emailHooks.onEmailReadStateChange.emit({ emailIds: [target.id], read: true });
      patch(target.id, (e) => ({ ...e, keywords: { ...e.keywords, $seen: true } }));
      onChangedRef.current?.();
    } catch (error) {
      console.error("Failed to mark conversation message read:", error);
    }
  }, [source.client, source.accountId, patch]);

  return {
    emails: result && result.threadId === threadId ? result.emails : undefined,
    pending: pending && !!threadId,
    loadBody,
    markRead,
  };
}
