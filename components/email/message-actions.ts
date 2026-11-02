"use client";

import type { ComponentType } from "react";
import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/stores/settings-store";
import { emailLinkSource } from "@/stores/email-store";
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
  Pin,
  PinOff,
  Trash2,
  Archive,
  FolderInput,
  FolderX,
  Tag,
  ShieldAlert,
  ShieldCheck,
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
  | "export"
  | "print"
  | "view_source"
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
  /** Save the message as .eml. */
  onExport?: () => void;
  onPrint?: () => void;
  onViewSource?: () => void;
  /** Entries the host already shows elsewhere (the reader's toolbar). */
  omit?: ReadonlySet<MessageActionKey>;
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
  // Marking your own outgoing mail as spam makes no sense.
  const spamApplicable = !["sent", "drafts", "scheduled"].includes(o.currentMailboxRole || "");

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
      SEPARATOR,
    ];
    const archive = archiveEnabled ? [item("archive", Archive, t("archive"), o.onArchive)] : [];
    const del = item("delete", Trash2, t("delete"), o.onDelete, { destructive: !mountainView, testId: "ctx-delete" });
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
    // Download/Export, Print, View source (R6: after Copy, before the end).
    const file = [
      ...(o.onExport ? [item("export", Download, tViewer("export_email"), o.onExport, { disabled: !email.blobId, testId: "ctx-export" })] : []),
      ...(o.onPrint ? [item("print", Printer, tViewer("print"), o.onPrint, { testId: "ctx-print" })] : []),
      ...(o.onViewSource ? [item("view_source", Code, tViewer("view_source"), o.onViewSource, { disabled: !email.blobId, testId: "ctx-view-source" })] : []),
    ];

    list = mountainView
      ? [
          ...draft, ...replies, ...archive, del, read, SEPARATOR,
          ...move, tag, ...rules, ...copy, SEPARATOR,
          star, ...pin, ...spam, ...reportPhishing, ...find, SEPARATOR,
          ...links, ...file,
        ]
      : [
          ...draft, ...replies, ...links, ...archive, del, SEPARATOR,
          ...move, ...copy, ...rules, star, ...pin, tag, ...spam, ...reportPhishing, SEPARATOR,
          read, SEPARATOR, ...file,
        ];
  }

  if (o.omit && o.omit.size > 0) {
    const omit = o.omit;
    list = list.filter((entry) => entry.kind === "separator" || !omit.has(entry.key));
  }
  if (o.extras && o.extras.length > 0) list = [...list, SEPARATOR, ...o.extras];
  return tidySeparators(list);
}
