"use client";

import React, { useCallback } from "react";
import { spamApplicableIn } from "@/lib/spam-applicable";
import { cleanPreview, formatDate } from "@/lib/utils";
import { rowA11yProps, rowLabel } from "./list-a11y";
import { emailListDate } from "@/lib/email-date";
import { formatScheduledSendAt } from "@/lib/scheduled-send-label";
import { Email, ThreadGroup } from "@/lib/jmap/types";
import { cn } from "@/lib/utils";
import { ListAttachmentChips, useListHasAttachment } from "./attachment-chips";
import { VerificationCodeChip, useListVerificationCode } from "./verification-code-chip";
import type { Attachment } from "@/lib/jmap/types";
import type { LoadListAttachments } from "@/lib/list-attachments";
import { SelectableAvatar } from "@/components/email/selectable-avatar";
import { Paperclip, Star, Pin, Circle, ChevronRight, ChevronDown, Loader2, MessageSquare, CheckSquare, Square, Reply, Forward, CalendarClock, Folder, Archive, Trash2, MailOpen, ShieldAlert, MoreHorizontal } from "@/components/icons";
import type { AppIcon } from "@/components/icons";
import { useSettingsStore, KEYWORD_PALETTE } from "@/stores/settings-store";
import { useShallow } from "zustand/react/shallow";
import { useListRowShape, LIST_COLUMN_CLASS } from "@/hooks/use-list-row-shape";
import { SizeCell } from "./list-columns";
import { accountTintKey, generateAvatarColor } from "@/lib/account-utils";
import { useUIStore } from "@/stores/ui-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useEmailStore, isUnscopedSearchActive } from "@/stores/email-store";
import { useAccountStore, type AccountEntry } from "@/stores/account-store";
import { emailKeyFor, getThreadTagIds, getEmailTagIds } from "@/lib/thread-utils";
import { useKeywordFormat } from "@/hooks/use-keyword-format";
import { useEmailTagScope } from "@/hooks/use-account-tags";
import { useRowTagDisplay, useTagDisplay } from "@/hooks/use-tag-display";
import { TagBadge, TAG_LOZENGE_CLASS } from "./tag-badge";
import { ROW_TAG_GROUP_CLASS } from "./row-tag-classes";
import { useEmailDrag } from "@/hooks/use-email-drag";
import { useLongPress } from "@/hooks/use-long-press";
import { useSwipeActions } from "@/hooks/use-swipe-actions";
import type { SwipeAction } from "@/stores/settings-store";
import { ThreadEmailItem } from "./thread-email-item";
import { EmailHoverActions } from "./email-hover-actions";
import { SearchSnippetText } from "./search-snippet-text";
import { PluginRowBadges } from "./plugin-row-badges";
import { useOwnDomainAddress } from "@/hooks/use-own-domain-address";
import { useSenderWarning } from "@/hooks/use-sender-warning";
import { brandIndicatorDomain } from "@/lib/email-headers";
import { RowTranslatorsProvider, useRowTranslators } from "@/components/email/row-translators";
import { localizeMailboxName } from "@/lib/mailbox-label";

/**
 * Unread bullet in the row gutter.
 *
 * It is absolutely positioned so it never widens the row. With an avatar it
 * sits in the avatar's wrapper and centres on the avatar: the avatar centres
 * itself against the row, so a dot anchored on the first line floats above
 * it once the row grows a chip line. Extra-compact rows have no avatar and
 * anchor it on their single line instead (top padding + half a line).
 */
/**
 * A mouse press on the row itself, i.e. one about to become a click that opens
 * it: a touch may be a scroll starting, and a press on a control inside the
 * row (checkbox, hover action, link) does something else.
 */
function isMousePressOnRow(e: React.PointerEvent): boolean {
  if (e.pointerType !== 'mouse' || e.button !== 0) return false;
  return !(e.target as Element).closest('button, input, a');
}

/**
 * Whether a row has been pointed at yet. The hover actions stay display:none
 * until the pointer is over the row, so mounting them for every row up front
 * only added a handful of icon buttons per row to every list render. They
 * mount on the first pointer-over and stay from then on, so the hover
 * behaviour itself is unchanged. Pointer-over rather than pointer-enter: when
 * a row slides under a resting pointer (the row above was just deleted from
 * its hover actions), the browser's pointerover comes from the list around
 * it, and React builds no onPointerEnter from that.
 */
/**
 * Role of the folder the list shows (sender vs recipient, junk actions). In
 * aggregate role views the selected mailbox is virtual, so the unified role
 * stands in for it.
 */
export function listMailboxRole(state: {
  mailboxes: { id: string; role?: string | null }[];
  selectedMailbox: string;
  isUnifiedView: boolean;
  unifiedRole: string | null;
}): string | undefined {
  return state.mailboxes.find((mb) => mb.id === state.selectedMailbox)?.role
    ?? (state.isUnifiedView ? (state.unifiedRole ?? undefined) : undefined);
}

/**
 * The folder a list row was listed in: its id (where a drag moves the
 * message from) and its role (sender or recipient, junk actions).
 */
export interface ListFolder {
  mailboxId: string;
  role: string | undefined;
}

const NO_LIST_FOLDER: ListFolder = { mailboxId: '', role: undefined };

/**
 * The folder a row belongs to. The message list hands it over (listFolder),
 * kept with the rows it was fetched for: following the selected folder
 * instead re-rendered every row on screen the moment another folder was
 * clicked, and showed the old rows with the new folder's sender or recipient
 * until the new ones came. A row drawn on its own reads the store.
 */
function useRowFolder(listFolder: ListFolder | undefined): ListFolder {
  const fromStore = useEmailStore(useShallow((state) => (listFolder
    ? NO_LIST_FOLDER
    : { mailboxId: state.selectedMailbox, role: listMailboxRole(state) })));
  return listFolder ?? fromStore;
}

/**
 * The account dot tells signed-in accounts apart. With a single account every
 * row would carry the same dot, so it only shows once there are two or more.
 */
function useShowAccountDot(tintListRowsByAccount: boolean): boolean {
  const enabled = useSettingsStore((state) => state.showAccountDot);
  const severalAccounts = useAccountStore((state) => state.accounts.length > 1);
  return enabled && severalAccounts && !tintListRowsByAccount;
}

/**
 * Rows swipe on a phone, and on a touch screen below the full desktop: a
 * tablet draws the compact desktop layout and keeps the phone's gesture.
 */
function useSwipeRows(): boolean {
  const isMobile = useUIStore((state) => state.isMobile);
  const touchCompact = useMediaQuery("(pointer: coarse) and (width < 64rem)");
  return isMobile || touchCompact;
}

/** Hover actions mount on the first pointerover or keyboard focus in the row. */
function useArmOnPointerOver(): [boolean, () => void] {
  const [armed, setArmed] = React.useState(false);
  const arm = React.useCallback(() => setArmed(true), []);
  return [armed, arm];
}

function UnreadDot({ besideAvatar }: { besideAvatar: boolean }) {
  const t = useRowTranslators()!.viewer;
  return (
    <div
      className={cn('absolute -translate-y-1/2', besideAvatar ? '-start-2.5 top-1/2' : 'start-0.5')}
      style={besideAvatar ? undefined : { top: 'calc(var(--density-item-py) + 0.625rem)' }}
    >
      <Circle className="w-2 h-2 fill-unread text-unread" />
      <span className="sr-only">{t('unread')}</span>
    </div>
  );
}

/** The chip row under a row's preview: the verification code, then the attachments. */
function RowChips({ email, loadAttachments, onOpenAttachment, mountainView, mvRow }: {
  email: Email;
  loadAttachments?: LoadListAttachments;
  onOpenAttachment?: (attachment: Attachment) => void;
  /** Gmail's pill chips. */
  mountainView?: boolean;
  /** A one-line Mountain View row: the chips start under the subject, as in Gmail. */
  mvRow?: boolean;
}) {
  const variant = mountainView || mvRow ? "mountain-view" : "default";
  const code = useListVerificationCode(email);
  const leading = code ? <VerificationCodeChip code={code} variant={variant} /> : undefined;
  // The sender column is w-32 (lg:w-40) and the row line has gap-3 after it.
  const className = cn(variant === "mountain-view" ? "mt-2" : "mt-1.5", mvRow && "-mt-0.5 pb-2.5 ps-[8.75rem] lg:ps-[10.75rem]");
  // Most rows have no attachment: no loader for them, nor an empty chip row.
  const mayHaveAttachments = email.hasAttachment || (email.attachments?.length ?? 0) > 0;
  if (onOpenAttachment && mayHaveAttachments) {
    return <ListAttachmentChips email={email} load={loadAttachments} onOpen={onOpenAttachment} leading={leading} variant={variant} max={variant === "mountain-view" ? 3 : 2} className={className} />;
  }
  return leading ? <div className={cn("flex", className)}>{leading}</div> : null;
}

/**
 * The fill behind Mountain View's hover actions, which has to match the row
 * they sit on (see the [data-mv-row] rules in globals.css).
 */
function mvHoverBackground(checked: boolean, unread: boolean, selected: boolean): string {
  if (selected) return "bg-accent";
  if (checked) return "bg-[var(--mv-nav-selected)]";
  return unread ? "bg-background" : "bg-[var(--mv-row-read)]";
}

/**
 * The strip the sender avatar sits in, from the row's leading edge to the
 * text and over the row's full height. A click anywhere in it ticks the row
 * instead of opening it, so a slightly missed avatar doesn't open the mail
 * (#1381). It is for pointers only: the avatar inside stays the checkbox
 * keyboards and screen readers use.
 */
function AvatarGutter({
  onToggle,
  children,
}: {
  onToggle: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      data-select-gutter=""
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e);
      }}
      // Two quick clicks tick and untick; they must not open the message too.
      onDoubleClick={(e) => e.stopPropagation()}
      // Hovering the strip shows the avatar's check, as hovering the avatar does.
      className="group/select -ms-3 flex flex-shrink-0 cursor-pointer items-center self-stretch ps-3"
      style={{
        marginBlock: 'calc(var(--density-item-py) * -1)',
        paddingBlock: 'var(--density-item-py)',
        marginInlineEnd: 'calc(var(--density-item-gap) * -1)',
        paddingInlineEnd: 'var(--density-item-gap)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Mountain View's leading controls: a checkbox and a star, both always
 * visible and both acting on the row without opening it. They take the slot
 * the default layout gives to the sender avatar. The checkbox reaches from
 * the row's leading edge over its full height, as in Gmail (#1381).
 */
function MvRowLead({
  checked,
  onToggleChecked,
  starred,
  onToggleStar,
  selectLabel,
  starLabel,
}: {
  checked: boolean;
  onToggleChecked: (e: React.MouseEvent) => void;
  starred: boolean;
  onToggleStar?: () => void;
  selectLabel: string;
  starLabel: string;
}) {
  return (
    <div className="flex flex-shrink-0 items-start self-stretch">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={selectLabel}
        onClick={onToggleChecked}
        onDoubleClick={(e) => e.stopPropagation()}
        className="group/check -ms-3 flex items-start self-stretch ps-3 pe-0.5"
      >
        <span className="flex h-[var(--list-item-height)] items-center">
          <span
            className={cn(
              "p-1 rounded-full transition-colors group-hover/check:bg-foreground/10",
              checked && "text-primary"
            )}
          >
            {checked ? (
              <CheckSquare className="w-[18px] h-[18px]" />
            ) : (
              <Square className="w-[18px] h-[18px] text-muted-foreground" />
            )}
          </span>
        </span>
      </button>
      {onToggleStar && (
        <span className="flex h-[var(--list-item-height)] items-center">
          <button
            type="button"
            aria-label={starLabel}
            aria-pressed={starred}
            title={starLabel}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStar();
            }}
            className="p-1 rounded-full transition-colors hover:bg-foreground/10"
          >
            <Star
              className={cn(
                "w-[18px] h-[18px]",
                starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground/60"
              )}
            />
          </button>
        </span>
      )}
    </div>
  );
}

function MvMobileStar({
  starred,
  onToggle,
  label,
}: {
  starred: boolean;
  onToggle?: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={starred}
      title={label}
      disabled={!onToggle}
      onClick={(event) => {
        event.stopPropagation();
        onToggle?.();
      }}
      className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 disabled:pointer-events-none"
    >
      <Star
        className={cn(
          "h-[18px] w-[18px]",
          starred ? "fill-amber-400 text-amber-400" : "text-muted-foreground/70"
        )}
      />
    </button>
  );
}

function StatusIcon({ icon: Icon, label, className }: { icon: AppIcon; label: string; className: string }) {
  return (
    <>
      <Icon className={className} />
      <span className="sr-only">{label}</span>
    </>
  );
}

function describeAccount(label: string | undefined, account: AccountEntry | undefined): string | undefined {
  const address = account?.email || account?.username;
  if (!label) return address;
  if (!address || address.toLowerCase() === label.toLowerCase()) return label;
  return `${label}, ${address}`;
}

/**
 * Small chip showing the originating folder of a message, rendered in the
 * aggregate "All …" views (All Mail / unified / cross-account) where rows come
 * from different folders. `email.sourceFolder` is stamped at fetch time.
 */
function SourceFolderTag({ name: serverName, role, tight }: { name: string; role?: string; tight?: boolean }) {
  // The sidebar's name for the folder: "Sent", not the server's "Sent Items".
  const tSidebar = useRowTranslators()!.sidebar;
  const name = localizeMailboxName(role, serverName, (key) => tSidebar(`mailboxes.${key}`));
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 truncate rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground", tight ? "max-w-[4.5rem]" : "max-w-[8rem]")}
      title={name}
    >
      <Folder className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * Whether rows show their folder chip: in the aggregate "All …" views, and in
 * search results that span every folder rather than the one picked in the
 * search panel (#1172). Rows of a single-folder list carry no sourceFolder.
 *
 * Such a row never subscribes to the view state: starting a search flips it
 * while the old list is still on screen, and every row re-rendered for a chip
 * it has nothing to put in.
 */
function useShowSourceFolder(sourceFolder: string | undefined): boolean {
  return useEmailStore((state) => !!sourceFolder && (state.isUnifiedView || isUnscopedSearchActive(state)));
}

/**
 * How many messages a collapsed thread stands for.
 *
 * Built from the tag lozenge so it lines up with the tags it sits next to: the
 * same shape, and the same group spacing.
 */
function ThreadCountPill({ count, hasUnread, title }: { count: number; hasUnread: boolean; title: string }) {
  return (
    <span
      className={cn(
        TAG_LOZENGE_CLASS,
        "gap-0.5",
        hasUnread ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
      )}
      title={title}
    >
      <MessageSquare className="w-3 h-3" />
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

interface ThreadListItemProps {
  thread: ThreadGroup;
  isExpanded: boolean;
  /** emailKeyFor of the open message: ids repeat across accounts. */
  selectedEmailKey?: string;
  isLoading?: boolean;
  expandedEmails?: Email[];
  onToggleExpand: () => void;
  onCollapseAllThreads?: () => void;
  onEmailSelect: (email: Email) => void;
  onEmailDoubleClick?: (email: Email) => void;
  /** A mouse was pressed on the row: the click that follows will open it. */
  onPrefetch?: (email: Email) => void;
  onContextMenu?: (e: React.MouseEvent, email: Email) => void;
  onOpenConversation?: (thread: ThreadGroup) => void;
  /** The reading pane shows the conversation: the row opens it there and never unfolds. */
  conversationInReader?: boolean;
  onToggleStar?: (email: Email) => void;
  onMarkAsRead?: (email: Email, read: boolean) => void;
  onDelete?: (email: Email) => void;
  onArchive?: (email: Email) => void;
  onSetTag?: (emailId: string, tagId: string | null, emailKey?: string) => void;
  onMarkAsSpam?: (email: Email) => void;
  onUndoSpam?: (email: Email) => void;
  onOpenAttachment?: (email: Email, attachment: Attachment) => void;
  loadAttachments?: LoadListAttachments;
  /** The folder the row is listed in (see useRowFolder); a row on its own reads the store. */
  listFolder?: ListFolder;
}

interface SingleEmailItemProps {
  email: Email;
  selected: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onPrefetch?: () => void;
  onContextMenu?: (e: React.MouseEvent, email: Email) => void;
  /** Given by a conversation row; a row of its own reads the setting. */
  showPreview?: boolean;
  rowTint: string | null;
  onToggleStar?: () => void;
  onMarkAsRead?: (read: boolean) => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onSetTag?: (tagId: string | null) => void;
  onMarkAsSpam?: () => void;
  onUndoSpam?: () => void;
  onOpenAttachment?: (attachment: Attachment) => void;
  loadAttachments?: LoadListAttachments;
  listFolder?: ListFolder;
}

// Visual + behaviour metadata for each mobile swipe action. Keyed by the
// SwipeAction values that map to a row callback ('none' is handled inline).
const SWIPE_ACTION_META: Record<Exclude<SwipeAction, 'none'>, { icon: AppIcon; bg: string }> = {
  archive: { icon: Archive, bg: 'bg-emerald-600' },
  delete: { icon: Trash2, bg: 'bg-red-600' },
  markRead: { icon: MailOpen, bg: 'bg-sky-600' },
  star: { icon: Star, bg: 'bg-amber-500' },
  spam: { icon: ShieldAlert, bg: 'bg-orange-600' },
};

const SingleEmailItem = React.forwardRef<HTMLDivElement, SingleEmailItemProps>(
  function SingleEmailItem({ email, selected, onClick, onDoubleClick, onPrefetch, onContextMenu, showPreview: showPreviewProp, rowTint, onToggleStar, onMarkAsRead, onDelete, onArchive, onSetTag, onMarkAsSpam, onUndoSpam, onOpenAttachment, loadAttachments, listFolder }, ref) {
    const { viewer: t, batch: tBatch, hover: tHover, list: tStatus } = useRowTranslators()!;
    const tUnknown = t('unknown_sender');
    const tNoSubject = t('no_subject');
    // One subscription for the row's settings instead of one per setting: a
    // list draws fourteen or so of these rows at a time.
    const {
      showPreview: showPreviewSetting, tintListRowsByTag, tintListRowsByAccount, density, timeFormat, showAvatarsInJunk,
      interfaceLayout, announceRowPreview, showRowActionButton, swipeRightAction, swipeLeftAction,
    } = useSettingsStore(useShallow((state) => ({
      showPreview: state.showPreview,
      tintListRowsByTag: state.tintListRowsByTag,
      tintListRowsByAccount: state.tintListRowsByAccount,
      density: state.density,
      timeFormat: state.timeFormat,
      showAvatarsInJunk: state.showAvatarsInJunk,
      interfaceLayout: state.interfaceLayout,
      announceRowPreview: state.announceRowPreview,
      showRowActionButton: state.showRowActionButton,
      swipeRightAction: state.swipeRightAction,
      swipeLeftAction: state.swipeLeftAction,
    })));
    const showPreview = showPreviewProp ?? showPreviewSetting;
    const isUnread = !email.keywords?.$seen;
    const isStarred = email.keywords?.$flagged;
    const isPinned = email.keywords?.['$pinned'] === true;
    const isAnswered = email.keywords?.$answered;
    const isForwarded = email.keywords?.$forwarded;
    const showPaperclip = useListHasAttachment(email, loadAttachments);
    // The role, not the folder list: the list is a new array on every
    // count update, and subscribing to it re-rendered every row for each.
    const { mailboxId: selectedMailbox, role: currentMailboxRole } = useRowFolder(listFolder);
    // Whether this row is ticked and whether anything is, not the selection
    // itself: a new selection (each tick, every folder switch) would draw
    // every row on screen again.
    const { isChecked, selecting, toggleEmailSelection, selectRangeEmails, isUnifiedView } = useEmailStore(useShallow((state) => ({
      isChecked: state.selectedEmailKeys.has(emailKeyFor(email)),
      selecting: state.selectedEmailKeys.size > 0,
      toggleEmailSelection: state.toggleEmailSelection,
      selectRangeEmails: state.selectRangeEmails,
      isUnifiedView: state.isUnifiedView,
    })));
    // In Sent/Drafts folders, show recipient instead of sender (which is always
    // "me"). In aggregate role-views the selected mailbox is virtual → fall back
    // to the unified role so junk-contextual UI and avatar hiding work.
    const showRecipient = currentMailboxRole === 'sent' || currentMailboxRole === 'drafts';
    const sender = showRecipient ? (email.to?.[0] ?? email.from?.[0]) : email.from?.[0];
    // Every row's checkbox says which message it picks (not "Select emails").
    const selectRowLabel = tBatch('select_row', {
      sender: sender?.name || sender?.email || '',
      subject: email.subject || t('no_subject'),
    });
    const formatAddress = useOwnDomainAddress();
    const tagScope = useEmailTagScope(email);
    const { sortTagIds, tagColor } = useKeywordFormat(tagScope);
    // Only a row with tags or a folder chip follows the list's width class.
    const { variant: tagVariant, placement: tagPlacement, tight: senderLineTight } = useRowTagDisplay(getEmailTagIds(email.keywords).length > 0 || !!email.sourceFolder);
    // The tint replaces the dot, and the dot can be switched off on its own (#912).
    const showAccountDot = useShowAccountDot(tintListRowsByAccount);
    const hideJunkAvatarImages = currentMailboxRole === 'junk' && !showAvatarsInJunk;
    const senderWarning = useSenderWarning(showRecipient ? undefined : email);
    // Show the originating folder in the aggregate "All …" views.
    const showSourceFolder = useShowSourceFolder(email.sourceFolder);
    const getAccountById = useAccountStore((state) => state.getAccountById);
    const account = email.accountId ? getAccountById(email.accountId) : undefined;
    const accountColor = account?.avatarColor;
    const accountDescription = describeAccount(email.accountLabel, account);
    const isMobile = useUIStore((state) => state.isMobile);
    const swipeRows = useSwipeRows();
    // One line per row where the list has the full width; stacked on phones.
    const { oneLine: oneLineRow, columns } = useListRowShape();
    // Mountain View leads its rows with a checkbox and a clickable star
    // instead of an avatar, and marks unread with weight alone. Only the
    // one-line layout is shaped that way, so the two conditions travel
    // together.
    const mvRow = interfaceLayout === 'mountain-view' && oneLineRow;
    const mvMobileRow = interfaceLayout === 'mountain-view' && isMobile;
    const trimmedPreview = cleanPreview(email.preview);
    const inlinePreview = showPreview && trimmedPreview ? ` ${trimmedPreview}` : '';
    // Search hits carry server snippets with the matched terms marked; they
    // replace the plain subject / preview so the user sees why a mail matched.
    const subjectSnippet = email.searchSnippet?.subject ?? null;
    const previewSnippet = showPreview ? (email.searchSnippet?.preview ?? null) : null;
    const scheduledSendLabel = email.isScheduled && email.scheduledSendAt
      ? formatScheduledSendAt(email.scheduledSendAt, timeFormat)
      : null;

    const tagIds = sortTagIds(getEmailTagIds(email.keywords));
    // The account tint stands in for the per-account dot, so it outranks the
    // tag tint - the tag still shows its own colour on its chip.
    //
    // `accountId` only resolves to a local account for personal entries; shared
    // ones carry the JMAP owner id, which no AccountEntry matches. Falling back
    // to the reaching client and then to a colour derived from the label means
    // every row that knows which account it came from gets tinted, instead of
    // silently staying blank.
    const accountTintSource = accountColor
      ?? (email.sourceClientAccountId ? getAccountById(email.sourceClientAccountId)?.avatarColor : undefined)
      ?? (email.accountLabel ? generateAvatarColor(email.accountLabel) : undefined);
    const accountRowTint = (tintListRowsByAccount && isUnifiedView && accountTintSource)
      ? (KEYWORD_PALETTE[accountTintKey(accountTintSource)]?.rowTint ?? null)
      : null;
    const resolvedRowTint = accountRowTint
      ?? (!tintListRowsByTag ? null : (rowTint ?? (tagIds[0] ? tagColor(tagIds[0]).rowTint : null)));

    const { dragHandlers, isDragging } = useEmailDrag({
      email,
      sourceMailboxId: selectedMailbox,
    });

    const [hoverActionsArmed, armHoverActions] = useArmOnPointerOver();
    const { onTouchStart, onTouchEnd, onTouchMove, onTouchCancel, isPressed } = useLongPress(
      useCallback((pos) => {
        onContextMenu?.(
          { preventDefault: () => {}, stopPropagation: () => {}, clientX: pos.clientX, clientY: pos.clientY } as React.MouseEvent,
          email
        );
      }, [onContextMenu, email]),
      isMobile
    );
    const longPressHandlers = { onTouchStart, onTouchEnd, onTouchMove, onTouchCancel };

    // Mobile swipe actions (Gmail-style): drag a row left/right to fire the
    // configured action. Desktop keeps hover actions + context menu.
    const runSwipeAction = useCallback((action: SwipeAction) => {
      switch (action) {
        case 'archive': onArchive?.(); break;
        case 'delete': onDelete?.(); break;
        case 'markRead': onMarkAsRead?.(isUnread); break; // unread -> read, read -> unread
        case 'star': onToggleStar?.(); break;
        case 'spam': onMarkAsSpam?.(); break;
        default: break;
      }
    }, [onArchive, onDelete, onMarkAsRead, onToggleStar, onMarkAsSpam, isUnread]);
    const isActionable = (action: SwipeAction): boolean => {
      switch (action) {
        case 'archive': return !!onArchive;
        case 'delete': return !!onDelete;
        case 'markRead': return !!onMarkAsRead;
        case 'star': return !!onToggleStar;
        case 'spam': return !!onMarkAsSpam;
        default: return false;
      }
    };
    const hasRight = isActionable(swipeRightAction);
    const hasLeft = isActionable(swipeLeftAction);
    const swipeEnabled = swipeRows && (hasLeft || hasRight);
    const { swipeHandlers, offsetX, side: swipeSide, willCommit, consumeTap } = useSwipeActions({
      enabled: swipeEnabled,
      hasLeft,
      hasRight,
      onCommit: (s) => runSwipeAction(s === 'right' ? swipeRightAction : swipeLeftAction),
    });
    const swipeActiveAction = swipeSide === 'right' ? swipeRightAction : swipeSide === 'left' ? swipeLeftAction : 'none';
    const swipeMeta = swipeActiveAction !== 'none' ? SWIPE_ACTION_META[swipeActiveAction] : null;
    const touchHandlers = swipeEnabled
      ? {
          onTouchStart: (e: React.TouchEvent) => { longPressHandlers.onTouchStart(e); swipeHandlers.onTouchStart(e); },
          onTouchMove: (e: React.TouchEvent) => { longPressHandlers.onTouchMove(e); swipeHandlers.onTouchMove(e); },
          onTouchEnd: (e: React.TouchEvent) => { longPressHandlers.onTouchEnd(e); swipeHandlers.onTouchEnd(); },
          onTouchCancel: () => { longPressHandlers.onTouchCancel(); swipeHandlers.onTouchCancel(); },
        }
      : longPressHandlers;

    const handleCheckboxClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (e.shiftKey) {
        selectRangeEmails(email);
      } else {
        toggleEmailSelection(email);
      }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      onContextMenu?.(e, email);
    };

    // The row's name for screen readers, in the order people scan a row.
    const a11yLabel = rowLabel([
      isUnread && t('unread'),
      sender?.name || (sender?.email && formatAddress(sender.email)) || tUnknown,
      email.subject || tNoSubject,
      formatDate(emailListDate(email)),
      isPinned && tStatus('pinned'),
      isStarred && tStatus('starred'),
      isAnswered && tStatus('replied'),
      isForwarded && tStatus('forwarded'),
      showPaperclip && tStatus('has_attachment'),
      announceRowPreview && trimmedPreview,
    ]);

    // Once something is ticked, the whole row is the checkbox, as in phone
    // mail apps (#1014). Mountain View on the desktop opens the message and
    // keeps the ticks instead, as Gmail does (#1231).
    const togglesOnClick = selecting && !mvRow;

    const handleClick = (e: React.MouseEvent) => {
      if (swipeEnabled && consumeTap()) { return; }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        toggleEmailSelection(email);
      } else if (e.shiftKey) {
        e.preventDefault();
        selectRangeEmails(email);
      } else if (togglesOnClick) {
        toggleEmailSelection(email);
      } else {
        // Mountain View keeps the ticked rows while a message is read, as
        // Gmail does, so selecting can carry on afterwards. (#1231)
        onClick();
      }
    };

    return (
      <div
        ref={ref}
        {...dragHandlers}
        {...touchHandlers}
        data-testid="email-list-item"
        onPointerOver={armHoverActions}
        // The row itself takes focus on click and from the keyboard; its actions
        // come from Shift+F10 there, so only a control inside it arms them.
        onFocus={(e) => { if (e.target !== e.currentTarget) armHoverActions(); }}
        onPointerDown={(e) => { if (onPrefetch && isMousePressOnRow(e)) onPrefetch(); }}
        data-email-id={email.id}
        data-subject={email.subject || ''}
        data-unread={isUnread ? 'true' : 'false'}
        data-starred={email.keywords?.$flagged ? 'true' : 'false'}
        data-mv-mobile-row={mvMobileRow ? "" : undefined}
        data-mv-row={mvRow && !resolvedRowTint ? "" : undefined}
        data-checked={isChecked ? "" : undefined}
        {...rowA11yProps({
          rowKey: emailKeyFor(email),
          label: a11yLabel,
          selected,
          checked: isChecked,
          selectionMode: selecting,
          onToggleCheck: () => toggleEmailSelection(email),
          onOpenMenu: onContextMenu ? handleContextMenu : undefined,
        })}
        className={cn(
          "@container/mail-row relative group cursor-pointer select-none transition-shadow duration-200 border-b border-border overflow-hidden",
          mvMobileRow && "border-b-transparent",
          resolvedRowTint ? resolvedRowTint : (
            selected
              ? "bg-accent"
              : mvRow && !isUnread
                ? "bg-muted/60"
                : "bg-background"
          ),
          selected && !resolvedRowTint && "shadow-sm",
          !resolvedRowTint && !selected && !isChecked && "hover:bg-muted hover:shadow-sm",
          !resolvedRowTint && (selected || isChecked) && "hover:bg-accent hover:shadow-sm",
          resolvedRowTint && "hover:brightness-95 dark:hover:brightness-110",
          isUnread && !resolvedRowTint && !mvRow && !mvMobileRow && "bg-accent/30",
          isChecked && "ring-2 ring-primary/20",
          isChecked && !resolvedRowTint && "bg-accent/40",
          isDragging && "opacity-50 scale-[0.98] ring-2 ring-primary/30",
          isPressed && "scale-[0.98] ring-2 ring-primary/30",
          isPressed && !resolvedRowTint && "bg-muted"
        )}
        onClick={handleClick}
        onDoubleClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          if (!onDoubleClick || togglesOnClick) return;
          e.preventDefault();
          onDoubleClick();
        }}
        onContextMenu={handleContextMenu}
        data-menu-row=""
        style={{ minHeight: oneLineRow ? undefined : 'var(--list-item-height)', touchAction: swipeEnabled ? 'pan-y' : undefined }}
      >
        {showRowActionButton && onContextMenu && (
          // For pointers that can't hover or right-click (MO-18); keyboards use
          // Shift+F10 on the row, so it stays out of the Tab order.
          <div role="gridcell" className="absolute end-2 top-1/2 z-20 -translate-y-1/2">
            <button
              type="button"
              data-row-actions=""
              onClick={(e) => { e.stopPropagation(); handleContextMenu(e); }}
              aria-label={tStatus('row_actions')}
              title={tStatus('row_actions')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        )}
        {swipeEnabled && swipeMeta && (
          // Decorative reveal on the physically exposed edge. That edge
          // follows the (physical) translate direction, not text direction,
          // so force LTR to keep justify-start/-end as physical left/right
          // (otherwise the icon flips to the wrong side under RTL).
          <div
            aria-hidden
            dir="ltr"
            className={cn('absolute inset-0 z-0 flex items-center px-5 text-white', swipeMeta.bg, swipeSide === 'right' ? 'justify-start' : 'justify-end')}
          >
            <swipeMeta.icon className={cn('h-5 w-5 transition-transform', willCommit ? 'scale-110' : 'scale-90 opacity-80')} />
          </div>
        )}
        <div
          role="gridcell"
          data-row-text=""
          className={cn('px-3', showRowActionButton && onContextMenu && 'pe-12', oneLineRow ? 'flex items-center' : 'flex items-start', mvRow && 'min-h-[var(--list-item-height)]', swipeEnabled && 'relative z-10 bg-inherit')}
          style={{ gap: 'var(--density-item-gap)', paddingBlock: mvRow ? undefined : 'var(--density-item-py)', transform: swipeEnabled && offsetX ? `translateX(${offsetX}px)` : undefined, transition: swipeEnabled && offsetX === 0 ? 'transform 200ms ease-out' : undefined }}
        >
          {/* Checkbox - only for extra-compact density (no avatar) while in selection mode */}
          {!mvRow && density === 'extra-compact' && selecting && (
            <button
              onClick={handleCheckboxClick}
              role="checkbox"
              aria-checked={isChecked}
              aria-label={selectRowLabel}
              className={cn(
                "p-3 lg:p-1 rounded flex-shrink-0 transition-all duration-200",
                !oneLineRow && 'mt-2',
                "hover:bg-muted/50 hover:scale-110",
                "active:scale-95",
                "animate-in fade-in zoom-in-95 duration-150",
                isChecked && "text-primary"
              )}
            >
              {isChecked ? (
                <CheckSquare className="w-4 h-4 animate-in zoom-in-50 duration-200" />
              ) : (
                <Square className="w-4 h-4 text-muted-foreground opacity-60 hover:opacity-100 transition-opacity" />
              )}
            </button>
          )}

          {mvRow && (
            <MvRowLead
              checked={isChecked}
              onToggleChecked={handleCheckboxClick}
              starred={!!isStarred}
              onToggleStar={onToggleStar}
              selectLabel={selectRowLabel}
              starLabel={tHover('star')}
            />
          )}

          {!mvRow && density !== 'extra-compact' && (
            <AvatarGutter onToggle={handleCheckboxClick}>
              <div className="relative flex flex-shrink-0">
                <SelectableAvatar
                  // Its image state is about the sender: a row that shows another message (useRowSlots) starts it afresh.
                  key={`${sender?.email ?? ''}|${sender?.name ?? ''}`}
                  name={sender?.name}
                  email={sender?.email}
                  size={oneLineRow ? "sm" : "md"}
                  className="shadow-sm"
                  disableImages={hideJunkAvatarImages}
                  senderWarning={senderWarning}
                  brandDomain={showRecipient ? undefined : brandIndicatorDomain(email)}
                  checked={isChecked}
                  onToggle={handleCheckboxClick}
                  selectLabel={selectRowLabel}
                />
                {isUnread && <UnreadDot besideAvatar />}
              </div>
            </AvatarGutter>
          )}

          {isUnread && !mvRow && density === 'extra-compact' && (
            <UnreadDot besideAvatar={false} />
          )}

          <div className="flex-1 min-w-0">
            {oneLineRow ? (
              <>
              <div className={cn("flex items-center justify-between gap-3", mvRow && "min-h-[var(--list-item-height)]")}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {/* In columns the dot sits inside the From cell, so a row
                      with it starts its columns where the header does. */}
                  {!columns && isUnifiedView && email.accountId && accountColor && showAccountDot && (
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: accountColor }}
                      title={accountDescription}
                    >
                      <span className="sr-only">{accountDescription}</span>
                    </span>
                  )}
                  <span dir={columns ? undefined : "auto"} className={cn(
                    columns ? cn(LIST_COLUMN_CLASS.from, 'flex items-center gap-2') : 'w-32 min-w-0 shrink truncate lg:w-40',
                    'text-sm',
                    isUnread ? (mvRow ? 'font-bold text-foreground' : 'font-semibold text-foreground') : 'font-medium text-foreground/80'
                  )}>
                    {columns ? (
                      <>
                        {/* Where a conversation row has its chevron. */}
                        <span aria-hidden="true" className="w-3.5 shrink-0" />
                        {isUnifiedView && email.accountId && accountColor && showAccountDot && (
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: accountColor }}
                            title={accountDescription}
                          >
                            <span className="sr-only">{accountDescription}</span>
                          </span>
                        )}
                        <span dir="auto" className="min-w-0 truncate">
                          {sender?.name || (sender?.email && formatAddress(sender.email)) || tUnknown}
                        </span>
                      </>
                    ) : (sender?.name || (sender?.email && formatAddress(sender.email)) || tUnknown)}
                  </span>
                  <div className={cn("flex min-w-0 flex-1 items-center overflow-hidden text-sm", mvRow ? "gap-0" : "gap-2")}>
                    {tagIds.length > 0 && (
                      <span className={cn(ROW_TAG_GROUP_CLASS, mvRow && "me-2")}>
                        {tagIds.map((id) => (
                          <TagBadge key={id} tagId={id} variant={tagVariant} scope={tagScope} className="max-w-[min(12rem,100%)]" />
                        ))}
                      </span>
                    )}
                    <span dir="auto" className={cn(
                      'min-w-0 truncate',
                      isUnread ? (mvRow ? 'font-bold text-foreground' : 'font-semibold text-foreground') : 'text-foreground/90'
                    )}>
                      <bdi>{subjectSnippet ? <SearchSnippetText snippet={subjectSnippet} /> : (email.subject || tNoSubject)}</bdi>
                    </span>
                    <PluginRowBadges key={emailKeyFor(email)} email={email} className={mvRow ? "ms-2" : undefined} />
                    {(previewSnippet || inlinePreview) && (
                      <span dir="auto" className="min-w-0 flex-1 shrink-[9999] truncate text-muted-foreground">
                        {/* Gmail runs the snippet on from the subject after a dash. */}
                        {mvRow && '\u00a0-\u00a0'}
                        {previewSnippet ? <> <SearchSnippetText snippet={previewSnippet} /></> : (mvRow ? trimmedPreview : inlinePreview)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  {isPinned && <StatusIcon icon={Pin} label={tStatus('pinned')} className="w-3.5 h-3.5 text-primary" />}
                  {isStarred && !mvRow && <StatusIcon icon={Star} label={tStatus('starred')} className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />}
                  {isAnswered && !isForwarded && !mvRow && <StatusIcon icon={Reply} label={tStatus('replied')} className="w-3.5 h-3.5 text-muted-foreground" />}
                  {isForwarded && !isAnswered && !mvRow && <StatusIcon icon={Forward} label={tStatus('forwarded')} className="w-3.5 h-3.5 text-muted-foreground" />}
                  {isAnswered && isForwarded && !mvRow && (
                    <>
                      <StatusIcon icon={Reply} label={tStatus('replied')} className="w-3.5 h-3.5 text-muted-foreground" />
                      <StatusIcon icon={Forward} label={tStatus('forwarded')} className="w-3.5 h-3.5 text-muted-foreground" />
                    </>
                  )}
                  {showPaperclip && <StatusIcon icon={Paperclip} label={tStatus('has_attachment')} className="w-3.5 h-3.5 text-muted-foreground" />}
                  {showSourceFolder && <SourceFolderTag name={email.sourceFolder!} role={email.sourceFolderRole} tight={senderLineTight} />}
                  {scheduledSendLabel ? (
                    <span
                      className={cn("inline-flex max-w-[11rem] shrink-0 items-center gap-1 truncate rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-xs font-medium tabular-nums text-sky-700 dark:text-sky-300", columns && "max-w-28")}
                      title={scheduledSendLabel}
                    >
                      <CalendarClock className="h-3 w-3 shrink-0" />
                      <span className="truncate">{scheduledSendLabel}</span>
                    </span>
                  ) : (
                    <span className={cn(
                      'text-xs tabular-nums',
                      columns && LIST_COLUMN_CLASS.date,
                      isUnread ? (mvRow ? 'text-foreground font-bold' : 'text-foreground font-semibold') : 'text-muted-foreground'
                    )}>
                      {formatDate(emailListDate(email), mvRow ? { listStyle: 'mountain-view' } : undefined)}
                    </span>
                  )}
                  {columns && <SizeCell bytes={email.size} />}
                </div>
              </div>
              {mvRow && (
                <RowChips key={emailKeyFor(email)} email={email} loadAttachments={loadAttachments} onOpenAttachment={onOpenAttachment} mvRow />
              )}
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {isUnifiedView && email.accountId && accountColor && showAccountDot && (
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: accountColor }}
                        title={accountDescription}
                      >
                        <span className="sr-only">{accountDescription}</span>
                      </span>
                    )}
                    <span dir="auto" className={cn(
                      "flex-1 min-w-0 truncate text-sm",
                      isUnread
                        ? "font-bold text-foreground"
                        : "font-medium text-muted-foreground"
                    )}>
                      {sender?.name || (sender?.email && formatAddress(sender.email)) || tUnknown}
                    </span>
                    {tagPlacement === 'sender' && tagIds.length > 0 && (
                      <span className={ROW_TAG_GROUP_CLASS}>
                        {tagIds.map((id) => (
                          <TagBadge key={id} tagId={id} variant={senderLineTight && (showSourceFolder || tagIds.length > 1) ? 'dot' : tagVariant} scope={tagScope} className="max-w-[min(12rem,100%)]" />
                        ))}
                      </span>
                  )}
                    <div className="flex shrink-0 items-center gap-1.5">
                      {isPinned && (
                        <StatusIcon icon={Pin} label={tStatus('pinned')} className="w-3.5 h-3.5 text-primary" />
                      )}
                      {isStarred && !mvMobileRow && (
                        <StatusIcon icon={Star} label={tStatus('starred')} className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                      )}
                      {isAnswered && !isForwarded && (
                        <StatusIcon icon={Reply} label={tStatus('replied')} className="w-3.5 h-3.5 text-muted-foreground" />
                      )}
                      {isForwarded && !isAnswered && (
                        <StatusIcon icon={Forward} label={tStatus('forwarded')} className="w-3.5 h-3.5 text-muted-foreground" />
                      )}
                      {isAnswered && isForwarded && (
                        <>
                          <StatusIcon icon={Reply} label={tStatus('replied')} className="w-3.5 h-3.5 text-muted-foreground" />
                          <StatusIcon icon={Forward} label={tStatus('forwarded')} className="w-3.5 h-3.5 text-muted-foreground" />
                        </>
                      )}
                      {showPaperclip && (
                        <StatusIcon icon={Paperclip} label={tStatus('has_attachment')} className="w-3.5 h-3.5 text-muted-foreground" />
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {showSourceFolder && <SourceFolderTag name={email.sourceFolder!} role={email.sourceFolderRole} tight={senderLineTight} />}
                    {scheduledSendLabel ? (
                      <span
                        className="inline-flex max-w-[11rem] shrink-0 items-center gap-1 truncate rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[0.6875rem] font-medium tabular-nums text-sky-700 dark:text-sky-300"
                        title={scheduledSendLabel}
                      >
                        <CalendarClock className="h-3 w-3 shrink-0" />
                        <span className="truncate">{scheduledSendLabel}</span>
                      </span>
                    ) : (
                      <span className={cn(
                        "text-xs tabular-nums",
                        isUnread
                          ? "text-foreground font-semibold"
                          : "text-muted-foreground"
                      )}>
                        {formatDate(emailListDate(email))}
                      </span>
                    )}
                    {mvMobileRow && !(showPreview && density !== 'extra-compact' && density !== 'compact') && (
                      <MvMobileStar
                        starred={!!isStarred}
                        onToggle={onToggleStar}
                        label={tHover('star')}
                      />
                    )}
                  </div>
                </div>

                <div className="mb-1 flex min-w-0 items-center gap-1.5">
                  {tagPlacement === 'subject' && tagIds.length > 0 && (
                      <span className={ROW_TAG_GROUP_CLASS}>
                        {tagIds.map((id) => (
                          <TagBadge key={id} tagId={id} variant={tagVariant} scope={tagScope} className="max-w-[min(12rem,100%)]" />
                        ))}
                      </span>
                  )}
                  <span dir="auto" className={cn(
                    "flex-1 min-w-0 truncate text-sm",
                    isUnread
                      ? "font-semibold text-foreground"
                      : "font-normal text-foreground/90"
                  )}>
                    <bdi>{subjectSnippet ? <SearchSnippetText snippet={subjectSnippet} /> : (email.subject || tNoSubject)}</bdi>
                  </span>
                  <PluginRowBadges key={emailKeyFor(email)} email={email} />
                </div>

                {showPreview && density !== 'extra-compact' && density !== 'compact' && (
                  <div className={cn("flex min-w-0 items-center gap-1", !mvMobileRow && "contents")}>
                    <p dir="auto" className={cn(
                      "text-sm leading-relaxed",
                      mvMobileRow ? "line-clamp-1 min-w-0 flex-1" : density === 'comfortable' ? "line-clamp-2" : "line-clamp-1",
                      isUnread
                        ? "text-muted-foreground"
                        : "text-muted-foreground"
                    )}>
                      {previewSnippet ? <SearchSnippetText snippet={previewSnippet} /> : (trimmedPreview || t('no_preview_available'))}
                    </p>
                    {mvMobileRow && (
                      <MvMobileStar
                        starred={!!isStarred}
                        onToggle={onToggleStar}
                        label={tHover('star')}
                      />
                    )}
                  </div>
                )}
                <RowChips key={emailKeyFor(email)} email={email} loadAttachments={loadAttachments} onOpenAttachment={onOpenAttachment} mountainView={mvMobileRow} />
              </>
            )}
          </div>
        </div>

        {/* Hover Quick Actions */}
        {hoverActionsArmed && !email.isScheduled && (
          // A cell of its own: a row holds cells, not buttons (SR-01).
          <div role="gridcell">
          <EmailHoverActions
            key={emailKeyFor(email)}
            email={email}
            backgroundClassName={resolvedRowTint ? resolvedRowTint : mvRow ? mvHoverBackground(isChecked, isUnread, selected) : ((selected || isChecked) ? "bg-accent" : "bg-muted")}
            onToggleStar={onToggleStar}
            onMarkAsRead={onMarkAsRead}
            onDelete={onDelete}
            onArchive={onArchive}
            onSetTag={onSetTag}
            onMarkAsSpam={onMarkAsSpam}
            onUndoSpam={onUndoSpam}
            isInJunk={currentMailboxRole === 'junk'}
            spamApplicable={spamApplicableIn(currentMailboxRole)}
            mailboxRole={currentMailboxRole ?? null}
            pinToFirstLine={mvRow}
          />
          </div>
        )}
      </div>
    );
  }
);

/**
 * A list row. A conversation of one message is that message's row, drawn by
 * SingleEmailItem alone: the conversation row's hooks (swipe, long press,
 * drag, tags, sender check, a dozen store subscriptions) ran for it too,
 * only to hand everything to SingleEmailItem, which works it out again.
 */
const ThreadListItemRow = React.forwardRef<HTMLDivElement, ThreadListItemProps>(
  function ThreadListItemRow(props, ref) {
    const { thread } = props;
    // A conversation row holds state about its conversation: it is built
    // afresh for another one (see useRowSlots).
    if (thread.emailCount !== 1) return <ConversationRow key={thread.threadKey} {...props} ref={ref} />;
    const { latestEmail } = thread;
    const { onEmailSelect, onEmailDoubleClick, onPrefetch, onToggleStar, onMarkAsRead, onDelete, onArchive, onSetTag, onMarkAsSpam, onUndoSpam, onOpenAttachment } = props;
    return (
      <SingleEmailItem
        ref={ref}
        email={latestEmail}
        selected={props.selectedEmailKey === emailKeyFor(latestEmail)}
        onClick={() => onEmailSelect(latestEmail)}
        onDoubleClick={onEmailDoubleClick ? () => onEmailDoubleClick(latestEmail) : undefined}
        onPrefetch={onPrefetch ? () => onPrefetch(latestEmail) : undefined}
        onContextMenu={props.onContextMenu}
        // SingleEmailItem tints the row the same way (account, then tag).
        rowTint={null}
        onToggleStar={onToggleStar ? () => onToggleStar(latestEmail) : undefined}
        onMarkAsRead={onMarkAsRead ? (read) => onMarkAsRead(latestEmail, read) : undefined}
        onDelete={onDelete ? () => onDelete(latestEmail) : undefined}
        onArchive={onArchive ? () => onArchive(latestEmail) : undefined}
        onSetTag={onSetTag ? (color) => onSetTag(latestEmail.id, color, emailKeyFor(latestEmail)) : undefined}
        onMarkAsSpam={onMarkAsSpam ? () => onMarkAsSpam(latestEmail) : undefined}
        onUndoSpam={onUndoSpam ? () => onUndoSpam(latestEmail) : undefined}
        onOpenAttachment={onOpenAttachment ? (a) => onOpenAttachment(latestEmail, a) : undefined}
        loadAttachments={props.loadAttachments}
        listFolder={props.listFolder}
      />
    );
  }
);

const ConversationRow = React.forwardRef<HTMLDivElement, ThreadListItemProps>(
  function ConversationRow({
    onOpenAttachment,
    loadAttachments,
    thread,
    isExpanded,
    selectedEmailKey,
    isLoading = false,
    expandedEmails,
    onToggleExpand,
    onCollapseAllThreads,
    onEmailSelect,
    onEmailDoubleClick,
    onPrefetch,
    onContextMenu,
    onOpenConversation,
    conversationInReader = false,
    onToggleStar,
    onMarkAsRead,
    onDelete,
    onArchive,
    onSetTag,
    onMarkAsSpam,
    onUndoSpam,
    listFolder,
  }, ref) {
    const { threads: t, viewer: tEmailViewer, batch: tBatch, hover: tHover, list: tStatus } = useRowTranslators()!;
    const tNoSubject = tEmailViewer('no_subject');
    const showPreview = useSettingsStore((state) => state.showPreview);
    const density = useSettingsStore((state) => state.density);
    const timeFormat = useSettingsStore((state) => state.timeFormat);
    const showAvatarsInJunk = useSettingsStore((state) => state.showAvatarsInJunk);
    const interfaceLayout = useSettingsStore((state) => state.interfaceLayout);
    const isMobile = useUIStore((state) => state.isMobile);
    const swipeRows = useSwipeRows();
    const { latestEmail, participantNames, hasUnread, hasStarred, hasPinned, hasAnswered, hasForwarded, emailCount } = thread;
    // Only the latest email's parts are loaded; an older one with the flag keeps the paperclip.
    const latestHasAttachment = useListHasAttachment(latestEmail, loadAttachments);
    const hasAttachment = latestHasAttachment || thread.emails.some((e) => e !== latestEmail && e.hasAttachment);
    // One line per row where the list has the full width; stacked on phones.
    const { oneLine: oneLineRow, columns } = useListRowShape();
    // Mountain View leads its rows with a checkbox and a clickable star
    // instead of an avatar, and marks unread with weight alone. Only the
    // one-line layout is shaped that way, so the two conditions travel
    // together.
    const mvRow = interfaceLayout === 'mountain-view' && oneLineRow;
    const mvMobileRow = interfaceLayout === 'mountain-view' && isMobile;
    const trimmedPreview = cleanPreview(latestEmail.preview);
    const inlinePreview = showPreview && trimmedPreview ? ` ${trimmedPreview}` : '';
    // In a search the matched mail need not be the thread's latest one: show
    // the snippet of whichever email in the thread carries one.
    const threadSnippet = thread.emails.find((e) => e.searchSnippet)?.searchSnippet ?? latestEmail.searchSnippet;
    const subjectSnippet = threadSnippet?.subject ?? null;
    const previewSnippet = showPreview ? (threadSnippet?.preview ?? null) : null;
    const scheduledSendLabel = latestEmail.isScheduled && latestEmail.scheduledSendAt
      ? formatScheduledSendAt(latestEmail.scheduledSendAt, timeFormat)
      : null;

    // The role, not the folder list: the list is a new array on every
    // count update, and subscribing to it re-rendered every row for each.
    const { mailboxId: selectedMailbox, role: currentMailboxRole } = useRowFolder(listFolder);
    // See SingleEmailItem: what the selection means for this row, not the selection.
    const { isChecked, selecting, toggleEmailSelection, selectRangeEmails, isUnifiedView } = useEmailStore(useShallow((state) => ({
      isChecked: thread.emails.some((e) => state.selectedEmailKeys.has(emailKeyFor(e))),
      selecting: state.selectedEmailKeys.size > 0,
      toggleEmailSelection: state.toggleEmailSelection,
      selectRangeEmails: state.selectRangeEmails,
      isUnifiedView: state.isUnifiedView,
    })));
    const showSourceFolder = useShowSourceFolder(latestEmail.sourceFolder);
    const getAccountById = useAccountStore((state) => state.getAccountById);
    const threadAccount = latestEmail.accountId ? getAccountById(latestEmail.accountId) : undefined;
    const threadAccountColor = threadAccount?.avatarColor;
    const threadAccountDescription = describeAccount(latestEmail.accountLabel, threadAccount);
    // In Sent/Drafts folders, show recipient instead of sender (which is always
    // "me"). Aggregate role-views use a virtual selected mailbox → fall back to
    // the unified role so junk-contextual UI and avatar hiding work.
    const showRecipient = currentMailboxRole === 'sent' || currentMailboxRole === 'drafts';
    const displayNames = showRecipient
      ? Array.from(new Set(
          thread.emails.flatMap(e => (e.to ?? []).map(r => r.name || r.email.split('@')[0]))
        )).slice(0, 4)
      : participantNames;
    const avatarPerson = showRecipient ? latestEmail.to?.[0] : latestEmail.from?.[0];
    const selectRowLabel = tBatch('select_row', {
      sender: avatarPerson?.name || avatarPerson?.email || '',
      subject: latestEmail.subject || tEmailViewer('no_subject'),
    });
    const hideJunkAvatarImages = currentMailboxRole === 'junk' && !showAvatarsInJunk;
    const senderWarning = useSenderWarning(showRecipient ? undefined : latestEmail);

    const { dragHandlers, isDragging: isThreadDragging } = useEmailDrag({
      email: latestEmail,
      sourceMailboxId: selectedMailbox,
      threadEmails: thread.emails,
    });

    const [hoverActionsArmed, armHoverActions] = useArmOnPointerOver();
    const { onTouchStart: threadOnTouchStart, onTouchEnd: threadOnTouchEnd, onTouchMove: threadOnTouchMove, onTouchCancel: threadOnTouchCancel, isPressed: isThreadPressed } = useLongPress(
      useCallback((pos) => {
        onContextMenu?.(
          { preventDefault: () => {}, stopPropagation: () => {}, clientX: pos.clientX, clientY: pos.clientY } as React.MouseEvent,
          latestEmail
        );
      }, [onContextMenu, latestEmail]),
      isMobile
    );
    const threadLongPressHandlers = { onTouchStart: threadOnTouchStart, onTouchEnd: threadOnTouchEnd, onTouchMove: threadOnTouchMove, onTouchCancel: threadOnTouchCancel };

    // The same swipe as a single message's row (MAIL-27), on what the row's
    // actions act on: the newest message.
    const threadSwipeRightAction = useSettingsStore((state) => state.swipeRightAction);
    const threadSwipeLeftAction = useSettingsStore((state) => state.swipeLeftAction);
    const runThreadSwipe = (action: SwipeAction) => {
      switch (action) {
        case 'archive': onArchive?.(latestEmail); break;
        case 'delete': onDelete?.(latestEmail); break;
        case 'markRead': onMarkAsRead?.(latestEmail, hasUnread); break;
        case 'star': onToggleStar?.(latestEmail); break;
        case 'spam': onMarkAsSpam?.(latestEmail); break;
        default: break;
      }
    };
    const threadActionable = (action: SwipeAction): boolean => {
      switch (action) {
        case 'archive': return !!onArchive;
        case 'delete': return !!onDelete;
        case 'markRead': return !!onMarkAsRead;
        case 'star': return !!onToggleStar;
        case 'spam': return !!onMarkAsSpam;
        default: return false;
      }
    };
    const threadHasRight = threadActionable(threadSwipeRightAction);
    const threadHasLeft = threadActionable(threadSwipeLeftAction);
    const threadSwipeEnabled = swipeRows && (threadHasLeft || threadHasRight);
    const {
      swipeHandlers: threadSwipeHandlers, offsetX: threadOffsetX, side: threadSwipeSide,
      willCommit: threadWillCommit, consumeTap: threadConsumeTap,
    } = useSwipeActions({
      enabled: threadSwipeEnabled,
      hasLeft: threadHasLeft,
      hasRight: threadHasRight,
      onCommit: (s) => runThreadSwipe(s === 'right' ? threadSwipeRightAction : threadSwipeLeftAction),
    });
    const threadSwipeAction = threadSwipeSide === 'right' ? threadSwipeRightAction : threadSwipeSide === 'left' ? threadSwipeLeftAction : 'none';
    const threadSwipeMeta = threadSwipeAction !== 'none' ? SWIPE_ACTION_META[threadSwipeAction] : null;
    const threadTouchHandlers = threadSwipeEnabled
      ? {
          onTouchStart: (e: React.TouchEvent) => { threadLongPressHandlers.onTouchStart(e); threadSwipeHandlers.onTouchStart(e); },
          onTouchMove: (e: React.TouchEvent) => { threadLongPressHandlers.onTouchMove(e); threadSwipeHandlers.onTouchMove(e); },
          onTouchEnd: (e: React.TouchEvent) => { threadLongPressHandlers.onTouchEnd(e); threadSwipeHandlers.onTouchEnd(); },
          onTouchCancel: () => { threadLongPressHandlers.onTouchCancel(); threadSwipeHandlers.onTouchCancel(); },
        }
      : threadLongPressHandlers;

    const tagScope = useEmailTagScope(latestEmail);
    const { sortTagIds, tagColor } = useKeywordFormat(tagScope);
    const { variant: tagVariant, placement: tagPlacement, tight: senderLineTight } = useTagDisplay();
    const tintListRowsByTag = useSettingsStore((state) => state.tintListRowsByTag);
    const tintListRowsByAccount = useSettingsStore((state) => state.tintListRowsByAccount);
    // The tint replaces the dot, and the dot can be switched off on its own (#912).
    const showAccountDot = useShowAccountDot(tintListRowsByAccount);
    // A collapsed row speaks for every message under it, so it carries their tags too.
    const tagIds = sortTagIds(getThreadTagIds(thread.emails));
    const threadTintSource = threadAccountColor
      ?? (latestEmail.sourceClientAccountId ? getAccountById(latestEmail.sourceClientAccountId)?.avatarColor : undefined)
      ?? (latestEmail.accountLabel ? generateAvatarColor(latestEmail.accountLabel) : undefined);
    const accountRowTint = (tintListRowsByAccount && isUnifiedView && threadTintSource)
      ? (KEYWORD_PALETTE[accountTintKey(threadTintSource)]?.rowTint ?? null)
      : null;
    const rowTint = accountRowTint
      ?? ((tintListRowsByTag && tagIds[0]) ? tagColor(tagIds[0]).rowTint : null);

    const isSelected = selectedEmailKey === emailKeyFor(latestEmail) ||
      thread.emails.some(e => emailKeyFor(e) === selectedEmailKey);

    const announceRowPreview = useSettingsStore((state) => state.announceRowPreview);
    const showRowActionButton = useSettingsStore((state) => state.showRowActionButton);

    const emailsToShow = expandedEmails || thread.emails;

    // Toggle selection for all emails in this thread.
    const toggleThreadSelection = () => {
      const { selectedEmailKeys } = useEmailStore.getState();
      const allSelected = thread.emails.every(em => selectedEmailKeys.has(emailKeyFor(em)));
      const newSelection = new Set(selectedEmailKeys);
      thread.emails.forEach(em => {
        if (allSelected) {
          newSelection.delete(emailKeyFor(em));
        } else {
          newSelection.add(emailKeyFor(em));
        }
      });
      useEmailStore.setState({ selectedEmailKeys: newSelection, lastSelectedEmailKey: emailKeyFor(latestEmail) });
    };

    const handleThreadCheckboxClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (e.shiftKey) {
        selectRangeEmails(latestEmail);
        return;
      }
      toggleThreadSelection();
    };

    // See SingleEmailItem: with rows ticked, a click ticks instead of opening.
    const threadTogglesOnClick = selecting && !mvRow;

    const handleHeaderClick = (e: React.MouseEvent) => {
      if (threadSwipeEnabled && threadConsumeTap()) { return; }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Ctrl+Click: toggle selection for all thread emails
        thread.emails.forEach(em => toggleEmailSelection(em));
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        selectRangeEmails(latestEmail);
        return;
      }

      // In selection mode the row ticks the whole thread (#1014); the
      // chevron still unfolds it.
      const target = e.target as HTMLElement;
      if (threadTogglesOnClick && !target.closest('[data-expand-toggle]')) {
        toggleThreadSelection();
        return;
      }

      // Mountain View opens the conversation in the reading pane, as Gmail
      // does, rather than unfolding it inside the list. On the phone too: the
      // separate phone thread view would list it newest first. (#1224)
      if (isMobile && onOpenConversation && !mvMobileRow) {
        onOpenConversation(thread);
        return;
      }

      // So does the default layout, whose reading pane shows the conversation.
      if (mvRow || mvMobileRow || conversationInReader) {
        // Desktop keeps the ticked rows while the conversation is read (#1231).
        onEmailSelect(latestEmail);
        return;
      }

      if (target.closest('[data-expand-toggle]')) {
        onToggleExpand();
      } else {
        if (!isExpanded) {
          onCollapseAllThreads?.();
          onToggleExpand();
        }
        onEmailSelect(latestEmail);
      }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      onContextMenu?.(e, latestEmail);
    };

    const threadSubject = latestEmail.subject || tNoSubject;
    const a11yLabel = rowLabel([
      hasUnread && tEmailViewer('unread'),
      displayNames.join(', '),
      threadSubject,
      t('messages_tooltip', { count: emailCount }),
      formatDate(emailListDate(latestEmail)),
      hasPinned && tStatus('pinned'),
      hasStarred && tStatus('starred'),
      hasAnswered && tStatus('replied'),
      hasForwarded && tStatus('forwarded'),
      hasAttachment && tStatus('has_attachment'),
      announceRowPreview && trimmedPreview,
    ]);

    return (
      <div ref={ref} role="presentation" className={cn(
        "border-b border-border",
        mvMobileRow && "border-b-transparent",
        isThreadDragging && "opacity-50 scale-[0.98] ring-2 ring-primary/30"
      )}>
        <div
          {...dragHandlers}
          {...threadTouchHandlers}
          onPointerOver={armHoverActions}
          // The row itself takes focus on click and from the keyboard; its actions
          // come from Shift+F10 there, so only a control inside it arms them.
          onFocus={(e) => { if (e.target !== e.currentTarget) armHoverActions(); }}
          onPointerDown={(e) => { if (onPrefetch && isMousePressOnRow(e)) onPrefetch(latestEmail); }}
          {...rowA11yProps({
            rowKey: emailKeyFor(latestEmail),
            label: a11yLabel,
            selected: isSelected && !isExpanded,
            expanded: conversationInReader ? undefined : isExpanded,
            checked: isChecked,
            selectionMode: selecting,
            onToggleCheck: toggleThreadSelection,
            onOpenMenu: onContextMenu ? handleContextMenu : undefined,
          })}
          // Every message in the conversation: the open one may be any of them.
          data-thread-keys={thread.emails.map((e) => emailKeyFor(e)).join(' ')}
          data-unread={hasUnread ? 'true' : 'false'}
          data-mv-mobile-row={mvMobileRow ? "" : undefined}
          data-mv-row={mvRow && !rowTint ? "" : undefined}
          data-checked={isChecked ? "" : undefined}
          className={cn(
            "@container/mail-row relative group cursor-pointer select-none transition-shadow duration-200 overflow-hidden",
            rowTint ? rowTint : (
              isSelected
                ? "bg-accent"
                : mvRow && !hasUnread
                  ? "bg-muted/60"
                  : "bg-background"
            ),
            isSelected && !rowTint && "shadow-sm",
            !rowTint && !isSelected && !isChecked && "hover:bg-muted hover:shadow-sm",
            !rowTint && (isSelected || isChecked) && "hover:bg-accent hover:shadow-sm",
            rowTint && "hover:brightness-95 dark:hover:brightness-110",
            hasUnread && !rowTint && !isSelected && !mvRow && !mvMobileRow && "bg-accent/30",
            isExpanded && "border-b border-border/50",
            isChecked && "ring-2 ring-primary/20",
            isChecked && !rowTint && "bg-accent/40",
            isThreadPressed && "scale-[0.98] ring-2 ring-primary/30",
            isThreadPressed && !rowTint && "bg-muted"
          )}
          onClick={handleHeaderClick}
          onDoubleClick={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (!onEmailDoubleClick || threadTogglesOnClick) return;
            e.preventDefault();
            onEmailDoubleClick(latestEmail);
          }}
          onContextMenu={handleContextMenu}
          data-menu-row=""
          style={{ minHeight: oneLineRow ? undefined : 'var(--list-item-height)', touchAction: threadSwipeEnabled ? 'pan-y' : undefined }}
        >
          {showRowActionButton && onContextMenu && (
            // For pointers that can't hover or right-click (MO-18); keyboards use
            // Shift+F10 on the row, so it stays out of the Tab order.
            <div role="gridcell" className="absolute end-2 top-1/2 z-20 -translate-y-1/2">
              <button
                type="button"
                data-row-actions=""
                onClick={(e) => { e.stopPropagation(); handleContextMenu(e); }}
                aria-label={tStatus('row_actions')}
                title={tStatus('row_actions')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          )}
          {threadSwipeEnabled && threadSwipeMeta && (
            // As on a single message's row: the physically exposed edge.
            <div
              aria-hidden
              dir="ltr"
              className={cn('absolute inset-0 z-0 flex items-center px-5 text-white', threadSwipeMeta.bg, threadSwipeSide === 'right' ? 'justify-start' : 'justify-end')}
            >
              <threadSwipeMeta.icon className={cn('h-5 w-5 transition-transform', threadWillCommit ? 'scale-110' : 'scale-90 opacity-80')} />
            </div>
          )}
          <div
            role="gridcell"
            data-row-text=""
            className={cn('px-3', showRowActionButton && onContextMenu && 'pe-12', oneLineRow ? 'flex items-center' : 'flex items-start', mvRow && 'min-h-[var(--list-item-height)]', threadSwipeEnabled && 'relative z-10 bg-inherit')}
            style={{ gap: 'var(--density-item-gap)', paddingBlock: mvRow ? undefined : 'var(--density-item-py)', transform: threadSwipeEnabled && threadOffsetX ? `translateX(${threadOffsetX}px)` : undefined, transition: threadSwipeEnabled && threadOffsetX === 0 ? 'transform 200ms ease-out' : undefined }}
          >
            {/* Checkbox for thread selection - only for extra-compact density (no avatar) while in selection mode */}
            {!mvRow && density === 'extra-compact' && selecting && (
              <button
                onClick={handleThreadCheckboxClick}
                role="checkbox"
                aria-checked={isChecked}
                aria-label={selectRowLabel}
                className={cn(
                  "p-3 lg:p-1 rounded flex-shrink-0 transition-all duration-200",
                  !oneLineRow && 'mt-2',
                  "hover:bg-muted/50 hover:scale-110",
                  "active:scale-95",
                  "animate-in fade-in zoom-in-95 duration-150",
                  isChecked && "text-primary"
                )}
              >
                {isChecked ? (
                  <CheckSquare className="w-4 h-4 animate-in zoom-in-50 duration-200" />
                ) : (
                  <Square className="w-4 h-4 text-muted-foreground opacity-60 hover:opacity-100 transition-opacity" />
                )}
              </button>
            )}

            {mvRow && (
              <MvRowLead
                checked={isChecked}
                onToggleChecked={handleThreadCheckboxClick}
                starred={!!hasStarred}
                onToggleStar={onToggleStar ? () => onToggleStar(latestEmail) : undefined}
                selectLabel={selectRowLabel}
                starLabel={tHover('star')}
              />
            )}

            {!mvRow && density !== 'extra-compact' && (
              <AvatarGutter onToggle={handleThreadCheckboxClick}>
                <div className="relative flex-shrink-0">
                  <SelectableAvatar
                    name={avatarPerson?.name}
                    email={avatarPerson?.email}
                    size={oneLineRow ? "sm" : "md"}
                    className="shadow-sm"
                    disableImages={hideJunkAvatarImages}
                    senderWarning={senderWarning}
                    brandDomain={showRecipient ? undefined : brandIndicatorDomain(latestEmail)}
                    checked={isChecked}
                    onToggle={handleThreadCheckboxClick}
                    selectLabel={selectRowLabel}
                  />
                  {hasUnread && <UnreadDot besideAvatar />}
                  {!isMobile && !columns && !conversationInReader && (
                    <button
                      data-expand-toggle
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleExpand();
                      }}
                      className={cn(
                        "absolute -bottom-2.5 left-1/2 -translate-x-1/2 p-0.5 rounded-full",
                        "transition-all duration-200",
                        "hover:bg-muted/50 hover:scale-110",
                        "active:scale-95",
                        "text-muted-foreground hover:text-foreground",
                        "bg-background border border-border"
                      )}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? t('collapse_named', { subject: threadSubject }) : t('expand_named', { subject: threadSubject })}
                    >
                      {isLoading ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : isExpanded ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </button>
                  )}
                </div>
              </AvatarGutter>
            )}

            {hasUnread && !mvRow && density === 'extra-compact' && (
              <UnreadDot besideAvatar={false} />
            )}

            <div className="flex-1 min-w-0">
              {oneLineRow ? (
                <>
                <div className={cn("flex flex-wrap items-center justify-between gap-3", mvRow && "min-h-[var(--list-item-height)]")}>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    {!columns && isUnifiedView && latestEmail.accountId && threadAccountColor && showAccountDot && (
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: threadAccountColor }}
                        title={threadAccountDescription}
                      >
                        <span className="sr-only">{threadAccountDescription}</span>
                      </span>
                    )}
                    {columns ? (
                      // Zimbra-style: the chevron leads the From cell and the
                      // count follows the names, so a folded conversation is
                      // one line like any message. (#262)
                      <span data-list-from="" className={cn(LIST_COLUMN_CLASS.from, 'flex items-center gap-2 text-sm')}>
                        {conversationInReader ? (
                          // The reading pane shows the conversation: the chevron's room, as on a single message's row.
                          <span aria-hidden="true" className="w-3.5 shrink-0" />
                        ) : (
                        <button
                          data-expand-toggle
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleExpand();
                          }}
                          className="-m-[5px] shrink-0 rounded p-[5px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? t('collapse_named', { subject: threadSubject }) : t('expand_named', { subject: threadSubject })}
                        >
                          {isLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </button>
                        )}
                        {isUnifiedView && latestEmail.accountId && threadAccountColor && showAccountDot && (
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: threadAccountColor }}
                            title={threadAccountDescription}
                          >
                            <span className="sr-only">{threadAccountDescription}</span>
                          </span>
                        )}
                        <span dir="auto" className={cn('flex-1 min-w-0 truncate', hasUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/80')}>
                          {displayNames.join(', ')}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground" title={t('messages_tooltip', { count: emailCount })}>
                          ({emailCount})
                        </span>
                      </span>
                    ) : mvRow ? (
                      // Gmail puts the message count after the names, in grey.
                      <span data-mv-names="" className="flex w-32 min-w-0 shrink items-baseline gap-1 text-sm lg:w-40">
                        <span dir="auto" className={cn('flex-1 min-w-0 truncate', hasUnread ? 'font-bold text-foreground' : 'font-medium text-foreground/80')}>
                          {displayNames.join(', ')}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground" title={t('messages_tooltip', { count: emailCount })}>
                          {emailCount}
                        </span>
                      </span>
                    ) : (
                    <span dir="auto" className={cn(
                      // Matches SingleEmailItem: the sender column sets where
                      // every row's tags and subject begin, so the two have to
                      // agree or thread rows sit 1rem further right.
                      'w-32 min-w-0 shrink truncate text-sm lg:w-40',
                      hasUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/80'
                    )}>
                      {displayNames.join(', ')}
                    </span>
                    )}
                    <div className={cn("flex min-w-0 flex-1 items-center overflow-hidden text-sm", mvRow ? "gap-0" : "gap-2")}>
                      {tagIds.length > 0 && (
                        <span className={cn(ROW_TAG_GROUP_CLASS, mvRow && "me-2")}>
                          {tagIds.map((id) => (
                            <TagBadge key={id} tagId={id} variant={tagVariant} scope={tagScope} className="max-w-[min(12rem,100%)]" />
                          ))}
                        </span>
                      )}
                      <span dir="auto" className={cn(
                        'min-w-0 truncate',
                        hasUnread ? (mvRow ? 'font-bold text-foreground' : 'font-semibold text-foreground') : 'text-foreground/90'
                      )}>
                        <bdi>{subjectSnippet ? <SearchSnippetText snippet={subjectSnippet} /> : (latestEmail.subject || tNoSubject)}</bdi>
                      </span>
                      <PluginRowBadges email={latestEmail} className={mvRow ? "ms-2" : undefined} />
                      {(previewSnippet || inlinePreview) && (
                        <span dir="auto" className="min-w-0 flex-1 shrink-[9999] truncate text-muted-foreground">
                          {mvRow && '\u00a0-\u00a0'}
                          {previewSnippet ? <> <SearchSnippetText snippet={previewSnippet} /></> : (mvRow ? trimmedPreview : inlinePreview)}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Fixed controls wrap together instead of overflowing the text lane. */}
                  <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2.5 text-sm">
                    {!mvRow && !columns && (
                      <ThreadCountPill
                        count={emailCount}
                        hasUnread={hasUnread}
                        title={t('messages_tooltip', { count: emailCount })}
                      />
                    )}
                    {hasPinned && <StatusIcon icon={Pin} label={tStatus('pinned')} className="w-3.5 h-3.5 text-primary" />}
                    {hasStarred && !mvRow && <StatusIcon icon={Star} label={tStatus('starred')} className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />}
                    {hasAnswered && !hasForwarded && !mvRow && <StatusIcon icon={Reply} label={tStatus('replied')} className="w-3.5 h-3.5 text-muted-foreground" />}
                    {hasForwarded && !hasAnswered && !mvRow && <StatusIcon icon={Forward} label={tStatus('forwarded')} className="w-3.5 h-3.5 text-muted-foreground" />}
                    {hasAnswered && hasForwarded && !mvRow && (
                      <>
                        <StatusIcon icon={Reply} label={tStatus('replied')} className="w-3.5 h-3.5 text-muted-foreground" />
                        <StatusIcon icon={Forward} label={tStatus('forwarded')} className="w-3.5 h-3.5 text-muted-foreground" />
                      </>
                    )}
                    {hasAttachment && <StatusIcon icon={Paperclip} label={tStatus('has_attachment')} className="w-3.5 h-3.5 text-muted-foreground" />}
                    {showSourceFolder && <SourceFolderTag name={latestEmail.sourceFolder!} role={latestEmail.sourceFolderRole} tight={senderLineTight} />}
                    {scheduledSendLabel ? (
                      <span
                        className={cn("inline-flex max-w-[11rem] shrink-0 items-center gap-1 truncate rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-xs font-medium tabular-nums text-sky-700 dark:text-sky-300", columns && "max-w-28")}
                        title={scheduledSendLabel}
                      >
                        <CalendarClock className="h-3 w-3 shrink-0" />
                        <span className="truncate">{scheduledSendLabel}</span>
                      </span>
                    ) : (
                      <span className={cn(
                        'text-xs tabular-nums',
                        columns && LIST_COLUMN_CLASS.date,
                        hasUnread ? (mvRow ? 'text-foreground font-bold' : 'text-foreground font-semibold') : 'text-muted-foreground'
                      )}>
                        {formatDate(emailListDate(latestEmail), mvRow ? { listStyle: 'mountain-view' } : undefined)}
                      </span>
                    )}
                    {columns && <SizeCell bytes={thread.emails.reduce((sum, e) => sum + (e.size ?? 0), 0)} />}
                  </div>
                </div>
                {mvRow && (
                  <RowChips
                    email={latestEmail}
                    loadAttachments={loadAttachments}
                    onOpenAttachment={onOpenAttachment ? (a) => onOpenAttachment(latestEmail, a) : undefined}
                    mvRow
                  />
                )}
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {isUnifiedView && latestEmail.accountId && threadAccountColor && showAccountDot && (
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: threadAccountColor }}
                          title={threadAccountDescription}
                        >
                          <span className="sr-only">{threadAccountDescription}</span>
                        </span>
                      )}
                      <span dir="auto" className={cn(
                        "flex-1 min-w-0 truncate text-sm",
                        hasUnread
                          ? "font-bold text-foreground"
                          : "font-medium text-muted-foreground"
                      )}>
                        {displayNames.join(", ")}
                      </span>
                      {tagPlacement === 'sender' && tagIds.length > 0 && (
                        <span className={ROW_TAG_GROUP_CLASS}>
                          {tagIds.map((id) => (
                            <TagBadge key={id} tagId={id} variant={senderLineTight && (showSourceFolder || tagIds.length > 1) ? 'dot' : tagVariant} scope={tagScope} className="max-w-[min(12rem,100%)]" />
                          ))}
                        </span>
                      )}
                    </div>
                    {/* Fixed controls wrap together instead of overflowing the text lane. */}
                    <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1.5">
                      <ThreadCountPill
                        count={emailCount}
                        hasUnread={hasUnread}
                        title={t('messages_tooltip', { count: emailCount })}
                      />
                      <div className="flex shrink-0 items-center gap-1.5">
                        {hasPinned && (
                          <StatusIcon icon={Pin} label={tStatus('pinned')} className="w-3.5 h-3.5 text-primary" />
                        )}
                        {hasStarred && !mvMobileRow && (
                          <StatusIcon icon={Star} label={tStatus('starred')} className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                        )}
                        {hasAnswered && !hasForwarded && (
                          <StatusIcon icon={Reply} label={tStatus('replied')} className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                        {hasForwarded && !hasAnswered && (
                          <StatusIcon icon={Forward} label={tStatus('forwarded')} className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                        {hasAnswered && hasForwarded && (
                          <>
                            <StatusIcon icon={Reply} label={tStatus('replied')} className="w-3.5 h-3.5 text-muted-foreground" />
                            <StatusIcon icon={Forward} label={tStatus('forwarded')} className="w-3.5 h-3.5 text-muted-foreground" />
                          </>
                        )}
                        {hasAttachment && (
                          <StatusIcon icon={Paperclip} label={tStatus('has_attachment')} className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                      </div>
                      {showSourceFolder && <SourceFolderTag name={latestEmail.sourceFolder!} role={latestEmail.sourceFolderRole} tight={senderLineTight} />}
                      {scheduledSendLabel ? (
                        <span
                          className="inline-flex max-w-[11rem] shrink-0 items-center gap-1 truncate rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[0.6875rem] font-medium tabular-nums text-sky-700 dark:text-sky-300"
                          title={scheduledSendLabel}
                        >
                          <CalendarClock className="h-3 w-3 shrink-0" />
                          <span className="truncate">{scheduledSendLabel}</span>
                        </span>
                      ) : (
                        <span className={cn(
                          "text-xs tabular-nums",
                          hasUnread
                            ? "text-foreground font-semibold"
                            : "text-muted-foreground"
                        )}>
                          {formatDate(emailListDate(latestEmail))}
                        </span>
                      )}
                      {mvMobileRow && !(showPreview && density !== 'extra-compact' && density !== 'compact') && (
                        <MvMobileStar
                          starred={!!hasStarred}
                          onToggle={onToggleStar ? () => onToggleStar(latestEmail) : undefined}
                          label={tHover('star')}
                        />
                      )}
                    </div>
                  </div>

                  <div className="mb-1 flex min-w-0 items-center gap-1.5">
                    {tagPlacement === 'subject' && tagIds.length > 0 && (
                        <span className={ROW_TAG_GROUP_CLASS}>
                          {tagIds.map((id) => (
                            <TagBadge key={id} tagId={id} variant={tagVariant} scope={tagScope} className="max-w-[min(12rem,100%)]" />
                          ))}
                        </span>
                    )}
                    <span dir="auto" className={cn(
                      "flex-1 min-w-0 truncate text-sm",
                      hasUnread
                        ? "font-semibold text-foreground"
                        : "font-normal text-foreground/90"
                    )}>
                      <bdi>{subjectSnippet ? <SearchSnippetText snippet={subjectSnippet} /> : (latestEmail.subject || tNoSubject)}</bdi>
                    </span>
                    <PluginRowBadges email={latestEmail} />
                  </div>

                  {showPreview && density !== 'extra-compact' && density !== 'compact' && (
                    <div className={cn("flex min-w-0 items-center gap-1", !mvMobileRow && "contents")}>
                      <p dir="auto" className={cn(
                        "text-sm leading-relaxed",
                        mvMobileRow ? "line-clamp-1 min-w-0 flex-1" : density === 'comfortable' ? "line-clamp-2" : "line-clamp-1",
                        hasUnread
                          ? "text-muted-foreground"
                          : "text-muted-foreground"
                      )}>
                        {previewSnippet ? <SearchSnippetText snippet={previewSnippet} /> : (trimmedPreview || tEmailViewer('no_preview_available'))}
                      </p>
                      {mvMobileRow && (
                        <MvMobileStar
                          starred={!!hasStarred}
                          onToggle={onToggleStar ? () => onToggleStar(latestEmail) : undefined}
                          label={tHover('star')}
                        />
                      )}
                    </div>
                  )}
                  <RowChips
                    email={latestEmail}
                    loadAttachments={loadAttachments}
                    onOpenAttachment={onOpenAttachment ? (a) => onOpenAttachment(latestEmail, a) : undefined}
                    mountainView={mvMobileRow}
                  />
                </>
              )}
            </div>
          </div>

          {/* Hover Quick Actions for thread header */}
          {hoverActionsArmed && !latestEmail.isScheduled && (
            <div role="gridcell">
            <EmailHoverActions
              email={latestEmail}
              backgroundClassName={rowTint ? rowTint : mvRow ? mvHoverBackground(isChecked, hasUnread, isSelected) : ((isSelected || isChecked) ? "bg-accent" : "bg-muted")}
              onToggleStar={onToggleStar ? () => onToggleStar(latestEmail) : undefined}
              onMarkAsRead={onMarkAsRead ? (read) => onMarkAsRead(latestEmail, read) : undefined}
              onDelete={onDelete ? () => onDelete(latestEmail) : undefined}
              onArchive={onArchive ? () => onArchive(latestEmail) : undefined}
              onSetTag={onSetTag ? (color) => onSetTag(latestEmail.id, color, emailKeyFor(latestEmail)) : undefined}
              onMarkAsSpam={onMarkAsSpam ? () => onMarkAsSpam(latestEmail) : undefined}
              onUndoSpam={onUndoSpam ? () => onUndoSpam(latestEmail) : undefined}
              isInJunk={currentMailboxRole === 'junk'}
              spamApplicable={spamApplicableIn(currentMailboxRole)}
              mailboxRole={currentMailboxRole ?? null}
              pinToFirstLine={mvRow}
            />
            </div>
          )}
        </div>

        {isExpanded && !isMobile && (
          <div className="bg-muted/20 animate-in slide-in-from-top-2 duration-200">
            {isLoading ? (
              <div role="row" aria-level={2} className="py-4 flex items-center justify-center text-sm text-muted-foreground">
                <div role="gridcell" className="flex items-center">
                  <Loader2 className="w-4 h-4 animate-spin me-2" aria-hidden="true" />
                  {t('loading')}
                </div>
              </div>
            ) : (
              emailsToShow.map((email, index) => (
                <ThreadEmailItem
                  key={email.id}
                  email={email}
                  selected={emailKeyFor(email) === selectedEmailKey}
                  isLast={index === emailsToShow.length - 1}
                  onClick={() => onEmailSelect(email)}
                  onDoubleClick={onEmailDoubleClick ? () => onEmailDoubleClick(email) : undefined}
                  onContextMenu={onContextMenu}
                />
              ))
            )}
          </div>
        )}
      </div>
    );
  }
);

ThreadListItemRow.displayName = "ThreadListItemRow";

/**
 * A message or conversation row. In a list the words come from the list's
 * RowTranslatorsProvider; a row drawn on its own makes its own.
 */
export const ThreadListItem = React.forwardRef<HTMLDivElement, ThreadListItemProps>(
  function ThreadListItem(props, ref) {
    return useRowTranslators()
      ? <ThreadListItemRow {...props} ref={ref} />
      : <RowTranslatorsProvider><ThreadListItemRow {...props} ref={ref} /></RowTranslatorsProvider>;
  }
);

ThreadListItem.displayName = "ThreadListItem";

/**
 * Whether two groupings describe the same thread row. The grouping is rebuilt
 * whenever the list or the thread counts change, which hands every row a new
 * `thread` object even when its messages are the very same objects.
 */
function isSameThread(a: ThreadGroup, b: ThreadGroup): boolean {
  if (a === b) return true;
  return a.threadKey === b.threadKey
    && a.threadId === b.threadId
    && a.emailCount === b.emailCount
    && a.latestEmail === b.latestEmail
    && a.hasUnread === b.hasUnread
    && a.hasStarred === b.hasStarred
    && a.hasPinned === b.hasPinned
    && a.hasAttachment === b.hasAttachment
    && a.hasAnswered === b.hasAnswered
    && a.hasForwarded === b.hasForwarded
    && a.emails.length === b.emails.length
    && a.emails.every((email, i) => email === b.emails[i])
    && a.participantNames.length === b.participantNames.length
    && a.participantNames.every((name, i) => name === b.participantNames[i]);
}

/** The open message, if this row draws it; otherwise none of the row's business. */
function openMessageWithin(props: ThreadListItemProps): string | undefined {
  const key = props.selectedEmailKey;
  if (!key) return undefined;
  const drawn = props.thread.emails.some((email) => emailKeyFor(email) === key)
    || (props.expandedEmails?.some((email) => emailKeyFor(email) === key) ?? false);
  return drawn ? key : undefined;
}

/** Props equality for MemoizedThreadListItem. */
export function areThreadRowPropsEqual(prev: ThreadListItemProps, next: ThreadListItemProps): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof ThreadListItemProps>;
  for (const key of keys) {
    if (key === 'thread') {
      if (!isSameThread(prev.thread, next.thread)) return false;
    } else if (key === 'selectedEmailKey') {
      if (openMessageWithin(prev) !== openMessageWithin(next)) return false;
    } else if (!Object.is(prev[key], next[key])) {
      return false;
    }
  }
  return true;
}

/**
 * ThreadListItem for the message list. Opening a message, switching folder or
 * a late thread count re-rendered every row on screen; this one re-renders
 * only when something it draws has changed. Handlers are compared by
 * identity, so the list passes stable ones (see useStableHandlers). The list
 * holds the RowTranslatorsProvider, so its rows skip ThreadListItem's check.
 */
export const MemoizedThreadListItem = React.memo(ThreadListItemRow, areThreadRowPropsEqual);
