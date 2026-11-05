"use client";

import type { ComponentType } from "react";
import { useTranslations } from "next-intl";
import { spamApplicableIn } from "@/lib/spam-applicable";
import { useSettingsStore } from "@/stores/settings-store";
import { emailLinkSource, bulkDeleteIsPermanent } from "@/stores/email-store";
import { useArchiveActionEnabled } from "@/lib/archive-gate";
import { buildMailPath } from "@/lib/deep-links";
import { useCopyLink } from "@/hooks/use-copy-link";
import { usePhishingReport } from "@/hooks/use-phishing-report";
import type { Email } from "@/lib/jmap/types";
import {
  Reply,
  ReplyAll,
  Forward,
  Mail,
  MailOpen,
  Star,
  StarOff,
  Pin,
  PinOff,
  Trash2,
  Archive,
  FolderInput,
  FolderX,
  Tag,
  ShieldAlert,
  ShieldCheck,
  ExternalLink,
  CalendarClock,
  CalendarX,
  Paperclip,
  Link as LinkIcon,
  MessagesSquare,
  Copy,
  Search,
  Pencil,
  Filter,
  Download,
  Printer,
  Code,
  Fish,
  Undo,
  Inbox,
} from "@/components/icons";

type Icon = ComponentType<{ className?: string }>;

/** The entries that open a list of their own: a submenu, or a sub-view of the phone panel. */
export type MessageSubmenuKey = "move" | "copy_to_account" | "tag" | "rules";

export type MessageActionKey =
  | "reschedule"
  | "cancel_and_edit"
  | "cancel_send"
  | "edit_draft"
  | "reply"
  | "reply_all"
  | "forward"
  | "forward_as_attachment"
  | "copy_message_link"
  | "copy_conversation_link"
  | "archive"
  | "delete"
  | "read"
  | "remove_from_folder"
  | "star"
  | "pin"
  | "spam"
  | "report_phishing"
  | "find_from_sender"
  | "open_window"
  | "export"
  | "print"
  | "view_source"
  | "restore"
  | MessageSubmenuKey
  // A host's own entries (the reader's view toggles), appended after the list.
  | `extra:${string}`;

export type MessageActionEntry =
  | {
      kind: "item";
      key: MessageActionKey;
      icon: Icon;
      label: string;
      run: () => void;
      disabled?: boolean;
      destructive?: boolean;
      testId?: string;
    }
  | { kind: "submenu"; key: MessageSubmenuKey; icon: Icon; label: string; testId?: string }
  | { kind: "separator" };

export interface MessageActionOptions {
  email: Email;
  currentMailboxRole?: string;
  /** Folders to move to exist and the host can move. */
  canMove?: boolean;
  /** The message is also in another folder and the list shows one folder. */
  canRemoveFromFolder?: boolean;
  /** Another connected account can take a copy. */
  canCopyToAccount?: boolean;
  /** Offer the Rules submenu (the host decides whether it can show it). */
  rules?: boolean;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onForwardAsAttachment?: () => void;
  onEditDraft?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onMarkAsRead?: (read: boolean) => void;
  onToggleStar?: () => void;
  onTogglePinned?: () => void;
  onRemoveFromFolder?: () => void;
  onMarkAsSpam?: () => void;
  onUndoSpam?: () => void;
  /** Mountain View: search for the mail this sender has sent. */
  onFindFromSender?: () => void;
  onRescheduleScheduled?: () => void;
  onCancelScheduledForEdit?: () => void;
  onCancelScheduledSend?: () => void;
  /** Opens the message in its own window (installed app, desktop app). */
  onOpenInWindow?: () => void;
  /** Save the message as .eml. */
  onExport?: () => void;
  onPrint?: () => void;
  onViewSource?: () => void;
  /** In Trash: back to the folder it came from, or the Inbox (lib/trash-origin.ts). */
  onRestore?: () => void;
  /** In Archive: "Move to Inbox" takes Archive's place (lib/archive-inbox.ts, mail-p3-4). */
  onMoveToInbox?: () => void;
  /** Entries the host already shows elsewhere (the reader's toolbar). */
  omit?: ReadonlySet<MessageActionKey>;
  /** How the host shows the message (the reader's view toggles): a group before Export, Print and View source. */
  views?: MessageActionEntry[];
  /** The host's own entries, after the message's own and a separator. */
  extras?: MessageActionEntry[];
}

const SEPARATOR: MessageActionEntry = { kind: "separator" };

/** No separator first, last or twice in a row. */
export function tidySeparators(entries: MessageActionEntry[]): MessageActionEntry[] {
  const out: MessageActionEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "separator" && (out.length === 0 || out[out.length - 1].kind === "separator")) continue;
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

/**
 * The actions for one message (R6): the row's right-click and long-press
 * menu, the reader's ⋮ menu and the phone's More panel all show this list,
 * in this order, leaving out only what the host shows elsewhere. Under
 * Mountain View the order is Gmail's.
 */
export function useMessageActionList(o: MessageActionOptions): MessageActionEntry[] {
  const t = useTranslations("context_menu");
  const tViewer = useTranslations("email_viewer");
  const tDeepLink = useTranslations("deep_link");
  const tPhishing = useTranslations("phishing_report");
  const tWindows = useTranslations("pwaWindows");
  const tRecover = useTranslations("recover_deleted");
  const tActions = useTranslations("reader_actions");
  const tP3 = useTranslations("mail_p3_actions");
  const copyLink = useCopyLink();
  const archiveEnabled = useArchiveActionEnabled();
  const mountainView = useSettingsStore((state) => state.interfaceLayout === "mountain-view");
  const { email } = o;
  // Report phishing (enterprise pack): while the admin set an address for
  // the message's account. It sends mail, so it opens a confirm first.
  const phishing = usePhishingReport([email], o.currentMailboxRole);

  const isUnread = !email.keywords?.$seen;
  const isStarred = !!email.keywords?.$flagged;
  const isPinned = email.keywords?.["$pinned"] === true;
  const isDraft = email.keywords?.["$draft"] === true;
  const isScheduled = email.isScheduled === true;
  const inJunk = o.currentMailboxRole === "junk";
  // Marking your own outgoing mail as spam makes no sense, nor reporting
  // what already sits in the bin.
  const spamApplicable = spamApplicableIn(o.currentMailboxRole);
  // Deleting from Trash (or with deletes set to be permanent) can't be undone.
  const deleteForever = bulkDeleteIsPermanent({ role: o.currentMailboxRole });

  const item = (
    key: MessageActionKey,
    icon: Icon,
    label: string,
    run: (() => void) | undefined,
    extra: { disabled?: boolean; destructive?: boolean; testId?: string } = {},
  ): MessageActionEntry => ({
    kind: "item",
    key,
    icon,
    label,
    run: () => run?.(),
    disabled: extra.disabled ?? !run,
    destructive: extra.destructive,
    testId: extra.testId,
  });

  let list: MessageActionEntry[];

  if (isScheduled) {
    const canCancel = email.scheduledUndoStatus === "pending";
    list = canCancel
      ? [
          item("reschedule", CalendarClock, t("reschedule_send"), o.onRescheduleScheduled),
          item(
            "cancel_and_edit",
            Pencil,
            email.isSmimeScheduled ? t("cancel_and_compose_again") : t("cancel_and_edit"),
            o.onCancelScheduledForEdit,
          ),
          // Back into Drafts. An S/MIME message can't go back (it is
          // encrypted), so it only offers "Cancel and compose again".
          ...(o.onCancelScheduledSend && !email.isSmimeScheduled
            ? [item("cancel_send", CalendarX, t("cancel_scheduled_send"), o.onCancelScheduledSend, { testId: "ctx-cancel-scheduled-send" })]
            : []),
        ]
      : [];
  } else {
    const draft = isDraft && o.onEditDraft ? [item("edit_draft", Pencil, t("edit_draft"), o.onEditDraft), SEPARATOR] : [];
    const replies = [
      item("reply", Reply, t("reply"), o.onReply),
      item("reply_all", ReplyAll, t("reply_all"), o.onReplyAll),
      item("forward", Forward, t("forward"), o.onForward),
      item("forward_as_attachment", Paperclip, tViewer("forward_as_attachment"), o.onForwardAsAttachment, {
        disabled: !o.onForwardAsAttachment || !email.blobId,
      }),
      SEPARATOR,
    ];
    // Permalinks (#733). The conversation entry only when the message
    // belongs to a thread worth linking to.
    const links = [
      item("copy_message_link", LinkIcon, tDeepLink("copy_message"), () => {
        void copyLink(buildMailPath({ mailboxId: null, emailId: email.id, threadId: null, ...emailLinkSource(email) }));
      }),
      ...(email.threadId
        ? [item("copy_conversation_link", MessagesSquare, tDeepLink("copy_conversation"), () => {
            void copyLink(buildMailPath({ mailboxId: null, emailId: null, threadId: email.threadId!, ...emailLinkSource(email) }));
          })]
        : []),
    ];
    // In Trash the first thing after answering: getting it back.
    const restore = o.onRestore && o.currentMailboxRole === "trash"
      ? [item("restore", Undo, tRecover("restore"), o.onRestore, { testId: "ctx-restore" }), SEPARATOR]
      : [];
    // In Archive the same place (and key E) brings it back to the Inbox.
    const archive = o.onMoveToInbox
      ? [item("archive", Inbox, tP3("move_to_inbox"), o.onMoveToInbox, { testId: "ctx-move-to-inbox" })]
      : archiveEnabled ? [item("archive", Archive, t("archive"), o.onArchive)] : [];
    const del = item("delete", Trash2, deleteForever ? tActions("delete_forever") : t("delete"), o.onDelete, { destructive: !mountainView, testId: "ctx-delete" });
    const read = item("read", isUnread ? MailOpen : Mail, isUnread ? t("mark_read") : t("mark_unread"), () => o.onMarkAsRead?.(isUnread), {
      disabled: false,
      testId: isUnread ? "ctx-mark-read" : "ctx-mark-unread",
    });
    const move: MessageActionEntry[] = [
      ...(o.canMove ? [{ kind: "submenu", key: "move", icon: FolderInput, label: t("move_to"), testId: "ctx-move-to" } as const] : []),
      ...(o.canRemoveFromFolder && o.onRemoveFromFolder
        ? [item("remove_from_folder", FolderX, t("remove_from_folder"), o.onRemoveFromFolder, { testId: "ctx-remove-from-folder" })]
        : []),
    ];
    const copy: MessageActionEntry[] = o.canCopyToAccount
      ? [{ kind: "submenu", key: "copy_to_account", icon: Copy, label: t("copy_to_account"), testId: "ctx-copy-to" }]
      : [];
    const rules: MessageActionEntry[] = o.rules !== false
      ? [{ kind: "submenu", key: "rules", icon: Filter, label: t("rules.title"), testId: "ctx-rules" }]
      : [];
    const star = item("star", Star, isStarred ? t("unstar") : t("star"), o.onToggleStar, { testId: isStarred ? "ctx-unstar" : "ctx-star" });
    const pin = o.onTogglePinned ? [item("pin", isPinned ? PinOff : Pin, isPinned ? t("unpin") : t("pin"), o.onTogglePinned)] : [];
    const tag: MessageActionEntry = { kind: "submenu", key: "tag", icon: Tag, label: t("tag"), testId: "ctx-tag" };
    const spamHandler = inJunk ? o.onUndoSpam : o.onMarkAsSpam;
    const spam = spamApplicable
      ? [SEPARATOR, item("spam", inJunk ? ShieldCheck : ShieldAlert, inJunk ? t("not_spam") : t("mark_as_spam"), spamHandler, {
          destructive: !inJunk && !mountainView,
          testId: inJunk ? "ctx-not-spam" : "ctx-spam",
        })]
      : [];
    const reportPhishing = phishing.available
      ? [item("report_phishing", Fish, tPhishing("action"), phishing.report, { testId: "ctx-report-phishing" })]
      : [];
    const sender = email.from?.[0];
    const find = o.onFindFromSender && sender?.email
      ? [SEPARATOR, item("find_from_sender", Search, t("find_emails_from", { name: sender.name || sender.email }), o.onFindFromSender, { testId: "ctx-find-from" })]
      : [];
    const openWindow = o.onOpenInWindow
      ? [item("open_window", ExternalLink, tWindows("open_in_window"), o.onOpenInWindow, { testId: "ctx-open-window" })]
      : [];
    // How the host shows it, then Download/Export, Print, View source, at the end.
    const views = o.views ?? [];
    const file = [
      ...(o.onExport ? [item("export", Download, tViewer("export_email"), o.onExport, { disabled: !email.blobId, testId: "ctx-export" })] : []),
      ...(o.onPrint ? [item("print", Printer, tViewer("print"), o.onPrint, { testId: "ctx-print" })] : []),
      ...(o.onViewSource ? [item("view_source", Code, tViewer("view_source"), o.onViewSource, { disabled: !email.blobId, testId: "ctx-view-source" })] : []),
    ];

    // In groups, as mail clients have them: answer; file away; mark; spam;
    // open and link; how it shows; save, print, source.
    list = mountainView
      ? [
          ...draft, ...replies, ...restore, ...archive, del, read, SEPARATOR,
          ...move, tag, ...rules, ...copy, SEPARATOR,
          star, ...pin, ...spam, ...reportPhishing, ...find, SEPARATOR,
          ...links, SEPARATOR, ...views, SEPARATOR, ...openWindow, ...file,
        ]
      : [
          ...draft, ...replies, ...restore, ...archive, del, SEPARATOR,
          ...move, ...copy, ...rules, SEPARATOR,
          read, star, ...pin, tag, SEPARATOR,
          ...spam, ...reportPhishing, SEPARATOR,
          ...openWindow, ...links, SEPARATOR,
          ...views, SEPARATOR,
          ...file,
        ];
  }

  if (o.omit && o.omit.size > 0) {
    const omit = o.omit;
    list = list.filter((entry) => entry.kind === "separator" || !omit.has(entry.key));
  }
  if (o.extras && o.extras.length > 0) list = [...list, SEPARATOR, ...o.extras];
  return tidySeparators(list);
}

/**
 * What a message's right-click and long-press menu shows at its top level, in the
 * browser and in the desktop app alike: answer, file away, mark, spam, open. The rest
 * goes under "More actions" (rowMenuSections). Restore in Trash, Not spam in Spam and a
 * draft's or a scheduled message's own entries stay at the top.
 */
export const ROW_MENU_KEYS: ReadonlySet<MessageActionKey> = new Set<MessageActionKey>([
  "reschedule", "cancel_and_edit", "cancel_send", "edit_draft",
  "reply", "reply_all", "forward",
  "restore", "archive", "delete", "move",
  "read", "star", "tag",
  "spam",
  "open_window",
]);

/**
 * "More actions", in groups with a line between: forwarding, links, filing and marks,
 * then save, print and source. Keys not named here (a host's own entries) go before
 * the last group.
 */
const MORE_GROUPS: MessageActionKey[][] = [
  ["forward_as_attachment"],
  ["copy_message_link", "copy_conversation_link"],
  ["copy_to_account", "rules", "remove_from_folder", "pin", "report_phishing", "find_from_sender"],
  ["export", "print", "view_source"],
];

function moreGroupOf(key: MessageActionKey): number {
  const at = MORE_GROUPS.findIndex((group) => group.includes(key));
  return at >= 0 ? at : MORE_GROUPS.length - 1.5;
}

/** Splits one message's actions into the row menu's top level and its "More actions". */
export function rowMenuSections(list: MessageActionEntry[]): { top: MessageActionEntry[]; more: MessageActionEntry[] } {
  const top = tidySeparators(list.filter((entry) => entry.kind === "separator" || ROW_MENU_KEYS.has(entry.key)));
  const rest = list.filter(
    (entry): entry is Exclude<MessageActionEntry, { kind: "separator" }> => entry.kind !== "separator" && !ROW_MENU_KEYS.has(entry.key),
  );
  // Stable: within a group the list's own order stays.
  const sorted = rest
    .map((entry, index) => ({ entry, index, group: moreGroupOf(entry.key) }))
    .sort((a, b) => a.group - b.group || a.index - b.index);
  const more: MessageActionEntry[] = [];
  sorted.forEach(({ entry, group }, i) => {
    if (i > 0 && sorted[i - 1].group !== group) more.push(SEPARATOR);
    more.push(entry);
  });
  return { top, more };
}

export interface SelectionActionOptions {
  /** The selected messages. */
  emails: Email[];
  currentMailboxRole?: string;
  canMove?: boolean;
  canRemoveFromFolder?: boolean;
  canCopyToAccount?: boolean;
  /** Offer the Tag submenu. */
  canTag?: boolean;
  /** In Trash: puts every selected message back. */
  onRestore?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onMarkAsRead?: (read: boolean) => void;
  onSetStarred?: (starred: boolean) => void;
  onMarkAsSpam?: () => void;
  onUndoSpam?: () => void;
  onForwardAsAttachment?: () => void;
  onRemoveFromFolder?: () => void;
}

/**
 * The actions for a selection of several messages. The selection's right-click menu
 * and the reading pane's selection view both show these, in this order: the same
 * structure as one message's row menu, without what needs a single message (answering,
 * its own window, links, saving, printing, its source).
 */
export function useSelectionActionList(o: SelectionActionOptions): { top: MessageActionEntry[]; more: MessageActionEntry[] } {
  const t = useTranslations("context_menu");
  const tPhishing = useTranslations("phishing_report");
  const tRecover = useTranslations("recover_deleted");
  const tActions = useTranslations("reader_actions");
  const archiveEnabled = useArchiveActionEnabled();
  const mountainView = useSettingsStore((state) => state.interfaceLayout === "mountain-view");
  const phishing = usePhishingReport(o.emails, o.currentMailboxRole);
  const role = o.currentMailboxRole;
  const inJunk = role === "junk";
  const deleteForever = bulkDeleteIsPermanent({ role });
  const someUnread = o.emails.some((e) => !e.keywords?.$seen);
  const someRead = o.emails.some((e) => !!e.keywords?.$seen);
  const allStarred = o.emails.length > 0 && o.emails.every((e) => !!e.keywords?.$flagged);

  const item = (
    key: MessageActionKey,
    icon: Icon,
    label: string,
    run: (() => void) | undefined,
    extra: { destructive?: boolean; testId?: string } = {},
  ): MessageActionEntry => ({ kind: "item", key, icon, label, run: () => run?.(), disabled: !run, ...extra });

  const restore = role === "trash" && o.onRestore
    ? [item("restore", Undo, tRecover("restore"), o.onRestore, { testId: "ctx-restore" }), SEPARATOR]
    : [];
  // In Archive there's nowhere further to archive it to.
  const archive = archiveEnabled && role !== "archive" ? [item("archive", Archive, t("archive"), o.onArchive, { testId: "ctx-archive" })] : [];
  const del = item("delete", Trash2, deleteForever ? tActions("delete_forever") : t("delete"), o.onDelete, {
    destructive: !mountainView,
    testId: "ctx-delete",
  });
  const move: MessageActionEntry[] = o.canMove ? [{ kind: "submenu", key: "move", icon: FolderInput, label: t("move_to"), testId: "ctx-move-to" }] : [];
  // A selection of read and unread mail gets both.
  const read = [
    ...(someUnread ? [item("read", MailOpen, t("mark_read"), () => o.onMarkAsRead?.(true), { testId: "ctx-mark-read" })] : []),
    ...(someRead ? [item("read", Mail, t("mark_unread"), () => o.onMarkAsRead?.(false), { testId: "ctx-mark-unread" })] : []),
  ];
  // Takes the star off when every one has it, else stars them all.
  const star = o.onSetStarred
    ? [item("star", allStarred ? StarOff : Star, allStarred ? t("unstar") : t("star"), () => o.onSetStarred?.(!allStarred), {
        testId: allStarred ? "ctx-unstar" : "ctx-star",
      })]
    : [];
  const tag: MessageActionEntry[] = o.canTag ? [{ kind: "submenu", key: "tag", icon: Tag, label: t("tag"), testId: "ctx-tag" }] : [];
  const spam = spamApplicableIn(role)
    ? [item("spam", inJunk ? ShieldCheck : ShieldAlert, inJunk ? t("not_spam") : t("mark_as_spam"), inJunk ? o.onUndoSpam : o.onMarkAsSpam, {
        destructive: !inJunk && !mountainView,
        testId: inJunk ? "ctx-not-spam" : "ctx-spam",
      })]
    : [];

  // The row menu's order in each layout (useMessageActionList).
  const top = tidySeparators(mountainView
    ? [...restore, ...archive, del, ...read, SEPARATOR, ...move, ...tag, SEPARATOR, ...star, ...spam]
    : [...restore, ...archive, del, SEPARATOR, ...move, SEPARATOR, ...read, ...star, ...tag, SEPARATOR, ...spam]);

  const copy: MessageActionEntry[] = o.canCopyToAccount
    ? [{ kind: "submenu", key: "copy_to_account", icon: Copy, label: t("copy_to_account"), testId: "ctx-copy-to" }]
    : [];
  const more = tidySeparators([
    item("forward_as_attachment", Paperclip, t("forward_as_attachments"), o.onForwardAsAttachment, { testId: "ctx-batch-forward-as-attachment" }),
    SEPARATOR,
    ...copy,
    { kind: "submenu", key: "rules", icon: Filter, label: t("rules.title"), testId: "ctx-rules" },
    ...(o.canRemoveFromFolder && o.onRemoveFromFolder
      ? [item("remove_from_folder", FolderX, t("remove_from_folder"), o.onRemoveFromFolder, { testId: "ctx-remove-from-folder" })]
      : []),
    ...(phishing.available
      ? [SEPARATOR, item("report_phishing", Fish, tPhishing("action"), phishing.report, { testId: "ctx-batch-report-phishing" })]
      : []),
  ]);
  return { top, more };
}
