"use client";

import React, { useCallback } from "react";
import { cleanPreview, formatDate } from "@/lib/utils";
import { emailDisplayDate } from "@/lib/email-date";
import { formatScheduledSendAt } from "@/lib/scheduled-send-label";
import { Email, ThreadGroup } from "@/lib/jmap/types";
import { cn } from "@/lib/utils";
import { ListAttachmentChips, useListHasAttachment } from "./attachment-chips";
import { VerificationCodeChip, useListVerificationCode } from "./verification-code-chip";
import type { Attachment } from "@/lib/jmap/types";
import type { LoadListAttachments } from "@/lib/list-attachments";
import { SelectableAvatar } from "@/components/email/selectable-avatar";
import { Paperclip, Star, Pin, Circle, ChevronRight, ChevronDown, Loader2, MessageSquare, CheckSquare, Square, Reply, Forward, CalendarClock, Folder, Archive, Trash2, MailOpen, ShieldAlert } from "@/components/icons";
import type { AppIcon } from "@/components/icons";
import { useSettingsStore, KEYWORD_PALETTE } from "@/stores/settings-store";
import { useShallow } from "zustand/react/shallow";
import { useListRowShape, LIST_COLUMN_CLASS } from "@/hooks/use-list-row-shape";
import { SizeCell } from "./list-columns";
import { accountTintKey, generateAvatarColor } from "@/lib/account-utils";
import { useUIStore } from "@/stores/ui-store";
import { useEmailStore, isUnscopedSearchActive } from "@/stores/email-store";
import { useAccountStore, type AccountEntry } from "@/stores/account-store";
import { emailKeyFor, getThreadTagIds, getEmailTagIds } from "@/lib/thread-utils";
import { useKeywordFormat } from "@/hooks/use-keyword-format";
import { useTagDisplay } from "@/hooks/use-tag-display";
import { TagBadge, TAG_GROUP_CLASS, TAG_LOZENGE_CLASS } from "./tag-badge";
import { useEmailDrag } from "@/hooks/use-email-drag";
import { useLongPress } from "@/hooks/use-long-press";
import { useSwipeActions } from "@/hooks/use-swipe-actions";
import type { SwipeAction } from "@/stores/settings-store";
import { ThreadEmailItem } from "./thread-email-item";
import { EmailHoverActions } from "./email-hover-actions";
import { SearchSnippetText } from "./search-snippet-text";
import { PluginRowBadges } from "./plugin-row-badges";
import { useOwnDomainAddress } from "@/hooks/use-own-domain-address";
import { useTranslations } from "next-intl";

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

function useArmOnPointerOver(): [boolean, () => void] {
  const [armed, setArmed] = React.useState(false);
  const arm = React.useCallback(() => setArmed(true), []);
  return [armed, arm];
}

function UnreadDot({ besideAvatar }: { besideAvatar: boolean }) {
  const t = useTranslations('email_viewer');
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
  const className = cn(variant === "mountain-view" ? "mt-2" : "mt-1.5", mvRow && "mt-1 pb-2.5 ps-[8.75rem] lg:ps-[10.75rem]");
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
 * Mountain View's leading controls: a checkbox and a star, both always
 * visible and both acting on the row without opening it. They take the slot
 * the default layout gives to the sender avatar.
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
    <div className="flex items-center gap-0.5 flex-shrink-0 self-center">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={selectLabel}
        onClick={onToggleChecked}
        className={cn(
          "p-1 rounded-full transition-colors hover:bg-foreground/10",
          checked && "text-primary"
        )}
      >
        {checked ? (
          <CheckSquare className="w-[18px] h-[18px]" />
        ) : (
          <Square className="w-[18px] h-[18px] text-muted-foreground" />
        )}
      </button>
      {onToggleStar && (
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
function SourceFolderTag({ name }: { name: string }) {
  return (
    <span
      className="inline-flex max-w-[8rem] shrink-0 items-center gap-1 truncate rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
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
  onToggleStar?: (email: Email) => void;
  onMarkAsRead?: (email: Email, read: boolean) => void;
  onDelete?: (email: Email) => void;
  onArchive?: (email: Email) => void;
  onSetTag?: (emailId: string, tagId: string | null, emailKey?: string) => void;
  onMarkAsSpam?: (email: Email) => void;
  onUndoSpam?: (email: Email) => void;
  onOpenAttachment?: (email: Email, attachment: Attachment) => void;
  loadAttachments?: LoadListAttachments;
}

interface SingleEmailItemProps {
  email: Email;
  selected: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  onPrefetch?: () => void;
  onContextMenu?: (e: React.MouseEvent, email: Email) => void;
  showPreview: boolean;
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
  function SingleEmailItem({ email, selected, onClick, onDoubleClick, onPrefetch, onContextMenu, showPreview, rowTint, onToggleStar, onMarkAsRead, onDelete, onArchive, onSetTag, onMarkAsSpam, onUndoSpam, onOpenAttachment, loadAttachments }, ref) {
    const t = useTranslations('email_viewer');
    const tBatch = useTranslations('email_list.batch_actions');
    const tHover = useTranslations('settings.email_behavior.hover_actions');
    const tStatus = useTranslations('email_list');
    const isUnread = !email.keywords?.$seen;
    const isStarred = email.keywords?.$flagged;
    const isPinned = email.keywords?.['$pinned'] === true;
    const isAnswered = email.keywords?.$answered;
    const isForwarded = email.keywords?.$forwarded;
    const showPaperclip = useListHasAttachment(email, loadAttachments);
    const { selectedMailbox, currentMailboxRole, selectedEmailKeys, toggleEmailSelection, selectRangeEmails, isUnifiedView } = useEmailStore(useShallow((state) => ({
      selectedMailbox: state.selectedMailbox,
      // The role, not the folder list: the list is a new array on every
      // count update, and subscribing to it re-rendered every row for each.
      currentMailboxRole: listMailboxRole(state),
      selectedEmailKeys: state.selectedEmailKeys,
      toggleEmailSelection: state.toggleEmailSelection,
      selectRangeEmails: state.selectRangeEmails,
      isUnifiedView: state.isUnifiedView,
    })));
    // In Sent/Drafts folders, show recipient instead of sender (which is always
    // "me"). In aggregate role-views the selected mailbox is virtual → fall back
    // to the unified role so junk-contextual UI and avatar hiding work.
    const showRecipient = currentMailboxRole === 'sent' || currentMailboxRole === 'drafts';
    const sender = showRecipient ? (email.to?.[0] ?? email.from?.[0]) : email.from?.[0];
    const formatAddress = useOwnDomainAddress();
    const { sortTagIds, tagColor } = useKeywordFormat();
    const { variant: tagVariant, placement: tagPlacement } = useTagDisplay();
    const tintListRowsByTag = useSettingsStore((state) => state.tintListRowsByTag);
    const tintListRowsByAccount = useSettingsStore((state) => state.tintListRowsByAccount);
    // The tint replaces the dot, and the dot can be switched off on its own (#912).
    const showAccountDot = useSettingsStore((state) => state.showAccountDot) && !tintListRowsByAccount;
    const density = useSettingsStore((state) => state.density);
    const timeFormat = useSettingsStore((state) => state.timeFormat);
    const showAvatarsInJunk = useSettingsStore((state) => state.showAvatarsInJunk);
    const interfaceLayout = useSettingsStore((state) => state.interfaceLayout);
    const hideJunkAvatarImages = currentMailboxRole === 'junk' && !showAvatarsInJunk;
    // Show the originating folder in the aggregate "All …" views.
    const showSourceFolder = useShowSourceFolder(email.sourceFolder);
    const getAccountById = useAccountStore((state) => state.getAccountById);
    const account = email.accountId ? getAccountById(email.accountId) : undefined;
    const accountColor = account?.avatarColor;
    const accountDescription = describeAccount(email.accountLabel, account);
    const isChecked = selectedEmailKeys.has(emailKeyFor(email));
    const isMobile = useUIStore((state) => state.isMobile);
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
    const swipeRightAction = useSettingsStore((state) => state.swipeRightAction);
    const swipeLeftAction = useSettingsStore((state) => state.swipeLeftAction);
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
    const swipeEnabled = isMobile && (hasLeft || hasRight);
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

    // Once something is ticked, the whole row is the checkbox, as in phone
    // mail apps (#1014). Mountain View on the desktop opens the message and
    // keeps the ticks instead, as Gmail does (#1231).
    const togglesOnClick = selectedEmailKeys.size > 0 && !mvRow;

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
        onPointerDown={(e) => { if (onPrefetch && isMousePressOnRow(e)) onPrefetch(); }}
        data-email-id={email.id}
        data-subject={email.subject || ''}
        data-unread={isUnread ? 'true' : 'false'}
        data-starred={email.keywords?.$flagged ? 'true' : 'false'}
        data-mv-mobile-row={mvMobileRow ? "" : undefined}
        data-mv-row={mvRow && !resolvedRowTint ? "" : undefined}
        data-checked={isChecked ? "" : undefined}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          "relative group cursor-pointer select-none transition-shadow duration-200 border-b border-border overflow-hidden",
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
        style={{ minHeight: oneLineRow ? undefined : 'var(--list-item-height)', touchAction: swipeEnabled ? 'pan-y' : undefined }}
      >
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
          className={cn('px-3', oneLineRow ? 'flex items-center' : 'flex items-start', mvRow && 'min-h-10', swipeEnabled && 'relative z-10 bg-inherit')}
          style={{ gap: 'var(--density-item-gap)', paddingBlock: mvRow ? undefined : 'var(--density-item-py)', transform: swipeEnabled && offsetX ? `translateX(${offsetX}px)` : undefined, transition: swipeEnabled && offsetX === 0 ? 'transform 200ms ease-out' : undefined }}
        >
          {/* Checkbox - only for extra-compact density (no avatar) while in selection mode */}
          {!mvRow && density === 'extra-compact' && selectedEmailKeys.size > 0 && (
            <button
              onClick={handleCheckboxClick}
              role="checkbox"
              aria-checked={isChecked}
              aria-label={tBatch('select')}
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
              selectLabel={tBatch('select')}
              starLabel={tHover('star')}
            />
          )}

          {!mvRow && density !== 'extra-compact' && (
            <div className="relative flex flex-shrink-0 self-center">
              <SelectableAvatar
                name={sender?.name}
                email={sender?.email}
                size={oneLineRow ? "sm" : "md"}
                className="shadow-sm"
                disableImages={hideJunkAvatarImages}
                checked={isChecked}
                onToggle={handleCheckboxClick}
                selectLabel={tBatch('select')}
              />
              {isUnread && <UnreadDot besideAvatar />}
            </div>
          )}

          {isUnread && !mvRow && density === 'extra-compact' && (
            <UnreadDot besideAvatar={false} />
          )}

          <div className="flex-1 min-w-0">
            {oneLineRow ? (
              <>
              <div className="flex items-center justify-between gap-3">
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
                  <span className={cn(
                    columns ? cn(LIST_COLUMN_CLASS.from, 'flex items-center gap-2') : 'w-32 shrink-0 truncate lg:w-40',
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
                        <span className="min-w-0 truncate">
                          {sender?.name || (sender?.email && formatAddress(sender.email)) || 'Unknown'}
                        </span>
                      </>
                    ) : (sender?.name || (sender?.email && formatAddress(sender.email)) || 'Unknown')}
                  </span>
                  <div className={cn("flex min-w-0 flex-1 items-center text-sm", mvRow ? "gap-0" : "gap-2")}>
                    {tagIds.length > 0 && (
                      <span className={cn(TAG_GROUP_CLASS, mvRow && "me-2")}>
                        {tagIds.map((id) => (
                          <TagBadge key={id} tagId={id} variant={tagVariant} />
                        ))}
                      </span>
                    )}
                    <span className={cn(
                      'min-w-0 truncate',
                      isUnread ? (mvRow ? 'font-bold text-foreground' : 'font-semibold text-foreground') : 'text-foreground/90'
                    )}>
                      {subjectSnippet ? <SearchSnippetText snippet={subjectSnippet} /> : (email.subject || '(no subject)')}
                    </span>
                    <PluginRowBadges email={email} className={mvRow ? "ms-2" : undefined} />
                    {(previewSnippet || inlinePreview) && (
                      <span className="min-w-0 shrink-[9999] truncate text-muted-foreground">
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
                  {showSourceFolder && <SourceFolderTag name={email.sourceFolder!} />}
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
                      {formatDate(emailDisplayDate(email), mvRow ? { listStyle: 'mountain-view' } : undefined)}
                    </span>
                  )}
                  {columns && <SizeCell bytes={email.size} />}
                </div>
              </div>
              {mvRow && (
                <RowChips email={email} loadAttachments={loadAttachments} onOpenAttachment={onOpenAttachment} mvRow />
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
                    <span className={cn(
                      "truncate text-sm",
                      isUnread
                        ? "font-bold text-foreground"
                        : "font-medium text-muted-foreground"
                    )}>
                      {sender?.name || (sender?.email && formatAddress(sender.email)) || "Unknown"}
                    </span>
                    {tagPlacement === 'sender' && tagIds.length > 0 && (
                      <span className={TAG_GROUP_CLASS}>
                        {tagIds.map((id) => (
                          <TagBadge key={id} tagId={id} variant={tagVariant} />
                        ))}
                      </span>
                  )}
                    <div className="flex items-center gap-1.5">
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
                    {showSourceFolder && <SourceFolderTag name={email.sourceFolder!} />}
                    {scheduledSendLabel ? (
                      <span
                        className="inline-flex max-w-[11rem] shrink-0 items-center gap-1 truncate rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-sky-700 dark:text-sky-300"
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
                        {formatDate(emailDisplayDate(email))}
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
                      <span className={TAG_GROUP_CLASS}>
                        {tagIds.map((id) => (
                          <TagBadge key={id} tagId={id} variant={tagVariant} />
                        ))}
                      </span>
                  )}
                  <span className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    isUnread
                      ? "font-semibold text-foreground"
                      : "font-normal text-foreground/90"
                  )}>
                    {subjectSnippet ? <SearchSnippetText snippet={subjectSnippet} /> : (email.subject || "(no subject)")}
                  </span>
                  <PluginRowBadges email={email} />
                </div>

                {showPreview && density !== 'extra-compact' && density !== 'compact' && (
                  <div className={cn("flex min-w-0 items-center gap-1", !mvMobileRow && "contents")}>
                    <p className={cn(
                      "text-sm leading-relaxed",
                      mvMobileRow ? "line-clamp-1 min-w-0 flex-1" : "line-clamp-2",
                      isUnread
                        ? "text-muted-foreground"
                        : "text-muted-foreground/80"
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
                <RowChips email={email} loadAttachments={loadAttachments} onOpenAttachment={onOpenAttachment} mountainView={mvMobileRow} />
              </>
            )}
          </div>
        </div>

        {/* Hover Quick Actions */}
        {hoverActionsArmed && !email.isScheduled && (
          <EmailHoverActions
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
            spamApplicable={!['sent', 'drafts', 'scheduled'].includes(currentMailboxRole || '')}
            mailboxRole={currentMailboxRole ?? null}
          />
        )}
      </div>
    );
  }
);

export const ThreadListItem = React.forwardRef<HTMLDivElement, ThreadListItemProps>(
  function ThreadListItem({
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
    onToggleStar,
    onMarkAsRead,
    onDelete,
    onArchive,
    onSetTag,
    onMarkAsSpam,
    onUndoSpam,
  }, ref) {
    const t = useTranslations('threads');
    const tEmailViewer = useTranslations('email_viewer');
    const tBatch = useTranslations('email_list.batch_actions');
    const tHover = useTranslations('settings.email_behavior.hover_actions');
    const tStatus = useTranslations('email_list');
    const showPreview = useSettingsStore((state) => state.showPreview);
    const density = useSettingsStore((state) => state.density);
    const timeFormat = useSettingsStore((state) => state.timeFormat);
    const showAvatarsInJunk = useSettingsStore((state) => state.showAvatarsInJunk);
    const interfaceLayout = useSettingsStore((state) => state.interfaceLayout);
    const isMobile = useUIStore((state) => state.isMobile);
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

    const { selectedMailbox, currentMailboxRole, selectedEmailKeys, toggleEmailSelection, selectRangeEmails, isUnifiedView } = useEmailStore(useShallow((state) => ({
      selectedMailbox: state.selectedMailbox,
      // The role, not the folder list: the list is a new array on every
      // count update, and subscribing to it re-rendered every row for each.
      currentMailboxRole: listMailboxRole(state),
      selectedEmailKeys: state.selectedEmailKeys,
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
    const hideJunkAvatarImages = currentMailboxRole === 'junk' && !showAvatarsInJunk;

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

    const { sortTagIds, tagColor } = useKeywordFormat();
    const { variant: tagVariant, placement: tagPlacement } = useTagDisplay();
    const tintListRowsByTag = useSettingsStore((state) => state.tintListRowsByTag);
    const tintListRowsByAccount = useSettingsStore((state) => state.tintListRowsByAccount);
    // The tint replaces the dot, and the dot can be switched off on its own (#912).
    const showAccountDot = useSettingsStore((state) => state.showAccountDot) && !tintListRowsByAccount;
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

    const isChecked = thread.emails.some(e => selectedEmailKeys.has(emailKeyFor(e)));

    if (emailCount === 1) {
      return (
        <SingleEmailItem
          ref={ref}
          email={latestEmail}
          selected={selectedEmailKey === emailKeyFor(latestEmail)}
          onClick={() => onEmailSelect(latestEmail)}
          onDoubleClick={onEmailDoubleClick ? () => onEmailDoubleClick(latestEmail) : undefined}
          onPrefetch={onPrefetch ? () => onPrefetch(latestEmail) : undefined}
          onContextMenu={onContextMenu}
          showPreview={showPreview}
          rowTint={rowTint}
          onToggleStar={onToggleStar ? () => onToggleStar(latestEmail) : undefined}
          onMarkAsRead={onMarkAsRead ? (read) => onMarkAsRead(latestEmail, read) : undefined}
          onDelete={onDelete ? () => onDelete(latestEmail) : undefined}
          onArchive={onArchive ? () => onArchive(latestEmail) : undefined}
          onSetTag={onSetTag ? (color) => onSetTag(latestEmail.id, color, emailKeyFor(latestEmail)) : undefined}
          onMarkAsSpam={onMarkAsSpam ? () => onMarkAsSpam(latestEmail) : undefined}
          onUndoSpam={onUndoSpam ? () => onUndoSpam(latestEmail) : undefined}
          onOpenAttachment={onOpenAttachment ? (a) => onOpenAttachment(latestEmail, a) : undefined}
          loadAttachments={loadAttachments}
        />
      );
    }

    const emailsToShow = expandedEmails || thread.emails;

    // Toggle selection for all emails in this thread.
    const toggleThreadSelection = () => {
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
    const threadTogglesOnClick = selectedEmailKeys.size > 0 && !mvRow;

    const handleHeaderClick = (e: React.MouseEvent) => {
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

      if (mvRow || mvMobileRow) {
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

    return (
      <div ref={ref} className={cn(
        "border-b border-border",
        mvMobileRow && "border-b-transparent",
        isThreadDragging && "opacity-50 scale-[0.98] ring-2 ring-primary/30"
      )}>
        <div
          {...dragHandlers}
          {...threadLongPressHandlers}
          onPointerOver={armHoverActions}
          onPointerDown={(e) => { if (onPrefetch && isMousePressOnRow(e)) onPrefetch(latestEmail); }}
          aria-current={isSelected ? 'true' : undefined}
          data-unread={hasUnread ? 'true' : 'false'}
          data-mv-mobile-row={mvMobileRow ? "" : undefined}
          data-mv-row={mvRow && !rowTint ? "" : undefined}
          data-checked={isChecked ? "" : undefined}
          className={cn(
            "relative group cursor-pointer select-none transition-shadow duration-200 overflow-hidden",
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
          style={{ minHeight: oneLineRow ? undefined : 'var(--list-item-height)' }}
        >
          <div
            className={cn('px-3', oneLineRow ? 'flex items-center' : 'flex items-start', mvRow && 'min-h-10')}
            style={{ gap: 'var(--density-item-gap)', paddingBlock: mvRow ? undefined : 'var(--density-item-py)' }}
          >
            {/* Checkbox for thread selection - only for extra-compact density (no avatar) while in selection mode */}
            {!mvRow && density === 'extra-compact' && selectedEmailKeys.size > 0 && (
              <button
                onClick={handleThreadCheckboxClick}
                role="checkbox"
                aria-checked={isChecked}
                aria-label={tBatch('select')}
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
                selectLabel={tBatch('select')}
                starLabel={tHover('star')}
              />
            )}

            {!mvRow && density !== 'extra-compact' && (
              <div className="relative flex-shrink-0 self-center">
                <SelectableAvatar
                  name={avatarPerson?.name}
                  email={avatarPerson?.email}
                  size={oneLineRow ? "sm" : "md"}
                  className="shadow-sm"
                  disableImages={hideJunkAvatarImages}
                  checked={isChecked}
                  onToggle={handleThreadCheckboxClick}
                  selectLabel={tBatch('select')}
                />
                {hasUnread && <UnreadDot besideAvatar />}
                {!isMobile && !columns && (
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
                    aria-label={t('toggle_thread')}
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
            )}

            {hasUnread && !mvRow && density === 'extra-compact' && (
              <UnreadDot besideAvatar={false} />
            )}

            <div className="flex-1 min-w-0">
              {oneLineRow ? (
                <>
                <div className="flex items-center justify-between gap-3">
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
                        <button
                          data-expand-toggle
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleExpand();
                          }}
                          className="-m-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          aria-expanded={isExpanded}
                          aria-label={t('toggle_thread')}
                        >
                          {isLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </button>
                        {isUnifiedView && latestEmail.accountId && threadAccountColor && showAccountDot && (
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: threadAccountColor }}
                            title={threadAccountDescription}
                          >
                            <span className="sr-only">{threadAccountDescription}</span>
                          </span>
                        )}
                        <span className={cn('min-w-0 truncate', hasUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/80')}>
                          {displayNames.join(', ')}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground" title={t('messages_tooltip', { count: emailCount })}>
                          ({emailCount})
                        </span>
                      </span>
                    ) : mvRow ? (
                      // Gmail puts the message count after the names, in grey.
                      <span data-mv-names="" className="flex w-32 shrink-0 items-baseline gap-1 text-sm lg:w-40">
                        <span className={cn('min-w-0 truncate', hasUnread ? 'font-bold text-foreground' : 'font-medium text-foreground/80')}>
                          {displayNames.join(', ')}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground" title={t('messages_tooltip', { count: emailCount })}>
                          {emailCount}
                        </span>
                      </span>
                    ) : (
                    <span className={cn(
                      // Matches SingleEmailItem: the sender column sets where
                      // every row's tags and subject begin, so the two have to
                      // agree or thread rows sit 1rem further right.
                      'w-32 shrink-0 truncate text-sm lg:w-40',
                      hasUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/80'
                    )}>
                      {displayNames.join(', ')}
                    </span>
                    )}
                    <div className={cn("flex min-w-0 flex-1 items-center text-sm", mvRow ? "gap-0" : "gap-2")}>
                      {((!mvRow && !columns) || tagIds.length > 0) && (
                      <span className={cn(TAG_GROUP_CLASS, mvRow && "me-2")}>
                        {!mvRow && !columns && (
                          <ThreadCountPill
                            count={emailCount}
                            hasUnread={hasUnread}
                            title={t('messages_tooltip', { count: emailCount })}
                          />
                        )}
                        {tagIds.map((id) => (
                          <TagBadge key={id} tagId={id} variant={tagVariant} />
                        ))}
                      </span>
                      )}
                      <span className={cn(
                        'min-w-0 truncate',
                        hasUnread ? (mvRow ? 'font-bold text-foreground' : 'font-semibold text-foreground') : 'text-foreground/90'
                      )}>
                        {subjectSnippet ? <SearchSnippetText snippet={subjectSnippet} /> : (latestEmail.subject || '(no subject)')}
                      </span>
                      <PluginRowBadges email={latestEmail} className={mvRow ? "ms-2" : undefined} />
                      {(previewSnippet || inlinePreview) && (
                        <span className="min-w-0 shrink-[9999] truncate text-muted-foreground">
                          {mvRow && '\u00a0-\u00a0'}
                          {previewSnippet ? <> <SearchSnippetText snippet={previewSnippet} /></> : (mvRow ? trimmedPreview : inlinePreview)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
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
                    {showSourceFolder && <SourceFolderTag name={latestEmail.sourceFolder!} />}
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
                        {formatDate(emailDisplayDate(latestEmail), mvRow ? { listStyle: 'mountain-view' } : undefined)}
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
                  <div className="flex items-center justify-between gap-2 mb-1">
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
                      <span className={cn(
                        "truncate text-sm",
                        hasUnread
                          ? "font-bold text-foreground"
                          : "font-medium text-muted-foreground"
                      )}>
                        {displayNames.join(", ")}
                      </span>
                      <span className={TAG_GROUP_CLASS}>
                        <ThreadCountPill
                          count={emailCount}
                          hasUnread={hasUnread}
                          title={t('messages_tooltip', { count: emailCount })}
                        />
                        {tagPlacement === 'sender' && tagIds.map((id) => (
                          <TagBadge key={id} tagId={id} variant={tagVariant} />
                        ))}
                      </span>
                      <div className="flex items-center gap-1.5">
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
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {showSourceFolder && <SourceFolderTag name={latestEmail.sourceFolder!} />}
                      {scheduledSendLabel ? (
                        <span
                          className="inline-flex max-w-[11rem] shrink-0 items-center gap-1 truncate rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-sky-700 dark:text-sky-300"
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
                          {formatDate(emailDisplayDate(latestEmail))}
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
                        <span className={TAG_GROUP_CLASS}>
                          {tagIds.map((id) => (
                            <TagBadge key={id} tagId={id} variant={tagVariant} />
                          ))}
                        </span>
                    )}
                    <span className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      hasUnread
                        ? "font-semibold text-foreground"
                        : "font-normal text-foreground/90"
                    )}>
                      {subjectSnippet ? <SearchSnippetText snippet={subjectSnippet} /> : (latestEmail.subject || "(no subject)")}
                    </span>
                    <PluginRowBadges email={latestEmail} />
                  </div>

                  {showPreview && density !== 'extra-compact' && density !== 'compact' && (
                    <div className={cn("flex min-w-0 items-center gap-1", !mvMobileRow && "contents")}>
                      <p className={cn(
                        "text-sm leading-relaxed",
                        mvMobileRow ? "line-clamp-1 min-w-0 flex-1" : "line-clamp-2",
                        hasUnread
                          ? "text-muted-foreground"
                          : "text-muted-foreground/80"
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
              spamApplicable={!['sent', 'drafts', 'scheduled'].includes(currentMailboxRole || '')}
              mailboxRole={currentMailboxRole ?? null}
            />
          )}
        </div>

        {isExpanded && !isMobile && (
          <div className="bg-muted/20 animate-in slide-in-from-top-2 duration-200">
            {isLoading ? (
              <div className="py-4 flex items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin me-2" />
                {t('loading')}
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
 * identity, so the list passes stable ones (see useStableHandlers).
 */
export const MemoizedThreadListItem = React.memo(ThreadListItem, areThreadRowPropsEqual);
