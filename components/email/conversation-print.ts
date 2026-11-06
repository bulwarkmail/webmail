"use client";

import { useEffect, useRef } from "react";
import type { MessagePrintFields } from "./message-print";
import { printMessageInWindow, type MessagePrintWindowOptions } from "./message-print-window";

/**
 * One message of a conversation as it can be printed: its body as the
 * conversation shows it (decrypted, inline images, remote content as
 * allowed), and its account's device policy.
 */
export interface ConversationPrintSource {
  fields: MessagePrintFields;
  externalBlocked: boolean;
  watermark: string | null;
  noPrint: boolean;
}

/**
 * The unfolded messages of the conversations on screen, by email id. A
 * message's body registers itself while it is mounted, so Print in its ⋮
 * and Ctrl+P while it has the focus print exactly what it shows.
 */
const sources = new Map<string, () => ConversationPrintSource | null>();

/** Registers the body of an unfolded conversation message while it is mounted. */
export function useConversationPrintSource(emailId: string, get: () => ConversationPrintSource | null): void {
  const latest = useRef(get);
  latest.current = get;
  useEffect(() => {
    const read = () => latest.current();
    sources.set(emailId, read);
    return () => {
      if (sources.get(emailId) === read) sources.delete(emailId);
    };
  }, [emailId]);
}

export function conversationPrintSource(emailId: string | null | undefined): ConversationPrintSource | null {
  if (!emailId) return null;
  return sources.get(emailId)?.() ?? null;
}

/** The marker on an unfolded conversation message: its email id. */
export const CONVERSATION_MESSAGE_ATTR = "data-conversation-message";

/**
 * The conversation message that has the focus (a click in it, its body's
 * frame, a button of its own), inside `root` when given.
 */
export function focusedConversationMessageId(root?: Element | null): string | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  const message = active.closest(`[${CONVERSATION_MESSAGE_ATTR}]`);
  if (!message || (root && !root.contains(message))) return null;
  return message.getAttribute(CONVERSATION_MESSAGE_ATTR) || null;
}

/**
 * Print in a conversation message's ⋮: that message alone, in the same
 * window and layout as the reader's own Print. False when it can't (its
 * body isn't loaded, or its account doesn't allow printing).
 */
export function printConversationMessage(emailId: string, labels: MessagePrintWindowOptions["labels"]): boolean {
  const source = conversationPrintSource(emailId);
  if (!source || source.noPrint) return false;
  printMessageInWindow(source.fields, {
    externalBlocked: source.externalBlocked,
    watermark: source.watermark,
    labels,
  });
  return true;
}

/** The printout's labels, from the reader's words (`email_viewer.*`). */
export function printLabels(t: (key: "from" | "to" | "cc" | "date" | "attachments") => string): MessagePrintWindowOptions["labels"] {
  return { from: t("from"), to: t("to"), cc: t("cc"), date: t("date"), attachments: t("attachments") };
}
