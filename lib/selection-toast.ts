import type { Email } from "@/lib/jmap/types";
import { threadKeyFor } from "@/lib/thread-utils";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * How many rows a selection covers, as the selection bar counts them:
 * conversations, or messages with conversations off. A conversation row ticks
 * every message of it the list holds, so the selected keys alone count too
 * many. `keyCount` is the number of selected keys, for keys no loaded message
 * stands behind.
 */
export function selectionRowCount(selected: readonly Email[], keyCount: number, disableThreading: boolean): number {
  if (disableThreading || selected.length === 0) return keyCount;
  return new Set(selected.map((email) => threadKeyFor(email))).size;
}

export type BatchToastAction = "archive" | "trash" | "delete" | "move";

/**
 * The toast after a batch action, counting what the bar counted (mail-18):
 * "5 conversations archived" under a bar that says "5 conversations".
 * `t` is the root translator.
 */
export function batchToastTitle(
  t: Translate,
  action: BatchToastAction,
  count: number,
  disableThreading: boolean,
  mailbox?: string,
): string {
  if (disableThreading) {
    if (action === "archive") return t("notifications.emails_archived", { count });
    if (action === "move") {
      return mailbox
        ? t("mail_list_extra.moved_count_to", { count, mailbox })
        : t("notifications.emails_moved", { count });
    }
    return t("notifications.emails_deleted", { count });
  }
  if (action === "archive") return t("mail_p2_list.conversations_archived", { count });
  if (action === "trash") return t("mail_p2_list.conversations_to_trash", { count });
  if (action === "delete") return t("mail_p2_list.conversations_deleted", { count });
  return mailbox
    ? t("mail_p2_list.conversations_moved_to", { count, mailbox })
    : t("mail_p2_list.conversations_moved", { count });
}
