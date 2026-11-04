"use client";

import { hoverOpens } from "@/lib/open-on-hover";
import { memo, useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, useId, Fragment, ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { PluginSidebarSections } from "@/components/plugins/plugin-sidebar-sections";
import { Button, TOUCH_HIT_AREA } from "@/components/ui/button";
import {
  Inbox,
  Send,
  File,
  Star,
  Trash2,
  Archive,
  Ban,
  ChevronsLeft,
  ChevronsRight,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderOpen,
  FolderSync,
  User,
  Users,
  Palmtree,
  Settings,
  X,
  RotateCcw,
  Tag,
  FlaskConical,
  PlayCircle,
  Loader2,
  AlertTriangle,
  NotebookPen,
  Pencil,
  PenSquare,
  Plus,
  CalendarClock,
  BellOff,
  Mails,
  MailOpen,
  MoreHorizontal,
  MoreVertical,
} from "@/components/icons";
import { cn, buildMailboxTree, MailboxNode } from "@/lib/utils";
import { FOLDER_CHEVRON_SLOT, FOLDER_ROW_PX_BASE, FolderRowsSkeleton } from "@/components/boot-skeleton/mail-skeleton";
import { localizeMailboxName } from "@/lib/mailbox-label";
import {
  buildKeywordTree,
  countKeywordNodes,
  filterKeywordTree,
  hasChildKeywords,
  type KeywordNode,
} from "@/lib/keyword-nesting";
import { useShortenedText } from "@/hooks/use-shortened-text";
import { useKeywordFormat } from "@/hooks/use-keyword-format";
import { TagScopeContext, useAccountTags } from "@/hooks/use-account-tags";
import { isAppShortcutBlocked, isEventInside } from "@/lib/keyboard";
import { Mailbox } from "@/lib/jmap/types";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useLongPress } from "@/hooks/use-long-press";
import { useDeviceDetection, useMediaQuery } from "@/hooks/use-media-query";
import { IconButton } from "@/components/ui/icon-button";
import { MailboxContextMenu, type MailboxContextTarget, type MailboxNotificationActions } from "./mailbox-context-menu";
import { useAccountStore } from '@/stores/account-store';
import { useShallow } from "zustand/react/shallow";
import { UNIFIED_MAILBOX_IDS, CROSS_VIEW_IDS } from '@/lib/jmap/types';
import type { UnifiedMailboxRole } from '@/lib/jmap/types';
import { useDragDropContext } from "@/contexts/drag-drop-context";
import { useMailboxDrop } from "@/hooks/use-mailbox-drop";
import { MAILBOX_DRAG_MIME } from "@/components/pro/pro-shell-drop";
import { useTagDrop } from "@/hooks/use-tag-drop";
import { sidebarFolded, useUIStore } from "@/stores/ui-store";
import { useAuthStore } from "@/stores/auth-store";
import { unifiedLoadProgress } from "@/lib/unified-mailbox";
import { useVacationStore } from "@/stores/vacation-store";
import { useManagedAccountStore } from "@/stores/managed-account-store";
import { useSettingsStore, getKeywordVisibility } from "@/stores/settings-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useEmailStore, buildTagViewAccountClients } from "@/stores/email-store";
import { trashAndJunkIds } from "@/lib/unified-mailbox";
import { toast } from "@/stores/toast-store";
import { toastWithUndo, undoLabels, undoMoveAction } from "@/lib/email-action-toast";
import { debug } from "@/lib/debug";
import { AccountSwitcher } from "./account-switcher";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { buildSettingsPath, SCHEDULED_MAILBOX_ID, scopedScheduledMailboxId } from "@/lib/deep-links";
import { useTour } from "@/components/tour/tour-provider";
import { toUnicodeEmail } from "@/lib/idn";
import { hiddenSharedMailIds, isSharedMailAccountVisible, setSharedMailAccountHidden } from "@/lib/shared-mail-visibility";
import { compactSharedMailbox } from "@/lib/compact-shared-mailbox";
import {
  isAccountMuted,
  isMailboxMuted,
  mailboxOverridesForAccount,
  resetMailboxMutes,
  setAccountMuted,
  setMailboxMuted,
  type NotificationMutes,
} from "@/lib/notification-mutes";
import { serverSupportsEmailPush } from "@/lib/web-push";
import { resolveFolderCounts } from "@/lib/folder-counts";
import { batchToastTitle } from "@/lib/selection-toast";

interface SidebarProps {
  mailboxes: Mailbox[];
  selectedMailbox?: string;
  selectedKeyword?: string | null;
  onMailboxSelect?: (mailboxId: string) => void;
  onTagSelect?: (keywordId: string | null, accountId?: string | null) => void;
  onCompose?: () => void;
  /**
   * Mountain View, desktop only: the rail grows a Compose pill at the top and
   * drops its own header, because the global top bar already carries the
   * collapse control and the account switcher.
   */
  mvShell?: boolean;
  onSidebarClose?: () => void;
  onMarkFolderRead?: (mailboxId: string) => void;
  onMarkFolderTreeRead?: (mailboxId: string) => void;
  onMarkAllFoldersRead?: () => void;
  onEmptyFolder?: (mailboxId: string) => void;
  onCreateSubfolder?: (parentId: string) => void;
  onCreateFolder?: (accountId?: string) => void;
  onRenameFolder?: (mailboxId: string) => void;
  onDeleteFolder?: (mailboxId: string) => void;
  onShareFolder?: (mailboxId: string) => void;
  onImportEmail?: (mailboxId: string) => void;
  onRefreshMailboxes?: () => void;
  scheduledTotal?: number;
  /** Pending scheduled-send counts per JMAP account, for shared-account rows. */
  scheduledTotalByAccount?: Record<string, number>;
  /** JMAP account the scheduled view is currently narrowed to, if any. The
   *  store keeps one virtual scheduled mailbox id, so the active shared row is
   *  identified by this scope rather than by selectedMailbox alone. */
  scheduledAccountScope?: string | null;
  showScheduledMailbox?: boolean;
  /** True when the unified view spans multiple login accounts (cross-account).
   *  Drives the section header: "All accounts" when true, else "Unified Mailbox". */
  crossAccountActive?: boolean;
  /** Gated All mail / Unread / Starred entries in the "Unified Mailbox" section. */
  showCrossUnread?: boolean;
  showCrossStarred?: boolean;
  /** Mountain View: open Starred from its own row under the Inbox. */
  onOpenStarred?: () => void;
  showCrossAll?: boolean;
  /** Unread total across all cross-view folders (badge for unread/all). */
  crossUnreadCount?: number;
  className?: string;
  /**
   * Multi-account (Pro) mode props. When `multiAccountMode` is true, the
   * sidebar renders a per-connected-account group instead of a single
   * folders section - Thunderbird-style. `accountMailboxes` provides the
   * mailbox list for non-active accounts (the active account still flows
   * through the `mailboxes` prop). `viewingAccountId` highlights which
   * account's folder is currently selected (null = active account).
   * `onAccountMailboxSelect` fires with the owning accountId when the user
   * picks a folder; callers translate that into `selectAccountMailbox`.
   */
  multiAccountMode?: boolean;
  accountMailboxes?: Record<string, Mailbox[]>;
  viewingAccountId?: string | null;
  onAccountMailboxSelect?: (accountId: string | null, mailboxId: string) => void;
  /** Shared mailboxes of each non-active login, keyed by login (#1486). */
  accountSharedMailboxes?: Record<string, Mailbox[]>;
  /** A shared mailbox of a non-active login was picked: the caller switches
   *  to that login and opens it, since shared mail is reached through the
   *  active login. */
  onLoginSharedMailboxSelect?: (loginId: string, mailboxId: string) => void;
  /**
   * The folded column's tree is open over the page as a drawer (default
   * layout): called with a function that closes it, and with null once it is
   * closed. The caller dims the page behind it.
   */
  onDrawerChange?: (close: (() => void) | null) => void;
}

const ROW_PX_BASE = FOLDER_ROW_PX_BASE;
const CHEVRON_SLOT = FOLDER_CHEVRON_SLOT;
const INDENT_STEP = 12;
/** How long the pointer rests on the folded column before the tree floats out. */
const RAIL_HOVER_DELAY_MS = 350;
/**
 * The header's collapse and close buttons: muted, with the grey hover of the
 * other icon buttons in the sidebar. The ghost button's accent hover is a
 * strong blue in the dark theme, and a drawer that opens under the pointer
 * showed it as if the button were switched on.
 */
const SIDEBAR_HEAD_BUTTON = "text-muted-foreground hover:bg-muted hover:text-foreground";

/** Keeps Tab and Shift+Tab inside `root`, wrapping at either end. */
function trapTab(e: React.KeyboardEvent, root: HTMLElement | null) {
  if (!root) return;
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]'
  )).filter((el) => el.getAttribute('tabindex') !== '-1' && !el.closest('[inert]'));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

// Icons and colours follow the JMAP role only.
const getIconForMailbox = (role?: string, hasChildren?: boolean, isExpanded?: boolean, id?: string) => {
  if (id?.startsWith('shared-account-')) {
    return User;
  }

  switch (role) {
    case "inbox": return Inbox;
    case "sent": return Send;
    case "drafts": return File;
    case "trash": return Trash2;
    case "junk": return Ban;
    case "archive": return Archive;
    case "shared": return Users;
    case "important": return AlertTriangle;
    case "memos": return NotebookPen;
    case "scheduled": return CalendarClock;
    case "snoozed": return BellOff;
    case "flagged": return Star;
  }

  if (hasChildren) {
    return isExpanded ? FolderOpen : Folder;
  }

  return Folder;
};

// Role tints from the theme's tokens (R11), so a theme recolours them and
// dark mode has its own values: the chart palette for the main roles.
// With colour-blind-safe colours on (<html data-cvd-palette="on">) each
// colour is swapped for one of the palette in lib/cvd-palette.ts. Written
// out in full so Tailwind generates the classes.
const ROLE_ICON_COLOR: Record<string, string> = {
  inbox: "text-chart-1/80 [[data-cvd-palette=on]_&]:text-[#0072B2]",
  sent: "text-chart-2/80 [[data-cvd-palette=on]_&]:text-[#009E73]",
  drafts: "text-chart-5/80 [[data-cvd-palette=on]_&]:text-[#CC79A7]",
  trash: "text-muted-foreground",
  junk: "text-chart-4/80 [[data-cvd-palette=on]_&]:text-[#D55E00]",
  archive: "text-chart-3/80 [[data-cvd-palette=on]_&]:text-[#56B4E9]",
  shared: "text-info/80 [[data-cvd-palette=on]_&]:text-[#F0E442]",
  important: "text-warning/80 [[data-cvd-palette=on]_&]:text-[#E69F00]",
  memos: "text-warning/80 [[data-cvd-palette=on]_&]:text-[#E69F00]",
  scheduled: "text-info/80 [[data-cvd-palette=on]_&]:text-[#F0E442]",
  snoozed: "text-muted-foreground",
};

function getIconClass(isSelected: boolean, isVirtual: boolean, colorful: boolean, roleKey?: string) {
  const base = "w-4 h-4 flex-shrink-0 transition-colors";
  if (isVirtual) return cn(base, "text-muted-foreground");
  if (colorful && roleKey && ROLE_ICON_COLOR[roleKey]) {
    return cn(base, ROLE_ICON_COLOR[roleKey]);
  }
  return cn(base, isSelected ? "text-foreground" : "text-foreground/80");
}

function SidebarRowCounts({
  unread,
  total,
  role,
  mailboxId,
}: {
  unread?: number;
  total?: number;
  role?: string | null;
  mailboxId?: string;
  isSelected: boolean;
}) {
  const tShell = useTranslations('shell');
  const showFolderTotalCount = useSettingsStore(s => s.showFolderTotalCount);
  const mountainView = useSettingsStore(s => s.interfaceLayout === 'mountain-view');
  // Per-folder override from the folder settings (#982).
  const countMode = useSettingsStore(s => (mailboxId ? s.folderCountModes?.[mailboxId] : undefined));
  // Settings > Accessibility: unread counts as numbers, as a dot, or hidden.
  const unreadCountStyle = useSettingsStore(s => s.unreadCountStyle);
  const resolved = resolveFolderCounts({
    unread, total, role, mode: countMode,
    showTotalGlobally: showFolderTotalCount, mountainView,
  });
  const counts = unreadCountStyle === 'hidden' ? { ...resolved, unread: 0 } : resolved;
  const unreadDot = (
    <span aria-hidden="true" data-testid="folder-unread-dot" className="inline-block w-2 h-2 rounded-full bg-primary" />
  );
  // Mountain View counts one thing per row: what is unread, or for Drafts,
  // how many there are, since a draft is never unread.
  if (mountainView) {
    const showsTotal = counts.total > 0;
    const count = showsTotal ? counts.total : counts.unread;
    if (count === 0) return null;
    return (
      <span
        className={cn("ms-2 flex-shrink-0 text-xs tabular-nums", showsTotal ? "text-muted-foreground" : "font-bold text-foreground")}
        data-testid="folder-counts"
        data-unread={unread ?? 0}
        data-total={counts.total}
        // An unread count is said with the folder's name.
        aria-hidden={showsTotal ? undefined : true}
      >
        {!showsTotal && unreadCountStyle === 'dot' ? unreadDot : count.toLocaleString()}
      </span>
    );
  }
  const unreadCount = counts.unread;
  const totalCount = counts.total;

  if (unreadCount === 0 && totalCount === 0) return null;

  const unreadClass = "text-xs font-semibold tabular-nums text-foreground";
  const totalClass = "text-xs tabular-nums text-muted-foreground";

  // Text, not a button: a click on the count opens the folder like the rest
  // of the row. It used to turn on an Unread filter and an "Inbox" search
  // scope that stayed and broke later searches (usability test 2026-11-04).
  const unreadNode = unreadCount > 0 ? (
    // Said with the folder's name already.
    <span className={unreadClass} aria-hidden="true">{unreadCountStyle === 'dot' ? unreadDot : unreadCount}</span>
  ) : null;

  return (
    <span
      className="ms-2 flex-shrink-0 flex items-baseline gap-1"
      title={totalCount > 0 ? tShell("folder_counts", { unread: unreadCount, total: totalCount }) : tShell("folder_unread", { count: unreadCount })}
      data-testid="folder-counts"
      data-unread={unreadCount}
      data-total={totalCount}
    >
      {unreadNode}
      {unreadCount > 0 && totalCount > 0 && (
        <span className="text-xs text-muted-foreground" aria-hidden="true">/</span>
      )}
      {totalCount > 0 && <span className={totalClass}>{totalCount}</span>}
    </span>
  );
}

/**
 * What a row's menu handler needs from an event, for a menu opened by a
 * long-press (at the finger) or from the row's ⋮ (under the button).
 */
/**
 * R11: a name cut with an ellipsis gets a title with the full text. Measured
 * when the pointer arrives, since only then is the title shown: a shortened
 * form, or one the row's width still cuts.
 */
function titleIfCut(element: HTMLElement, full: string, shortened: boolean) {
  element.title = shortened || element.scrollWidth > element.clientWidth ? full : "";
}

function menuEventAt(element: HTMLElement, point?: { clientX: number; clientY: number }): React.MouseEvent {
  return {
    type: point ? "contextmenu" : "click",
    detail: 0,
    clientX: point?.clientX ?? 0,
    clientY: point?.clientY ?? 0,
    currentTarget: element,
    target: element,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.MouseEvent;
}

interface SidebarRowProps {
  icon: ReactNode;
  label: string;
  /** Progressively shorter renderings of `label`, longest first. The widest one
   *  that fits the row is shown; without this the full label is used. */
  labelCandidates?: string[];
  depth?: number;
  isSelected?: boolean;
  isVirtual?: boolean;
  unread?: number;
  total?: number;
  onClick?: () => void;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onExpandToggle?: () => void;
  isCollapsed: boolean;
  dropHandlers?: Record<string, unknown>;
  isValidDropTarget?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** New mail here does not notify (#1169). */
  muted?: boolean;
  /** Stable identifiers for integration tests (not user-visible). */
  testRole?: string | null;
  testName?: string;
  testMailboxId?: string;
  testShared?: boolean;
  /** Names the row the same folded and unfolded, so the drawer opened by a
   *  hover can put the hovered item back under the pointer. */
  railKey?: string;
  /** Unread mail in subfolders that aren't shown under this row (folded to
   *  icons, or the folder closed), so it shows somewhere (mail-p3 p2-9). */
  subfolderUnread?: number;
}

function SidebarRow({
  icon,
  label,
  labelCandidates,
  depth = 0,
  isSelected = false,
  isVirtual = false,
  unread,
  total,
  onClick,
  hasChildren = false,
  isExpanded = false,
  onExpandToggle,
  isCollapsed,
  dropHandlers,
  isValidDropTarget,
  onContextMenu,
  muted = false,
  testRole,
  testName,
  testMailboxId,
  testShared,
  railKey,
  subfolderUnread = 0,
}: SidebarRowProps) {
  const t = useTranslations('sidebar');
  const tShell = useTranslations('shell');
  const tP3 = useTranslations('mail_p3_list');
  const leftPad = isCollapsed ? 0 : ROW_PX_BASE + depth * INDENT_STEP;
  const mutedId = useId();
  // The unread count is part of the folder's name ("Inbox, 3 unread"), also
  // with the sidebar collapsed, where no count is drawn. Hidden counts are
  // not said either; a dot still says the number.
  const unreadCountStyle = useSettingsStore(s => s.unreadCountStyle);
  const showFolderTotalCount = useSettingsStore(s => s.showFolderTotalCount);
  const mountainView = useSettingsStore(s => s.interfaceLayout === 'mountain-view');
  const countMode = useSettingsStore(s => (testMailboxId ? s.folderCountModes?.[testMailboxId] : undefined));
  const unreadForName = unreadCountStyle === 'hidden' ? 0 : resolveFolderCounts({
    unread, total, role: testRole, mode: countMode, showTotalGlobally: showFolderTotalCount, mountainView,
  }).unread;
  const subUnread = unreadCountStyle === 'hidden' ? 0 : subfolderUnread;
  const accessibleName = subUnread > 0
    ? (unreadForName > 0
        ? tP3('name_unread_sub', { name: label, count: unreadForName, sub: subUnread })
        : tP3('name_unread_only_sub', { name: label, sub: subUnread }))
    : unreadForName > 0 ? tShell('name_unread', { name: label, count: unreadForName }) : undefined;
  // Folded, the counter adds what the hidden subfolders hold: "Inbox 9" over
  // 442 unread below it read as if everything was read.
  const foldedUnread = unreadForName + subUnread;
  // The default layout's folded column: one grid of square items.
  const railItem = isCollapsed && !mountainView;
  const [labelRef, shortenedLabel] = useShortenedText(labelCandidates ?? [label]);
  // Touch has no right-click: a long-press opens the same menu (R7), and a
  // ⋮ shows it too.
  const rowRef = useRef<HTMLDivElement>(null);
  const hasMenu = !!onContextMenu && !isVirtual;
  // The ⋮ is for touch, where there is no right-click; rendered only there.
  const coarsePointer = useMediaQuery('(pointer: coarse)');
  const longPress = useLongPress((point) => {
    if (rowRef.current && onContextMenu) onContextMenu(menuEventAt(rowRef.current, point));
  }, hasMenu);
  // The whole row opens the folder, not just its button: the row's padding,
  // the chevron slot and the space around the count were dead (#1501). The
  // button stays the keyboard target; controls of their own keep their click.
  const openFromRow = !isVirtual && onClick
    ? (e: React.MouseEvent) => {
        if (!(e.target as Element).closest('button, a, input, [role="button"]')) onClick();
      }
    : undefined;

  return (
    <div
      ref={rowRef}
      {...(dropHandlers || {})}
      onClick={openFromRow}
      onContextMenu={onContextMenu}
      onTouchStart={hasMenu ? longPress.onTouchStart : undefined}
      onTouchMove={hasMenu ? longPress.onTouchMove : undefined}
      onTouchEnd={hasMenu ? longPress.onTouchEnd : undefined}
      onTouchCancel={hasMenu ? longPress.onTouchCancel : undefined}
      data-testid="folder-row"
      data-mv-nav-row=""
      data-folder-role={testRole ?? undefined}
      data-folder-name={testName ?? undefined}
      data-mailbox-id={testMailboxId ?? undefined}
      data-shared={testShared ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
      data-has-unread={(unread ?? 0) > 0 && testRole !== 'drafts' ? '' : undefined}
      data-rail-key={railKey ?? testMailboxId ?? undefined}
      style={railItem ? undefined : { paddingBlock: 'var(--density-sidebar-py)' }}
      className={cn(
        "group w-full flex items-center tap:min-h-[44px] text-sm transition-colors duration-150",
        // Folded, every item is the same square on one grid, as in Outlook's
        // folded pane: the button carries the hover and the selection, and a
        // bar at the column's edge marks the open one.
        // Mountain View's 72px rail keeps its own pill rows (globals.css).
        railItem ? "relative justify-center py-px" : isCollapsed ? "justify-center px-1" : "pe-2",
        openFromRow && "cursor-pointer select-none",
        railItem
          ? (isVirtual ? "text-muted-foreground" : isSelected ? "text-accent-foreground font-semibold" : "text-foreground")
          : isVirtual
            ? "text-muted-foreground"
            : isSelected
              ? "bg-accent text-accent-foreground font-semibold border-s-2 border-primary"
              : "hover:bg-muted/50 text-foreground border-s-2 border-transparent",
        // Only a folder that takes the drop lights up. Elsewhere the pointer
        // says no (dropEffect none), as in a native mail client.
        isValidDropTarget && "bg-primary/20 ring-2 ring-primary ring-inset"
      )}
    >
      {railItem && isSelected && (
        <span aria-hidden="true" data-testid="folded-selected" className="absolute z-10 start-0 top-1/2 -translate-y-1/2 h-5 w-[0.1875rem] rounded-e-full bg-primary" />
      )}
      {!isCollapsed && (
        <div
          className="flex items-center flex-shrink-0"
          style={{ paddingInlineStart: leftPad }}
        >
          {hasChildren && onExpandToggle ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onExpandToggle();
              }}
              data-testid="folder-expand-toggle"
              aria-label={isExpanded ? tShell('collapse_folder', { name: label }) : tShell('expand_folder', { name: label })}
              aria-expanded={isExpanded}
              className={cn("flex items-center justify-center rounded hover:bg-muted active:bg-accent transition-colors", TOUCH_HIT_AREA)}
              // 24px to hit (WCAG 2.5.8) in the 20px slot: the negative
              // margin gives the extra 2px on each side back.
              style={{ width: 24, height: 24, margin: (CHEVRON_SLOT - 24) / 2 }}
              title={isExpanded ? t('collapse_tooltip') : t('expand_tooltip')}
            >
              {isExpanded ? (
                <ChevronDown className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
          ) : (
            <div style={{ width: CHEVRON_SLOT }} aria-hidden />
          )}
        </div>
      )}

      <button
        onClick={() => !isVirtual && onClick?.()}
        disabled={isVirtual}
        aria-current={isSelected ? 'page' : undefined}
        aria-label={accessibleName ?? (isCollapsed ? label : undefined)}
        aria-describedby={muted && !isCollapsed ? mutedId : undefined}
        className={cn(
          "flex items-center gap-2 min-w-0 transition-colors",
          railItem
            ? cn(
                // 36px high: the icon sits 10px down, under the counter's
                // 12px, so the counter never covers the glyph.
                "relative justify-center w-full max-w-10 h-9 rounded-md focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
                !isVirtual && (isSelected ? "bg-accent" : "hover:bg-muted/60"),
              )
            : isCollapsed ? "relative justify-center w-10 h-8" : "flex-1 text-start",
          isVirtual && "cursor-default select-none"
        )}
        // Folded, the name and count are only in the tooltip.
        title={isCollapsed ? (accessibleName ?? label) : undefined}
      >
        <span className="relative flex items-center justify-center flex-shrink-0 w-4 h-4">
          {icon}
        </span>
        {/* Folded to icons, a small counter at the icon's top corner (p2-9); the name says it already. */}
        {isCollapsed && foldedUnread > 0 && (
          unreadCountStyle === 'dot' ? (
            <span aria-hidden="true" data-testid="folded-unread" className="absolute top-1.5 end-1.5 w-1.5 h-1.5 rounded-full bg-primary" />
          ) : (
            <span
              aria-hidden="true"
              data-testid="folded-unread"
              className="absolute top-0 end-0 min-w-3 h-3 px-[0.1875rem] rounded-full bg-primary text-primary-foreground text-[0.5625rem] leading-3 font-semibold tabular-nums text-center"
            >
              {foldedUnread > 99 ? '99+' : foldedUnread}
            </span>
          )
        )}
        {!isCollapsed && (
          <>
            <span
              ref={labelRef}
              className="flex-1 truncate"
              title={shortenedLabel !== label ? label : undefined}
              onPointerEnter={(e) => titleIfCut(e.currentTarget, label, shortenedLabel !== label)}
            >
              {shortenedLabel}
            </span>
            {muted && (
              <BellOff
                id={mutedId}
                className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground"
                aria-label={t('notifications_muted')}
                data-testid="folder-muted"
              />
            )}
          </>
        )}
      </button>
      {/* Beside the row's button, not in it; a click on it opens the folder through the row. */}
      {!isCollapsed && (
        <SidebarRowCounts
          unread={unread}
          total={total}
          role={testRole}
          mailboxId={testMailboxId}
          isSelected={isSelected}
        />
      )}
      {/* A closed folder whose subfolders hold unread mail: a dot after its count, said in its name. */}
      {!isCollapsed && subUnread > 0 && (
        <span
          aria-hidden="true"
          data-testid="subfolder-unread"
          title={tP3('sub_unread', { sub: subUnread })}
          className="ms-1.5 inline-block w-1.5 h-1.5 flex-shrink-0 rounded-full bg-primary/70"
        />
      )}
      {hasMenu && !isCollapsed && coarsePointer && (
        <IconButton
          label={t('folder_options', { name: label })}
          data-testid="folder-row-menu"
          className="ms-1 flex-shrink-0 text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu(menuEventAt(e.currentTarget));
          }}
        >
          <MoreVertical />
        </IconButton>
      )}
    </div>
  );
}

/**
 * A folder of one's own on the folded strip, when there are several: the
 * folder glyph the other rows use, same size and stroke, with the folder's
 * first letter inside it. A letter in a box of its own looked like no other
 * icon in the column.
 */
function FolderInitial({ name, className }: { name: string; className?: string }) {
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?';
  return (
    <svg
      aria-hidden="true"
      data-testid="folder-initial-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Lucide's folder outline. */}
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <text
        data-testid="folder-initial"
        x="12"
        y="13"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        stroke="none"
        // 13.5 of 24 units: 9 px at the 16 px icon size, the smallest that
        // reads at 100 % (mail-p3, p2-9); 10 units was about 6 px.
        fontSize="13.5"
        fontWeight="700"
      >
        {initial}
      </text>
    </svg>
  );
}

/** Whether the folder `id` is this node or below it. */
const subtreeHas = (node: MailboxNode, id: string): boolean =>
  node.id === id || node.children.some((child) => subtreeHas(child, id));
/** Unread mail in the folders below a node (a shared account counts nothing itself). */
const subtreeUnread = (node: MailboxNode): number =>
  node.children.reduce((sum, child) => sum + (child.unreadEmails ?? 0) + subtreeUnread(child), 0);

/** A folder the server gave a role (inbox, sent, trash...), as opposed to one the user made. */
const isSystemFolder = (node: MailboxNode) => !!node.role;
/** Key of the single-account "Your folders" section in the collapsed set. */
const OWN_FOLDERS_KEY = '__own__';
/** Prefix of a Pro account group's "Shared" section in the same set. */
const SHARED_KEY_PREFIX = '__shared__:';

function SidebarSectionHeader({
  label,
  expanded,
  onToggle,
  onSettings,
  settingsTitle,
  isCollapsed,
  first,
  icon,
  sub,
  testId,
  onContextMenu,
  status,
  onAdd,
  addTitle,
  railKey,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  onSettings?: () => void;
  settingsTitle?: string;
  onAdd?: () => void;
  addTitle?: string;
  isCollapsed: boolean;
  first?: boolean;
  icon?: ReactNode;
  sub?: boolean;
  testId?: string;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** A short note after the label, e.g. how many accounts have loaded. */
  status?: ReactNode;
  /** The folded column's item for the same thing (see SidebarRow). */
  railKey?: string;
}) {
  if (isCollapsed) {
    // One thin rule between sections. A sub-section (a shared account, the
    // folders inside a Pro account group) draws none: under a section's own
    // rule they stacked into a ladder of lines.
    return first || sub ? null : <div className="h-px bg-border mx-2.5 my-1.5" data-rail-separator="" aria-hidden />;
  }

  const paddingY = sub ? "pt-2" : first ? "pt-3" : "pt-5";
  const paddingX = sub ? "px-4" : "px-3";
  const textClass = sub
    ? "text-xs font-semibold text-muted-foreground truncate"
    : "text-sm font-semibold text-foreground truncate";

  // The toggle is one button; Add and Settings are buttons beside it, not
  // inside it (a button in a button is one control to the keyboard). They
  // stay 24px with a muted hover so they fit the header line and don't run
  // into the folder row below, whose selection uses the accent colour.
  // Large targets still get the 44px hit area from the Button.
  const headerButtonClass = "-my-0.5 h-6 w-6 rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground";
  return (
    <div
      onContextMenu={onContextMenu}
      data-rail-key={railKey}
      className={cn(
        "group w-full flex items-center pb-1 select-none rounded-sm hover:bg-muted/40 transition-colors",
        paddingX,
        paddingY
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        data-testid={testId}
        data-section-name={label}
        data-expanded={expanded ? 'true' : 'false'}
        aria-expanded={expanded}
        className="flex flex-1 min-w-0 items-center text-start rounded-sm focus-visible:outline-hidden"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        )}
        {icon && <span className="ms-1.5 flex-shrink-0">{icon}</span>}
        <span className={cn(textClass, "ms-1.5")} title={label}>
          {label}
        </span>
        {status}
      </button>
      {onAdd && addTitle && (
        <IconButton
          label={addTitle}
          onClick={onAdd}
          className={headerButtonClass}
        >
          <Plus className="w-3.5 h-3.5" />
        </IconButton>
      )}
      {onSettings && settingsTitle && (
        <IconButton
          label={settingsTitle}
          onClick={onSettings}
          className={headerButtonClass}
        >
          <Settings className="w-3.5 h-3.5" />
        </IconButton>
      )}
    </div>
  );
}

/** Whether new mail in this folder of the active login stays silent (#1169). */
function useMutedMailbox(node: MailboxNode | null): boolean {
  const client = useAuthStore((s) => s.client);
  return useSettingsStore((s) => {
    if (!node || !client) return false;
    return isMailboxMuted(s.notificationMutes, node.accountId || client.getAccountId(), node.originalId || node.id);
  });
}

function MailboxTreeItem({
  node,
  selectedMailbox,
  expandedFolders,
  onMailboxSelect,
  onToggleExpand,
  isCollapsed,
  colorful,
  onContextMenu,
  dragAccountId = null,
  pickOnly = false,
  sharedAccountName,
  renderAfterChild,
  initials = false,
}: {
  node: MailboxNode;
  selectedMailbox: string;
  expandedFolders: Set<string>;
  onMailboxSelect?: (id: string) => void;
  onToggleExpand: (id: string) => void;
  isCollapsed: boolean;
  colorful: boolean;
  onContextMenu?: (e: React.MouseEvent, node: MailboxNode) => void;
  /** Connected-account id this folder is listed under; null = active account.
   *  Travels in the folder-drag payload so a folder tab fetches through the
   *  right client, and tells a message drop which login the folder is in. */
  dragAccountId?: string | null;
  /** Listed for opening only: no drag, no message drop, no mute state. For
   *  another login's shared mailboxes, which the active login can't reach. */
  pickOnly?: boolean;
  /** Set when this node is a shared account's inbox standing for the whole
   *  account (compact shared mailboxes, #1342): the row is named after the
   *  account and carries its icon. */
  sharedAccountName?: string;
  /** Rendered after each direct child's subtree, e.g. the Scheduled row after
   *  Drafts. Not passed further down. */
  renderAfterChild?: (child: MailboxNode) => React.ReactNode;
  /** Folded: several folders of one's own are listed, so each carries its
   *  first letter. One alone is a plain folder. */
  initials?: boolean;
}) {
  const tNotifications = useTranslations('notifications');
  const tListExtra = useTranslations('mail_list_extra');
  const tRoot = useTranslations();
  const tSidebar = useTranslations('sidebar');
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedFolders.has(node.id);
  // Folded, no subfolders show, so no folder is drawn open.
  const Icon = sharedAccountName ? User : getIconForMailbox(node.role, hasChildren, isExpanded && !isCollapsed, node.id);
  const isVirtualNode = node.id.startsWith('shared-');
  const isSelected = selectedMailbox === node.id;
  const label = sharedAccountName ?? localizeMailboxName(node.role, node.name, (k) => tSidebar(`mailboxes.${k}`));
  // Folded to icons, eight folders of one's own were eight identical folder
  // icons (p2-9): each carries its first letter inside the folder glyph.
  const letterIcon = isCollapsed && initials && !node.role && !sharedAccountName && !isVirtualNode;
  // Only for the active login's folders: its client tells a missing
  // accountId (own mailbox) apart.
  const muted = useMutedMailbox(isVirtualNode || dragAccountId || pickOnly ? null : node);

  const isEmbedded = useIsEmbedded();
  // Pro shell only: folder rows are drag sources so a folder can be dropped
  // onto a tab strip / pane and open as its own tab. Native HTML5 DnD - the
  // Pro shell's drop targets live outside any dnd-kit context.
  const folderDragHandlers: Record<string, unknown> | undefined =
    isEmbedded && !isVirtualNode && !pickOnly
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(
              MAILBOX_DRAG_MIME,
              JSON.stringify({ mailboxId: node.id, name: label, accountId: dragAccountId }),
            );
            e.dataTransfer.effectAllowed = 'copy';
          },
        }
      : undefined;

  const { isDragging: globalDragging } = useDragDropContext();
  const { dropHandlers, isValidDropTarget } = useMailboxDrop({
    mailbox: node,
    accountId: dragAccountId ?? undefined,
    onSuccess: (count, mailboxName, restore, receipts) => {
      // One line: "Moved to Family", not "Email moved. Moved to Family." (mail-18)
      toastWithUndo(
        count === 1
          ? tListExtra('moved_to', { mailbox: mailboxName })
          : batchToastTitle(tRoot, 'move', count, useSettingsStore.getState().disableThreading, mailboxName),
        undoMoveAction(useAuthStore.getState().client, restore, undoLabels(tNotifications), receipts),
      );
    },
    onError: () => {
      toast.error(tNotifications('move_failed'), tNotifications('move_error'));
    },
  });

  return (
    <>
      <SidebarRow
        icon={letterIcon
          ? <FolderInitial name={label} className={getIconClass(isSelected, false, false)} />
          : <Icon className={getIconClass(isSelected, isVirtualNode, colorful, sharedAccountName ? undefined : node.role)} />}
        label={label}
        testRole={node.role}
        testName={node.name}
        testMailboxId={node.id}
        testShared={node.isShared}
        depth={node.depth}
        isSelected={isSelected}
        isVirtual={isVirtualNode}
        unread={node.unreadEmails}
        total={node.totalEmails}
        onClick={() => onMailboxSelect?.(node.id)}
        hasChildren={hasChildren}
        isExpanded={isExpanded}
        onExpandToggle={() => onToggleExpand(node.id)}
        isCollapsed={isCollapsed}
        dropHandlers={
          folderDragHandlers || (globalDragging && !pickOnly)
            ? {
                ...(folderDragHandlers ?? {}),
                ...(globalDragging && !pickOnly ? (dropHandlers as Record<string, unknown>) : {}),
              }
            : undefined
        }
        isValidDropTarget={isValidDropTarget && !pickOnly}
        onContextMenu={onContextMenu && !isVirtualNode ? (e) => onContextMenu(e, node) : undefined}
        muted={muted}
        subfolderUnread={hasChildren && (isCollapsed || !isExpanded) ? subtreeUnread(node) : 0}
      />

      {hasChildren && isExpanded && !isCollapsed && node.children.map((child) => (
        <Fragment key={child.id}>
          <MailboxTreeItem
            node={child}
            selectedMailbox={selectedMailbox}
            expandedFolders={expandedFolders}
            onMailboxSelect={onMailboxSelect}
            onToggleExpand={onToggleExpand}
            isCollapsed={isCollapsed}
            colorful={colorful}
            onContextMenu={onContextMenu}
            dragAccountId={dragAccountId}
            pickOnly={pickOnly}
          />
          {renderAfterChild?.(child)}
        </Fragment>
      ))}
    </>
  );
}

function ShowAllTagsRow({
  hiddenCount,
  showAll,
  onToggle,
  isCollapsed,
}: {
  hiddenCount: number;
  showAll: boolean;
  onToggle: () => void;
  isCollapsed: boolean;
}) {
  const t = useTranslations('sidebar');

  return (
    <SidebarRow
      icon={<MoreHorizontal className="w-4 h-4 text-muted-foreground" />}
      label={showAll ? t('show_fewer_tags') : t('show_all_tags', { count: hiddenCount })}
      depth={0}
      onClick={onToggle}
      isCollapsed={isCollapsed}
    />
  );
}

function TagItem({
  node,
  selectedKeyword,
  expandedTags,
  isCollapsed,
  onTagSelect,
  onToggleExpand,
  tagCounts,
  colorful,
}: {
  node: KeywordNode;
  selectedKeyword: string | null;
  expandedTags: Set<string>;
  isCollapsed: boolean;
  onTagSelect?: (keywordId: string | null, accountId?: string | null) => void;
  onToggleExpand: (keywordId: string) => void;
  tagCounts: Record<string, { total: number; unread: number }>;
  colorful: boolean;
}) {
  const t = useTranslations('notifications');
  const { tagNameCandidates, tagColor } = useKeywordFormat();
  const palette = tagColor(node.id);
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedTags.has(node.id);
  const isSelected = selectedKeyword === node.id;
  // Nested rows are placed by their indentation, so they show their own name.
  // A root spells out its path, which matters when an intermediate tag is
  // missing from this client's settings and the row would otherwise read as a
  // bare leaf name.
  const labelCandidates = node.depth === 0 ? tagNameCandidates(node.id) : [node.label];
  const label = labelCandidates[0];
  // Toasts have the room for the whole thing, and no indentation to lean on,
  // so they always spell out the full path - otherwise two leaves with the
  // same name in different branches (e.g. "Personal/Receipts" and
  // "Work/Receipts") would read as the same tag.
  const fullLabel = tagNameCandidates(node.id)[0];
  const { isDragging: globalDragging } = useDragDropContext();
  const { dropHandlers, isValidDropTarget } = useTagDrop({
    tagId: node.id,
    onSuccess: (count) => {
      if (count === 1) {
        toast.success(t('email_tagged'), fullLabel);
      } else {
        toast.success(t('emails_tagged', { count }), fullLabel);
      }
    },
    onError: () => {
      toast.error(t('tag_failed'), fullLabel);
    },
  });

  const tagIcon = colorful ? (
    <Tag className={cn("w-4 h-4 flex-shrink-0", palette.icon)} fill="currentColor" />
  ) : (
    <span className={cn("w-3 h-3 rounded-full", palette.dot)} />
  );

  return (
    <>
      <SidebarRow
        icon={tagIcon}
        label={label}
        labelCandidates={labelCandidates}
        depth={node.depth}
        isSelected={isSelected}
        unread={tagCounts[node.id]?.unread ?? 0}
        total={tagCounts[node.id]?.total ?? 0}
        onClick={() => onTagSelect?.(isSelected ? null : node.id)}
        hasChildren={hasChildren}
        isExpanded={isExpanded}
        onExpandToggle={() => onToggleExpand(node.id)}
        isCollapsed={isCollapsed}
        dropHandlers={globalDragging ? (dropHandlers as Record<string, unknown>) : undefined}
        isValidDropTarget={isValidDropTarget}
        railKey={`tag:${node.id}`}
      />

      {hasChildren && isExpanded && !isCollapsed && node.children.map((child) => (
        <TagItem
          key={child.id}
          node={child}
          selectedKeyword={selectedKeyword}
          expandedTags={expandedTags}
          isCollapsed={isCollapsed}
          onTagSelect={onTagSelect}
          onToggleExpand={onToggleExpand}
          tagCounts={tagCounts}
          colorful={colorful}
        />
      ))}
    </>
  );
}

type TagCounts = Record<string, { total: number; unread: number }>;
const NO_TAG_COUNTS: TagCounts = {};

/**
 * Counts of a group account's shared tags in that account only, outside
 * Trash and Junk like the tag view. Asked again whenever the sidebar's own
 * tag counts are (every mail change), and when the tags change.
 */
function useSharedTagCounts(accountId: string, ids: string[], enabled: boolean): TagCounts {
  const client = useAuthStore((s) => s.client);
  const refresh = useEmailStore((s) => s.tagCounts);
  const idsKey = ids.join('\n');
  const [counts, setCounts] = useState<TagCounts>(NO_TAG_COUNTS);
  useEffect(() => {
    if (!enabled || !client || !idsKey) return;
    const account = buildTagViewAccountClients(client).find((a) => a.jmapAccountId === accountId);
    if (!account) return;
    let cancelled = false;
    client.getTagCounts(idsKey.split('\n'), accountId, trashAndJunkIds(account))
      .then((next) => { if (!cancelled) setCounts(next); })
      .catch(() => { /* the rows show no count */ });
    return () => { cancelled = true; };
  }, [client, accountId, idsKey, refresh, enabled]);
  return counts;
}

/**
 * The tags of a group account, under its folders in the Shared section: the
 * shared definitions plus the tags found on its messages (useAccountTags),
 * with their counts in that account. Picking one lists that account's
 * messages with the tag. Nothing for a mailbox a person shared or a server
 * without metadata, where the user's own tags above stand for every account
 * as before.
 */
function SharedAccountTags({
  loginId,
  accountId,
  selectedKeyword,
  expandedTags,
  onTagSelect,
  onToggleExpand,
  colorful,
}: {
  loginId: string;
  accountId: string;
  /** The tag picked in this account's list, if any. */
  selectedKeyword: string | null;
  expandedTags: Set<string>;
  onTagSelect?: (keywordId: string | null, accountId?: string | null) => void;
  onToggleExpand: (keywordId: string) => void;
  colorful: boolean;
}) {
  const t = useTranslations('shared_tags');
  const router = useRouter();
  const scope = useMemo(() => ({ loginId, accountId }), [loginId, accountId]);
  const { definitions, shared } = useAccountTags(scope);
  const nestedTags = useSettingsStore((s) => s.nestedTags);
  const [expanded, setExpanded] = useState(true);
  const tree = useMemo(
    () => (nestedTags ? buildKeywordTree(definitions) : definitions.map((kw) => ({ ...kw, children: [], depth: 0 }))),
    [definitions, nestedTags],
  );
  const ids = useMemo(() => definitions.map((kw) => kw.id), [definitions]);
  const counts = useSharedTagCounts(accountId, ids, shared && expanded);
  const select = useCallback(
    (keywordId: string | null) => onTagSelect?.(keywordId, keywordId ? accountId : null),
    [onTagSelect, accountId],
  );
  if (!shared || definitions.length === 0) return null;
  return (
    <TagScopeContext.Provider value={scope}>
      <div data-testid="shared-account-tags">
        <SidebarSectionHeader
          label={t('sidebar_heading')}
          expanded={expanded}
          onToggle={() => setExpanded((open) => !open)}
          onSettings={() => router.push(buildSettingsPath('organize', 'shared-tags'))}
          settingsTitle={t('edit')}
          testId="section-shared-tags"
          isCollapsed={false}
          sub
        />
        {expanded && tree.map((node) => (
          <TagItem
            key={node.id}
            node={node}
            selectedKeyword={selectedKeyword}
            expandedTags={expandedTags}
            isCollapsed={false}
            onTagSelect={select}
            onToggleExpand={onToggleExpand}
            tagCounts={counts}
            colorful={colorful}
          />
        ))}
      </div>
    </TagScopeContext.Provider>
  );
}

function DemoBanner({ ruled }: { ruled: boolean }) {
  const t = useTranslations('sidebar');
  const { isDemoMode, loginDemo } = useAuthStore(useShallow((state) => ({ isDemoMode: state.isDemoMode, loginDemo: state.loginDemo })));
  const { startTour, resetTourCompletion } = useTour();
  const router = useRouter();
  const [isResetting, setIsResetting] = useState(false);

  if (!isDemoMode) return null;

  const handleReset = async () => {
    setIsResetting(true);
    router.push('/');
    // Also put the seeded demo preferences (tags, merged inbox, templates) back.
    try { localStorage.removeItem('bulwark-demo-seed'); } catch { /* storage blocked */ }
    await loginDemo();
    setIsResetting(false);
  };

  const handleStartTour = () => {
    resetTourCompletion();
    router.push('/');
    setTimeout(() => startTour(), 100);
  };

  // One line in the sidebar's own style, like a section header: muted label,
  // the header's small icon buttons, no tinted block. Icon-only because
  // "Tour" and "Reset" run long in several locales and the line is narrow.
  const buttonClass = "-my-0.5 h-6 w-6 rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground";
  return (
    <div
      data-tour="demo-banner"
      className={cn(
        "flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground",
        ruled && "border-b border-border",
      )}
    >
      <FlaskConical className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1 truncate">{t("demo_banner")}</span>
      <IconButton label={t("demo_tour")} onClick={handleStartTour} className={buttonClass}>
        <PlayCircle className="w-3.5 h-3.5" />
      </IconButton>
      <IconButton label={t("demo_reset")} onClick={handleReset} disabled={isResetting} className={buttonClass}>
        {isResetting ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RotateCcw className="w-3.5 h-3.5" />
        )}
      </IconButton>
    </div>
  );
}

export function VacationBanner() {
  const t = useTranslations('sidebar');
  const tNotifications = useTranslations('notifications');
  const tFilters = useTranslations('settings.filters');
  const router = useRouter();
  const { isEnabled, isSupported, isSaving } = useVacationStore(useShallow((state) => ({
    isEnabled: state.isEnabled, isSupported: state.isSupported, isSaving: state.isSaving,
  })));
  // The store holds the reply of the account Settings last loaded it for.
  const managedAccountId = useManagedAccountStore((s) => s.managedAccountId);
  const client = useAuthStore((s) => s.client);
  const [turningOff, setTurningOff] = useState(false);

  if (!isSupported || !isEnabled) return null;

  // Like Gmail's "End now": off on the server, without opening Settings.
  const turnOff = async () => {
    if (!client || turningOff) return;
    setTurningOff(true);
    try {
      await useVacationStore.getState().updateVacationResponse(client, { isEnabled: false }, managedAccountId ?? undefined);
    } catch {
      toast.error(tNotifications('vacation_save_failed'));
    } finally {
      setTurningOff(false);
    }
  };

  return (
    <div
      className={cn(
        "flex items-center gap-2 w-full px-3 py-1.5 text-xs",
        "bg-amber-500/10 dark:bg-amber-400/10 text-amber-700 dark:text-amber-400",
      )}
    >
      <button
        type="button"
        onClick={() => router.push(buildSettingsPath('vacation'))}
        className="flex items-center gap-2 min-w-0 flex-1 py-0.5 text-start hover:underline"
      >
        <Palmtree className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="truncate font-medium">{tFilters("vacation_active")}</span>
      </button>
      <button
        type="button"
        onClick={() => void turnOff()}
        disabled={turningOff || isSaving}
        className="inline-flex flex-shrink-0 items-center gap-1 px-2 py-0.5 rounded-sm font-medium hover:bg-amber-500/15 dark:hover:bg-amber-400/15 disabled:opacity-60 transition-colors"
      >
        {turningOff ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : null}
        {t("vacation_turn_off")}
      </button>
    </div>
  );
}

function SidebarImpl({
  mailboxes = [],
  selectedMailbox = "",
  selectedKeyword = null,
  onMailboxSelect,
  onTagSelect,
  onCompose,
  onSidebarClose,
  onMarkFolderRead,
  onMarkFolderTreeRead,
  onMarkAllFoldersRead,
  onEmptyFolder,
  onCreateSubfolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onShareFolder,
  onImportEmail,
  onRefreshMailboxes,
  scheduledTotal = 0,
  scheduledTotalByAccount,
  scheduledAccountScope = null,
  showScheduledMailbox = false,
  crossAccountActive = false,
  showCrossUnread = false,
  showCrossStarred = false,
  onOpenStarred,
  showCrossAll = false,
  crossUnreadCount = 0,
  className,
  multiAccountMode = false,
  accountMailboxes,
  viewingAccountId = null,
  onAccountMailboxSelect,
  accountSharedMailboxes,
  onLoginSharedMailboxSelect,
  mvShell = false,
  onDrawerChange,
}: SidebarProps) {
  const router = useRouter();
  // The rail is a desktop thing. Below that the sidebar is a drawer, opened to
  // read the folder names, whatever the collapse button last said on a wider
  // window. A compact desktop (or Pro pane) starts with the rail.
  const { isMobile: isDrawer, isCompact } = useDeviceDetection();
  const { sidebarCollapsed, toggleSidebarCollapsed } = useUIStore(useShallow((state) => ({ sidebarCollapsed: sidebarFolded(state, isCompact), toggleSidebarCollapsed: state.toggleSidebarCollapsed })));
  // Mountain View's collapsed rail is a peek, not a commitment: putting the pointer on
  // it slides the full list back out over the message list and takes it away
  // again on leaving, so a folder two clicks deep costs no clicks at all. It
  // floats rather than widening the column, or every hover would reflow the
  // list behind it.
  const [railHovered, setRailHovered] = useState(false);
  // The default layout's folded column floats the whole tree out too, so
  // subfolders and folder names are a hover or a click away (p2-9). A hover
  // waits a moment there, so passing over the column on the way to the list
  // doesn't open it; "All folders" opens it by click, tap or keyboard.
  const [railOpen, setRailOpen] = useState(false);
  const railHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const allFoldersRef = useRef<HTMLButtonElement>(null);
  const hoverExpanded = sidebarCollapsed && !isDrawer && (railHovered || railOpen);
  const isCollapsed = sidebarCollapsed && !hoverExpanded && !isDrawer;
  // Outside Mountain View the floated tree is a drawer, as in Outlook and
  // Thunderbird: from the window's start edge, over the app rail and the
  // folded column, with the page dimmed behind it (the caller draws that).
  // Floating beside the rail with nothing behind it, it looked like a second
  // sidebar cut into the list. Mountain View keeps Gmail's peek beside its rail.
  const isFolderDrawer = hoverExpanded && !mvShell;
  const closeRailPeek = useCallback(() => {
    if (railHoverTimer.current) clearTimeout(railHoverTimer.current);
    railHoverTimer.current = null;
    setRailHovered(false);
    setRailOpen(false);
  }, []);
  useEffect(() => () => { if (railHoverTimer.current) clearTimeout(railHoverTimer.current); }, []);
  // Unfolded or turned into the phone drawer meanwhile: nothing floats any more.
  useEffect(() => {
    if (!sidebarCollapsed || isDrawer) closeRailPeek();
  }, [sidebarCollapsed, isDrawer, closeRailPeek]);
  const onDrawerChangeRef = useRef(onDrawerChange);
  useEffect(() => { onDrawerChangeRef.current = onDrawerChange; });
  useEffect(() => {
    if (!isFolderDrawer) return;
    onDrawerChangeRef.current?.(closeRailPeek);
    return () => onDrawerChangeRef.current?.(null);
  }, [isFolderDrawer, closeRailPeek]);
  // Opened from All folders, the drawer gives the focus back there however it
  // closes: Escape, the collapse button, a pick, a press on the dimmed page.
  const railWasOpen = useRef(false);
  useEffect(() => {
    if (railOpen) { railWasOpen.current = true; return; }
    if (!railWasOpen.current) return;
    railWasOpen.current = false;
    // A frame later: a press on the scrim closes it on pointerdown, and the
    // press itself then drops the focus to the page.
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !rootRef.current?.contains(active)) return;
      allFoldersRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [railOpen]);
  // The pointer resting on the folders floats the tree out; on the header
  // (expand, compose) it doesn't, so the expand button can still be clicked.
  const navRef = useRef<HTMLElement>(null);
  // The item the pointer rests on in the folded column, and where on screen.
  const hoveredRailItem = useRef<{ key: string; top: number } | null>(null);
  const lastPointer = useRef<{ x: number; y: number; target: EventTarget | null }>({ x: 0, y: 0, target: null });
  // Read when the tree floats out, not when the pointer arrived: the column
  // may have been scrolled under a resting pointer in between.
  const noteHoveredRailItem = useCallback(() => {
    const { x, y, target } = lastPointer.current;
    const under = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    const from = under ?? (target instanceof Element ? target : null);
    const item = from?.closest<HTMLElement>('[data-rail-key]');
    hoveredRailItem.current = item?.dataset.railKey && navRef.current?.contains(item)
      ? { key: item.dataset.railKey, top: item.getBoundingClientRect().top }
      : null;
  }, []);
  const armRailHover = useCallback((e: React.MouseEvent) => {
    if (!hoverOpens()) return;
    const target = e.target;
    lastPointer.current = { x: e.clientX, y: e.clientY, target };
    if (mvShell) { noteHoveredRailItem(); setRailHovered(true); return; }
    if (target instanceof Element && target.closest('[data-sidebar-head]')) {
      if (railHoverTimer.current) clearTimeout(railHoverTimer.current);
      railHoverTimer.current = null;
      return;
    }
    if (railHoverTimer.current) return;
    railHoverTimer.current = setTimeout(() => {
      railHoverTimer.current = null;
      noteHoveredRailItem();
      setRailHovered(true);
    }, RAIL_HOVER_DELAY_MS);
  }, [mvShell, noteHoveredRailItem]);
  // The folded column and the tree floated out of it share one scrolling
  // list. Scrolled down the column, the tree opened at that same offset, which
  // in the longer tree was somewhere else: a hover now puts the hovered item
  // back under the pointer, All folders starts at the top (and the focus
  // brings the open folder into view), and folding back returns the column
  // to where it was.
  const railScrollTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    if (hoverExpanded) {
      if (railScrollTop.current !== null) return;
      railScrollTop.current = nav.scrollTop;
      const hovered = railOpen ? null : hoveredRailItem.current;
      const item = hovered
        ? Array.from(nav.querySelectorAll<HTMLElement>('[data-rail-key]')).find((el) => el.dataset.railKey === hovered.key)
        : null;
      nav.scrollTop = item && hovered ? nav.scrollTop + item.getBoundingClientRect().top - hovered.top : 0;
      return;
    }
    if (railScrollTop.current === null) return;
    const railTop = railScrollTop.current;
    railScrollTop.current = null;
    // Unfolded meanwhile: the full list keeps its own place.
    if (!isCollapsed) return;
    nav.scrollTop = railTop;
    // A folder picked in the tree is shown in the column too.
    const current = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!current) return;
    const view = nav.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    if (box.top < view.top) nav.scrollTop += box.top - view.top;
    else if (box.bottom > view.bottom) nav.scrollTop += box.bottom - view.bottom;
  }, [hoverExpanded, railOpen, isCollapsed]);
  // Folded, the arrows, Home and End go from item to item, Enter opens.
  const moveInRail = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-testid="folder-row"] > button:not(:disabled)'));
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
      : at < 0 ? 0
      : e.key === 'ArrowDown' ? Math.min(at + 1, items.length - 1) : Math.max(at - 1, 0);
    e.preventDefault();
    e.stopPropagation();
    items[next].focus();
  }, []);
  const { primaryIdentity: _primaryIdentity, activeAccountId } = useAuthStore(useShallow((state) => ({ primaryIdentity: state.primaryIdentity, activeAccountId: state.activeAccountId })));
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set());
  const [showAllTags, setShowAllTags] = useState(false);
  const [moreExpanded, setMoreExpanded] = useState(false);
  const [foldersExpanded, setFoldersExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem('sidebarFoldersExpanded');
      return stored !== null ? JSON.parse(stored) : true;
    } catch { return true; }
  });
  const [tagsExpanded, setTagsExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem('sidebarTagsExpanded');
      return stored !== null ? JSON.parse(stored) : true;
    } catch { return true; }
  });
  const [unifiedExpanded, setUnifiedExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem('sidebarUnifiedExpanded');
      return stored !== null ? JSON.parse(stored) : true;
    } catch { return true; }
  });
  const [sharedExpanded, setSharedExpanded] = useState(() => {
    try {
      const stored = localStorage.getItem('sidebarSharedExpanded');
      return stored !== null ? JSON.parse(stored) : false;
    } catch { return false; }
  });
  const [expandedSharedAccounts, setExpandedSharedAccounts] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('sidebarExpandedSharedAccounts');
      return stored !== null ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch { return new Set(); }
  });
  // Per-connected-account collapse state for Pro / Thunderbird-style mode.
  // Stored as the set of accountIds the user has explicitly collapsed -
  // anything not in the set is treated as expanded. Inverting the storage
  // model lets new accounts default to expanded automatically.
  const [collapsedAccountGroups, setCollapsedAccountGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('sidebarCollapsedAccountGroups');
      if (stored !== null) return new Set(JSON.parse(stored) as string[]);
    } catch { /* fall through */ }
    return new Set();
  });
  // "Your folders" sections the user has collapsed: OWN_FOLDERS_KEY for the
  // single-account list, the accountId for each Pro account group.
  const [collapsedCustomFolders, setCollapsedCustomFolders] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('sidebarCollapsedCustomFolders');
      if (stored !== null) return new Set(JSON.parse(stored) as string[]);
    } catch { /* fall through */ }
    return new Set();
  });
  const emailKeywords = useSettingsStore(s => s.emailKeywords);
  const nestedTags = useSettingsStore(s => s.nestedTags);
  const tagsAboveShared = usePolicyStore(s => s.isFeatureEnabled('tagsAboveSharedEnabled'));
  // A tag picked in a group account's shared tags (see SharedAccountTags).
  const selectedKeywordAccountId = useEmailStore(s => s.selectedKeywordAccountId);
  const personalSelectedKeyword = selectedKeywordAccountId ? null : selectedKeyword;
  const isEmbedded = useIsEmbedded();
  const sidebarAccountSwitcher = useSettingsStore(s => s.sidebarAccountSwitcher);
  const enableUnifiedMailbox = useSettingsStore(s => s.enableUnifiedMailbox);
  const includeGroupInUnified = useSettingsStore(s => s.includeGroupInUnified);
  const showSharedMailAccounts = useSettingsStore(s => s.showSharedMailAccounts);
  const compactSharedMailboxes = useSettingsStore(s => s.compactSharedMailboxes);
  const hiddenSharedMailAccounts = useSettingsStore(s => s.hiddenSharedMailAccounts);
  // Mountain View draws its navigation icons in the text colour.
  const colorfulSidebarIcons = useSettingsStore(s => s.colorfulSidebarIcons) && !mvShell;
  const tagCounts = useEmailStore(s => s.tagCounts);
  const accounts = useAccountStore(s => s.accounts);
  const connectedAccounts = accounts.filter(a => a.isConnected);
  const hasGroupInboxes = useMemo(() => mailboxes.some(m => m.isShared), [mailboxes]);
  // Pro shell treats the unified mailbox as a core part of the multi-account
  // UI, so it ignores the user-facing `enableUnifiedMailbox` toggle. With a
  // single account we still surface unified when the user has opted into
  // merging group/shared inboxes — otherwise the counts would just duplicate
  // the one inbox.
  // Only show the section when mail-app will actually populate it: cross-account
  // needs the admin gate + user toggle (`crossAccountActive`, which already
  // implies 2+ connected accounts), otherwise a merged group inbox or one of
  // the cross views must exist. A bare "2+ accounts" left an empty header. (#843)
  const anyCrossViewEnabled = showCrossUnread || showCrossStarred || showCrossAll;
  const showUnified =
    (multiAccountMode || enableUnifiedMailbox) &&
    (crossAccountActive || (includeGroupInUnified && hasGroupInboxes) || anyCrossViewEnabled);
  const { unifiedCounts } = useEmailStore(useShallow((state) => ({ unifiedCounts: state.unifiedCounts })));
  // While the other logins are still reconnecting after a load, the unified
  // counts cover only the ones already back: say how many, so a partial total
  // is not read as the whole. Gone as soon as the restore finishes, whatever
  // became of the logins that did not make it.
  const unifiedScope = useEmailStore((s) => s.unifiedScope);
  const restoringAccounts = useAuthStore((s) => s.restoringAccounts);
  const unifiedProgress = useMemo(() => unifiedLoadProgress({
    crossAccountActive, restoring: restoringAccounts, scope: unifiedScope, accounts,
  }), [crossAccountActive, restoringAccounts, accounts, unifiedScope]);
  const t = useTranslations('sidebar');
  const tP2 = useTranslations('mail_p2_folders');

  // A pick in the floated tree folds it away again (the hover peek of the
  // default layout, and the one "All folders" opened).
  const pickedRef = useRef({ mailbox: selectedMailbox, keyword: selectedKeyword });
  useEffect(() => {
    const before = pickedRef.current;
    pickedRef.current = { mailbox: selectedMailbox, keyword: selectedKeyword };
    if (before.mailbox === selectedMailbox && before.keyword === selectedKeyword) return;
    if (railOpen || !mvShell) closeRailPeek();
  }, [selectedMailbox, selectedKeyword, railOpen, mvShell, closeRailPeek]);
  // Opened from "All folders": the focus goes to the open folder in the tree,
  // and a press anywhere outside folds it away.
  useEffect(() => {
    if (!railOpen) return;
    const root = rootRef.current;
    const target = root?.querySelector<HTMLElement>('nav [aria-current="page"]')
      ?? root?.querySelector<HTMLElement>('nav button:not([disabled])');
    target?.focus();
    const onPointerDown = (e: PointerEvent) => {
      // The scrim behind the drawer closes it on its own click: gone at the
      // press, it would let that click through to the message under it.
      if (e.target instanceof Element && e.target.closest('[data-drawer-scrim]')) return;
      if (root && !root.contains(e.target as Node)) closeRailPeek();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [railOpen, closeRailPeek]);

  useEffect(() => {
    const stored = localStorage.getItem('expandedMailboxes');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setExpandedFolders(new Set(parsed));
      } catch (e) {
        debug.error('Failed to parse expanded mailboxes:', e);
      }
    } else {
      const tree = buildMailboxTree(mailboxes);
      const collectExpandable = (nodes: MailboxNode[]): string[] => {
        const ids: string[] = [];
        for (const node of nodes) {
          if (node.children.length > 0) {
            ids.push(node.id);
            ids.push(...collectExpandable(node.children));
          }
        }
        return ids;
      };
      setExpandedFolders(new Set(collectExpandable(tree)));
    }
  }, [mailboxes]);

  const handleToggleExpand = (mailboxId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(mailboxId)) {
        next.delete(mailboxId);
      } else {
        next.add(mailboxId);
      }
      try {
        localStorage.setItem('expandedMailboxes', JSON.stringify(Array.from(next)));
      } catch { /* storage full or unavailable */ }
      return next;
    });
  };

  useEffect(() => {
    const stored = localStorage.getItem('expandedTags');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setExpandedTags(new Set(parsed));
      } catch (e) {
        debug.error('Failed to parse expanded tags:', e);
      }
    } else {
      setExpandedTags(
        new Set(emailKeywords.filter((kw) => hasChildKeywords(kw.id, emailKeywords)).map((kw) => kw.id))
      );
    }
  }, [emailKeywords]);

  const handleToggleTagExpand = (keywordId: string) => {
    setExpandedTags((prev) => {
      const next = new Set(prev);
      if (next.has(keywordId)) {
        next.delete(keywordId);
      } else {
        next.add(keywordId);
      }
      try {
        localStorage.setItem('expandedTags', JSON.stringify(Array.from(next)));
      } catch { /* storage full or unavailable */ }
      return next;
    });
  };

  // When the app renders its own virtual "Scheduled" folder (for delayed
  // sends, driven by EmailSubmission), hide the server-provided scheduled
  // mailbox (e.g. Stalwart's auto-created Scheduled folder, role === 'scheduled')
  // so it does not appear twice. (#495)
  const isServerScheduledNode = (n: MailboxNode) => showScheduledMailbox && n.role === 'scheduled';

  const mailboxTree = buildMailboxTree(mailboxes);
  const ownTree = mailboxTree.filter(n => !n.id.startsWith('shared-account-') && !isServerScheduledNode(n));
  const hiddenSharedIds = hiddenSharedMailIds(hiddenSharedMailAccounts, activeAccountId);
  const sharedAccounts = mailboxTree.filter(n =>
    n.id.startsWith('shared-account-')
    && isSharedMailAccountVisible(n.accountId, showSharedMailAccounts, hiddenSharedIds));

  // Mountain View's navigation is one flat list of the few places mail
  // actually goes, with everything else - the folders you made, the shared
  // ones, the labels - behind a single "More". The "Folders" and "Tags"
  // headings say the same thing the icons already do, so the first heading
  // goes and the rest move below the expander. The collapsed rail is left as
  // it is: it shows icons only, and hiding half of them behind a word would
  // leave a control with no room to put it.
  const mvFlat = mvShell && !isCollapsed;
  // Under the collapsible unified section the folders need a heading of their
  // own; without one they read as part of that section, and collapsing it
  // seemed to leave half of it behind (#1470).
  const unifiedSectionShown = showUnified || anyCrossViewEnabled;
  const mvFoldersHeadless = mvFlat && !unifiedSectionShown;
  const isPrimaryFolder = (node: MailboxNode) =>
    node.role === 'inbox' || node.role === 'sent' || node.role === 'drafts';
  // Everywhere else the folders the user made sit in a "Your folders" section
  // of their own below the system folders (#1205). Folders nested under a
  // system folder stay with their parent. With no folders of your own there is
  // no section, so the list looks as it always did.
  const primaryTree = mvFlat ? ownTree.filter(isPrimaryFolder) : ownTree.filter(isSystemFolder);
  const customTree = mvFlat ? [] : ownTree.filter((node) => !isSystemFolder(node));
  const secondaryTree = mvFlat ? ownTree.filter((node) => !isPrimaryFolder(node)) : [];
  // Of those, the system folders (archive, spam, trash...) go behind "More",
  // and the folders the user made are listed with the tags under "Labels",
  // which is what they are to someone coming from Gmail.
  const moreTree = secondaryTree.filter((node) => !!node.role);
  const labelTree = secondaryTree.filter((node) => !node.role);
  // Everything under "More" is hidden together, so one flag covers the extra
  // folders, the shared accounts and the labels.
  const showSecondary = !mvFlat || moreExpanded;

  // With nesting off every tag is its own root, so the same rows render through
  // one path whether or not the ids describe a hierarchy.
  const tagTree: KeywordNode[] = nestedTags
    ? buildKeywordTree(emailKeywords)
    : emailKeywords.map((kw) => ({ ...kw, children: [], depth: 0 }));

  // Counts arrive from a separate JMAP round trip, one batch per group of tags;
  // a tag with no count yet is treated as visible rather than blanking it and
  // filling it back in. A tag the server answered for with zero unread hides,
  // which is the point of the setting.
  const isTagVisible = (node: KeywordNode) => {
    if (showAllTags || node.id === personalSelectedKeyword) return true;
    const visibility = getKeywordVisibility(node);
    if (visibility === 'hide') return false;
    if (visibility === 'unread') {
      const count = tagCounts[node.id];
      return !count || count.unread > 0;
    }
    return true;
  };
  const visibleTagTree = filterKeywordTree(tagTree, isTagVisible);
  const hiddenTagCount = emailKeywords.length - countKeywordNodes(visibleTagTree);

  // Multi-account mode (Pro shell): render every connected account as its
  // own collapsible group. The active account's tree comes from the
  // `mailboxes` prop (which is the live email-store value); other accounts
  // come from the per-account cache populated by useProMultiAccountMailboxes.
  const useMultiAccount = multiAccountMode && connectedAccounts.length > 1;
  const accountGroups = useMultiAccount
    ? connectedAccounts.map((account) => {
        const isActive = account.id === activeAccountId;
        const accountMailboxList = isActive
          ? mailboxes
          : (accountMailboxes?.[account.id] ?? []);
        const tree = buildMailboxTree(accountMailboxList).filter(
          (n) => !n.id.startsWith('shared-account-') && !(isActive && isServerScheduledNode(n))
        );
        // The active login's shared mailboxes are in `mailboxes`; the others'
        // are kept beside their own folders (#1486).
        const hiddenIds = hiddenSharedMailIds(hiddenSharedMailAccounts, account.id);
        const shared = isActive
          ? sharedAccounts
          : buildMailboxTree(accountSharedMailboxes?.[account.id] ?? []).filter((n) =>
            n.id.startsWith('shared-account-')
            && isSharedMailAccountVisible(n.accountId, showSharedMailAccounts, hiddenIds));
        return { account, isActive, tree, shared };
      })
    : [];

  // Scheduled row. Without an account it is the combined view (the user's own
  // tree); with one it scopes the list to that shared account's scheduled mail,
  // which lives in the shared JMAP account rather than the primary one (#874).
  const renderScheduledRow = (key: string, account?: { accountId?: string; depth?: number }) => {
    if (!showScheduledMailbox) return null;
    const accountId = account?.accountId;
    const mailboxId = accountId ? scopedScheduledMailboxId(accountId) : SCHEDULED_MAILBOX_ID;
    const count = accountId
      ? (scheduledTotalByAccount?.[accountId] ?? 0)
      : scheduledTotal;
    // selectedMailbox is always the plain virtual id, so the *scope* decides
    // which of these rows is the active one.
    const isScheduledSelected = selectedMailbox === SCHEDULED_MAILBOX_ID
      && (scheduledAccountScope ?? null) === (accountId ?? null);
    return (
      <SidebarRow
        key={key}
        icon={<CalendarClock className={cn("w-4 h-4 flex-shrink-0", mvShell ? "text-foreground/80" : ROLE_ICON_COLOR.scheduled)} />}
        label={t('scheduled')}
        depth={account?.depth ?? 0}
        isSelected={!selectedKeyword && isScheduledSelected}
        total={count}
        onClick={() => onMailboxSelect?.(mailboxId)}
        isCollapsed={isCollapsed}
        testRole="scheduled"
        testName="scheduled"
        testMailboxId={mailboxId}
      />
    );
  };

  // The "Your folders" section: the user's own top-level folders, under a
  // heading of their own that collapses and offers to make a new one.
  const renderCustomFolders = (
    key: string,
    tree: MailboxNode[],
    {
      sub = false,
      selected,
      onSelect,
      active = true,
      dragAccountId,
    }: {
      sub?: boolean;
      selected: string;
      onSelect?: (mailboxId: string) => void;
      active?: boolean;
      dragAccountId?: string | null;
    },
  ) => {
    if (tree.length === 0) return null;
    const expanded = !collapsedCustomFolders.has(key);
    return (
      // A Pro account group already carries the folders menu for the whole group.
      <div data-testid="section-your-folders" onContextMenu={active && !sub ? handleFoldersHeaderContextMenu : undefined}>
        <SidebarSectionHeader
          label={t("your_folders")}
          expanded={expanded}
          onToggle={() => toggleCustomFolders(key)}
          onAdd={active && onCreateFolder ? () => onCreateFolder() : undefined}
          addTitle={t("create_folder")}
          isCollapsed={isCollapsed}
          sub={sub}
          testId={`section-your-folders-header-${key}`}
        />
        {((expanded && !isCollapsed) || isCollapsed) && tree.map((node) => (
          <MailboxTreeItem
            key={node.id}
            node={node}
            selectedMailbox={selected}
            expandedFolders={expandedFolders}
            onMailboxSelect={onSelect}
            onToggleExpand={handleToggleExpand}
            isCollapsed={isCollapsed}
            colorful={colorfulSidebarIcons}
            onContextMenu={active ? handleMailboxContextMenu : undefined}
            dragAccountId={dragAccountId}
            initials={tree.length > 1}
          />
        ))}
      </div>
    );
  };

  // The Shared section: the group and delegated mailboxes a login can reach.
  // With several logins in the Pro sidebar each one gets its own, inside its
  // group (#1486). Only the active login's has menus, its Scheduled rows
  // and its shared tags, as with the folders of the other logins.
  const renderSharedSection = (
    accounts: MailboxNode[],
    {
      sub = false,
      expanded,
      onToggle,
      selected,
      onSelect,
      active = true,
    }: {
      sub?: boolean;
      expanded: boolean;
      onToggle: () => void;
      selected: string;
      onSelect?: (mailboxId: string) => void;
      active?: boolean;
    },
  ) => {
    if (accounts.length === 0) return null;
    return (
      <div data-testid={sub ? "section-shared-in-account" : undefined}>
        <SidebarSectionHeader
          label={t("shared")}
          expanded={expanded}
          onToggle={onToggle}
          isCollapsed={isCollapsed}
          sub={sub}
          testId="section-shared"
        />
        {((expanded && !isCollapsed) || isCollapsed) && (
          <>
            {accounts.map((account) => {
              const accountExpanded = expandedSharedAccounts.has(account.id);
              const menuAccountId = sharedAccountMenuId(account.accountId);
              const compact = compactSharedMailboxes ? compactSharedMailbox(account) : null;
              if (compact) {
                // A row without folders below it has no chevron, so what
                // else hangs below it (Scheduled, tags) stays shown.
                const compactExpanded = !isCollapsed
                  && (expandedFolders.has(compact.id) || compact.children.length === 0);
                const scheduledCount = active && menuAccountId ? (scheduledTotalByAccount?.[menuAccountId] ?? 0) : 0;
                const scheduledRow = () => scheduledCount > 0
                  && renderScheduledRow(`${account.id}-scheduled`, { accountId: menuAccountId, depth: 1 });
                // Scheduled goes after Drafts, as under a header row; with
                // Drafts left out (empty), after the other folders.
                const hasDrafts = compact.children.some((child) => child.role === 'drafts');
                // "Mark subfolders read" covers the inbox's own subfolders
                // only, not the account's folders listed below the row.
                const inboxHasSubfolders = (account.children.find((child) => child.id === compact.id)?.children.length ?? 0) > 0;
                return (
                  <div key={account.id} data-testid="compact-shared-mailbox">
                    <MailboxTreeItem
                      node={compact}
                      sharedAccountName={account.name}
                      selectedMailbox={selected}
                      expandedFolders={expandedFolders}
                      onMailboxSelect={onSelect}
                      onToggleExpand={handleToggleExpand}
                      isCollapsed={isCollapsed}
                      colorful={colorfulSidebarIcons}
                      onContextMenu={active ? (e, node) => handleCompactSharedContextMenu(e, node, compact.id, menuAccountId, inboxHasSubfolders) : undefined}
                      pickOnly={!active}
                      renderAfterChild={(child) => child.role === 'drafts' && scheduledRow()}
                    />
                    {compactExpanded && !hasDrafts && scheduledRow()}
                    {active && compactExpanded && menuAccountId && activeAccountId && (
                      <SharedAccountTags
                        loginId={activeAccountId}
                        accountId={menuAccountId}
                        selectedKeyword={selectedKeywordAccountId === menuAccountId ? selectedKeyword : null}
                        expandedTags={expandedTags}
                        onTagSelect={onTagSelect}
                        onToggleExpand={handleToggleTagExpand}
                        colorful={colorfulSidebarIcons}
                      />
                    )}
                  </div>
                );
              }
              if (isCollapsed) {
                // Folded, a shared account is one item: its inbox opens, or
                // without one the drawer with the account unfolded. It was
                // left out, and only its heading's rule stayed behind.
                const inbox = account.children.find((child) => child.role === 'inbox');
                const selectedHere = !!selected && subtreeHas(account, selected);
                return (
                  <SidebarRow
                    key={account.id}
                    icon={<User className={getIconClass(selectedHere, false, false)} />}
                    label={account.name}
                    isSelected={selectedHere}
                    unread={subtreeUnread(account)}
                    onClick={() => {
                      if (inbox) { onSelect?.(inbox.id); return; }
                      if (!expanded) onToggle();
                      if (!accountExpanded) toggleSharedAccount(account.id);
                      setRailOpen(true);
                    }}
                    isCollapsed
                    testShared
                    railKey={account.id}
                  />
                );
              }
              return (
                <div key={account.id}>
                  <SidebarSectionHeader
                    label={account.name}
                    expanded={accountExpanded}
                    onToggle={() => toggleSharedAccount(account.id)}
                    isCollapsed={isCollapsed}
                    sub
                    icon={<User className="w-3.5 h-3.5 text-muted-foreground" />}
                    testId="section-shared-account"
                    railKey={account.id}
                    onContextMenu={active && menuAccountId
                      ? (e) => handleSharedAccountContextMenu(e, menuAccountId)
                      : undefined}
                  />
                  {accountExpanded && !isCollapsed && (
                    <>
                      {account.children.map((child) => (
                        <Fragment key={child.id}>
                          <MailboxTreeItem
                            node={child}
                            selectedMailbox={selected}
                            expandedFolders={expandedFolders}
                            onMailboxSelect={onSelect}
                            onToggleExpand={handleToggleExpand}
                            isCollapsed={isCollapsed}
                            colorful={colorfulSidebarIcons}
                            onContextMenu={active ? handleMailboxContextMenu : undefined}
                            pickOnly={!active}
                          />
                          {active && child.role === 'drafts' && menuAccountId
                            && renderScheduledRow(`${account.id}-scheduled`, { accountId: menuAccountId })}
                        </Fragment>
                      ))}
                      {active && menuAccountId && !account.children.some((child) => child.role === 'drafts')
                        && renderScheduledRow(`${account.id}-scheduled`, { accountId: menuAccountId })}
                      {active && menuAccountId && activeAccountId && (
                        <SharedAccountTags
                          loginId={activeAccountId}
                          accountId={menuAccountId}
                          selectedKeyword={selectedKeywordAccountId === menuAccountId ? selectedKeyword : null}
                          expandedTags={expandedTags}
                          onTagSelect={onTagSelect}
                          onToggleExpand={handleToggleTagExpand}
                          colorful={colorfulSidebarIcons}
                        />
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  };

  // The Tags section. It follows the shared mailboxes unless the admin policy
  // lists it above them, so a long list of shared mailboxes does not push the
  // tags out of sight.
  const renderTags = () => {
    if (!(showSecondary || mvFlat) || emailKeywords.length === 0) return null;
    return (
      <div data-tour="keyword-tags">
        {/* Under Mountain View the tags continue the "Labels" list. */}
        {!mvFlat && (
          <SidebarSectionHeader
            label={t("tags")}
            expanded={tagsExpanded}
            onToggle={toggleTags}
            onSettings={openKeywordSettings}
            settingsTitle={t('settings')}
            isCollapsed={isCollapsed}
          />
        )}
        {((tagsExpanded && !isCollapsed) || isCollapsed || mvFlat) && (
          <>
            {visibleTagTree.map((node) => (
              <TagItem
                key={node.id}
                node={node}
                selectedKeyword={personalSelectedKeyword}
                expandedTags={expandedTags}
                isCollapsed={isCollapsed}
                onTagSelect={onTagSelect}
                onToggleExpand={handleToggleTagExpand}
                tagCounts={tagCounts}
                colorful={colorfulSidebarIcons}
              />
            ))}
            {(hiddenTagCount > 0 || showAllTags) && (
              <ShowAllTagsRow
                hiddenCount={hiddenTagCount}
                showAll={showAllTags}
                onToggle={() => setShowAllTags((prev) => !prev)}
                isCollapsed={isCollapsed}
              />
            )}
          </>
        )}
      </div>
    );
  };

  const getUnifiedIcon = (role: UnifiedMailboxRole) => {
    switch (role) {
      case 'inbox': return Inbox;
      case 'sent': return Send;
      case 'drafts': return File;
      case 'trash': return Trash2;
      case 'archive': return Archive;
      case 'junk': return Ban;
      default: return Folder;
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't hijack Arrow keys while the user is typing. This is a global
      // window listener, so without this guard typing in a new email (the
      // contentEditable composer, the subject field, search, etc.) toggled the
      // selected mailbox's subfolders open/closed on ArrowLeft/ArrowRight.
      // composedPath-based so it also sees the QuotedHtml shadow island (#654).
      if (isAppShortcutBlocked(e)) return;
      // Only in the folder list: elsewhere the arrows belong to the message
      // list, the reading pane or whatever has the focus.
      if (!isEventInside(e, "[data-folder-nav]")) return;
      if (!selectedMailbox || isCollapsed) return;

      const findNode = (nodes: MailboxNode[]): MailboxNode | null => {
        for (const node of nodes) {
          if (node.id === selectedMailbox) return node;
          const found = findNode(node.children);
          if (found) return found;
        }
        return null;
      };

      const selectedNode = findNode(mailboxTree);
      if (!selectedNode) return;

      if (e.key === 'ArrowRight' && selectedNode.children.length > 0) {
        if (!expandedFolders.has(selectedMailbox)) {
          handleToggleExpand(selectedMailbox);
        }
      } else if (e.key === 'ArrowLeft' && selectedNode.children.length > 0) {
        if (expandedFolders.has(selectedMailbox)) {
          handleToggleExpand(selectedMailbox);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedMailbox, isCollapsed, expandedFolders, mailboxTree]);

  const toggleUnified = () => {
    setUnifiedExpanded((prev: boolean) => {
      const next = !prev;
      try { localStorage.setItem('sidebarUnifiedExpanded', JSON.stringify(next)); } catch { /* */ }
      return next;
    });
  };
  const toggleFolders = () => {
    setFoldersExpanded((prev: boolean) => {
      const next = !prev;
      try { localStorage.setItem('sidebarFoldersExpanded', JSON.stringify(next)); } catch { /* */ }
      return next;
    });
  };
  const toggleTags = () => {
    setTagsExpanded((prev: boolean) => {
      const next = !prev;
      try { localStorage.setItem('sidebarTagsExpanded', JSON.stringify(next)); } catch { /* */ }
      return next;
    });
  };
  const toggleShared = () => {
    setSharedExpanded((prev: boolean) => {
      const next = !prev;
      try { localStorage.setItem('sidebarSharedExpanded', JSON.stringify(next)); } catch { /* */ }
      return next;
    });
  };
  const toggleSharedAccount = (id: string) => {
    setExpandedSharedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('sidebarExpandedSharedAccounts', JSON.stringify(Array.from(next))); } catch { /* */ }
      return next;
    });
  };
  const toggleAccountGroup = (id: string) => {
    setCollapsedAccountGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem('sidebarCollapsedAccountGroups', JSON.stringify(Array.from(next))); } catch { /* */ }
      return next;
    });
  };
  const toggleCustomFolders = (key: string) => {
    setCollapsedCustomFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem('sidebarCollapsedCustomFolders', JSON.stringify(Array.from(next))); } catch { /* */ }
      return next;
    });
  };

  // The tab now travels in the URL (#733) rather than through sessionStorage,
  // so a gear click is a link the user can also bookmark or share. It still
  // steers only this one open - the persisted default is written on tab click.
  const openFolderSettings = () => { router.push(buildSettingsPath('organize', 'folders')); };
  const openKeywordSettings = () => { router.push(buildSettingsPath('organize', 'tags')); };

  const {
    contextMenu: mailboxContextMenu,
    openContextMenu: openMailboxContextMenu,
    closeContextMenu: closeMailboxContextMenu,
    menuRef: mailboxMenuRef,
  } = useContextMenu<MailboxContextTarget>();

  const handleMailboxContextMenu = (e: React.MouseEvent, node: MailboxNode) => {
    const mailbox = mailboxes.find(mb => mb.id === node.id);
    if (!mailbox) return;
    openMailboxContextMenu(e, { kind: "mailbox", mailbox, hasChildren: node.children.length > 0 });
  };

  const handleFoldersHeaderContextMenu = (e: React.MouseEvent) => {
    openMailboxContextMenu(e, { kind: "folders-section" });
  };

  // `buildMailboxTree()` groups shared mailboxes that carry no accountId under
  // the placeholder id "unknown" (lib/utils.ts). Such a node cannot be a valid
  // JMAP mutation target, so it gets no folder-creation menu at all rather than
  // a menu that would create the folder in a non-existent account.
  const sharedAccountMenuId = (accountId?: string) =>
    accountId && accountId !== "unknown" ? accountId : undefined;

  const handleSharedAccountContextMenu = (e: React.MouseEvent, accountId: string) => {
    openMailboxContextMenu(e, { kind: "folders-section", accountId });
  };

  // A compact shared mailbox's row is its inbox and stands for the account, so
  // its menu is the inbox's plus what the account's header row offered.
  const handleCompactSharedContextMenu = (
    e: React.MouseEvent,
    node: MailboxNode,
    inboxId: string,
    accountId: string | undefined,
    inboxHasSubfolders: boolean,
  ) => {
    const mailbox = mailboxes.find(mb => mb.id === node.id);
    if (!mailbox) return;
    const isRow = node.id === inboxId;
    openMailboxContextMenu(e, {
      kind: "mailbox",
      mailbox,
      hasChildren: isRow ? inboxHasSubfolders : node.children.length > 0,
      sharedAccountId: isRow ? accountId : undefined,
    });
  };

  const hideSharedAccount = activeAccountId
    ? (accountId: string) => {
        const { hiddenSharedMailAccounts: hidden, updateSetting } = useSettingsStore.getState();
        updateSetting('hiddenSharedMailAccounts', setSharedMailAccountHidden(hidden, activeAccountId, accountId, true));
        toast.info(t("shared_account_hidden"));
      }
    : undefined;

  // Muting only takes effect through the server's emailPush filter, so the
  // menu offers it only where that exists, like the "Inbox only" setting.
  const authClient = useAuthStore((s) => s.client);
  const notificationMutes = useSettingsStore((s) => s.notificationMutes);
  const notificationActions = useMemo<MailboxNotificationActions | undefined>(() => {
    if (!authClient || !serverSupportsEmailPush(authClient)) return undefined;
    const accountOf = (accountId?: string) => accountId || authClient.getAccountId();
    const mailboxRef = (mailbox: Mailbox) => [accountOf(mailbox.accountId), mailbox.originalId || mailbox.id] as const;
    const save = (next: NotificationMutes) => useSettingsStore.getState().updateSetting('notificationMutes', next);
    return {
      isMailboxMuted: (mailbox) => isMailboxMuted(notificationMutes, ...mailboxRef(mailbox)),
      isAccountMuted: (accountId) => isAccountMuted(notificationMutes, accountOf(accountId)),
      hasFolderSettings: (accountId) => {
        const { muted, unmuted } = mailboxOverridesForAccount(notificationMutes, accountOf(accountId));
        return muted.length + unmuted.length > 0;
      },
      setMailboxMuted: (mailbox, muted) => save(setMailboxMuted(notificationMutes, ...mailboxRef(mailbox), muted)),
      setAccountMuted: (accountId, muted) => save(setAccountMuted(notificationMutes, accountOf(accountId), muted)),
      resetFolderSettings: (accountId) => save(resetMailboxMutes(notificationMutes, accountOf(accountId))),
    };
  }, [authClient, notificationMutes]);

  return (
    <div
      ref={rootRef}
      // The peek of the collapsed rail; not with hover opening turned off.
      onMouseEnter={sidebarCollapsed && !isDrawer ? armRailHover : undefined}
      onMouseMove={sidebarCollapsed && !isDrawer && !mvShell && !railHovered ? armRailHover : undefined}
      onMouseLeave={sidebarCollapsed && !isDrawer ? () => {
        if (railHoverTimer.current) clearTimeout(railHoverTimer.current);
        railHoverTimer.current = null;
        setRailHovered(false);
      } : undefined}
      onKeyDown={railOpen || railHovered ? (e) => {
        // Opened from All folders, the drawer keeps the focus until it closes.
        if (e.key === 'Tab' && railOpen && !mvShell) {
          trapTab(e, rootRef.current);
          return;
        }
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        const hadFocus = rootRef.current?.contains(document.activeElement);
        closeRailPeek();
        if (hadFocus) requestAnimationFrame(() => allFoldersRef.current?.focus());
      } : undefined}
      onBlur={railOpen ? (e) => {
        const next = e.relatedTarget as Node | null;
        if (next && !e.currentTarget.contains(next)) closeRailPeek();
      } : undefined}
      data-mv-rail-peek={hoverExpanded && mvShell ? "" : undefined}
      data-folder-peek={isFolderDrawer ? "" : undefined}
      data-folder-drawer={isFolderDrawer ? "" : undefined}
      data-window-drawer={isFolderDrawer && !isEmbedded ? "" : undefined}
      className={cn(
        "relative flex flex-col h-full border-e transition-all duration-300 overflow-hidden",
        // Mountain View's navigation sits on the canvas, with no rule between
        // it and the content card.
        mvShell ? "bg-[var(--mv-canvas)] border-transparent" : "bg-secondary border-border",
        "max-desk:w-full",
        // Mountain View's collapsed column is 72px (--mv-rail-w), wide enough
        // for its round compose button; the default layout's rail is 48px.
        isCollapsed && !mvShell ? "desk:w-12" : isFolderDrawer ? "desk:w-72" : "desk:w-full",
        // Floats out of the rail's own column rather than widening it, so the
        // message list underneath never moves while the pointer passes over.
        // Width comes from --mv-rail-peek-w, keyed on data-mv-rail-peek.
        hoverExpanded && mvShell && "desk:absolute desk:inset-y-0 desk:start-0 desk:z-40 desk:shadow-xl",
        // The drawer: at the window's start edge, from under the top bar
        // (--drawer-top, and [data-window-drawer] for the window's controls)
        // to the bottom; in a Pro pane, at
        // the pane's. At its full width at once: grown from the folded
        // column's 48px at the edge, it would leave the pointer that opened it
        // outside, which closes it again.
        isFolderDrawer && "transition-none shadow-xl z-50",
        isFolderDrawer && (isEmbedded ? "absolute inset-y-0 start-0" : "fixed start-0 bottom-0 top-[var(--drawer-top)] h-auto"),
        className
      )}
    >
      {/* Header - hidden in the Pro shell, which owns its own chrome and
          would otherwise render an empty strip (no collapse, no switcher). */}
      {!isEmbedded && !mvShell && (
        // Border lives on the wrapper (outside the h-14 box) so the bar's total
        // height matches the search/reply toolbars, which border-b their wrapper too.
        <div className="border-b border-border" data-sidebar-head="">
          <div className={cn("flex items-center h-14", isCollapsed ? "justify-center px-2" : "gap-1 px-2")}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onSidebarClose}
              className={cn("desk:hidden h-9 w-9 flex-shrink-0", SIDEBAR_HEAD_BUTTON)}
              aria-label={t("close")}
            >
              <X className="w-5 h-5" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              // In the drawer it closes the drawer, as the phone's X does;
              // docking the folders is the folded column's expand button.
              onClick={isFolderDrawer ? closeRailPeek : toggleSidebarCollapsed}
              className={cn("hidden desk:flex h-8 w-8 flex-shrink-0", SIDEBAR_HEAD_BUTTON)}
              data-testid="sidebar-collapse"
              title={isCollapsed ? t("expand_tooltip") : t("collapse_tooltip")}
            >
              {/* The arrows point the way the column goes; the app's global RTL mirror turns them in RTL. */}
              {isCollapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
            </Button>

            {/* The account switcher heads the folders by default, with
                Compose under it on a desktop, as in Gmail and Outlook: a
                round button over the list covered the rows under it while
                scrolling (mail-13, mail-p3-11). With the setting off a
                desktop puts Compose here instead, and the rail's avatar is
                the one account switcher (usability test 2026-11-04,
                mail-27); phones keep the round button, since this pane is a
                drawer there. */}
            {!isCollapsed && sidebarAccountSwitcher && (
              <AccountSwitcher variant="expanded" className="flex-1" />
            )}
            {!isCollapsed && !sidebarAccountSwitcher && !isDrawer && onCompose && (
              <Button
                onClick={onCompose}
                className="flex-1 min-w-0 h-9 justify-start gap-2 px-3"
                data-sidebar-compose=""
                data-tour="compose-button"
                title={t("compose_hint")}
              >
                <PenSquare className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">{t("compose")}</span>
              </Button>
            )}
          </div>
          {!isCollapsed && sidebarAccountSwitcher && !isDrawer && onCompose && (
            <div className="px-2 pb-2">
              <Button
                onClick={onCompose}
                className="w-full min-w-0 h-9 justify-start gap-2 px-3"
                data-sidebar-compose=""
                data-tour="compose-button"
                title={t("compose_hint")}
              >
                <PenSquare className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">{t("compose")}</span>
              </Button>
            </div>
          )}
          {isCollapsed && !isDrawer && onCompose && (
            <div className="flex justify-center pb-2">
              <IconButton
                onClick={onCompose}
                variant="default"
                data-sidebar-compose=""
                data-tour="compose-button"
                label={t("compose")}
                title={t("compose_hint")}
              >
                <PenSquare />
              </IconButton>
            </div>
          )}
        </div>
      )}

      {mvShell && onCompose && (
        <div className={cn("pt-2 pb-3", isCollapsed ? "px-2" : "px-3")}>
          <button
            type="button"
            onClick={onCompose}
            data-mv-compose=""
            data-tour="compose-button"
            className={cn(
              "flex items-center bg-[var(--mv-compose-bg)] text-[var(--mv-compose-fg)] hover:shadow-md transition-shadow",
              isCollapsed ? "w-14 justify-center" : "max-w-full gap-[min(0.75rem,12px)] ps-[min(1rem,16px)] pe-[min(1.5rem,24px)]"
            )}
            title={t("compose_hint")}
            aria-label={t("compose")}
          >
            <Pencil className="w-6 h-6 flex-shrink-0" />
            {!isCollapsed && <span className="min-w-0 truncate text-sm font-medium">{t("compose")}</span>}
          </button>
        </div>
      )}

      {/* No rule under it on Mountain View's canvas, which has none. */}
      {!isCollapsed && <DemoBanner ruled={!mvShell} />}
      {!isCollapsed && <VacationBanner />}

      {/* Mailbox List */}
      <nav
        ref={navRef}
        aria-label={t("folders")}
        // Folded, the column scrolls on its own, never sideways, with a thin
        // scrollbar (globals.css) and the same gutter on both sides so the
        // icons stay centred under the buttons above and below it.
        className={cn("flex-1 min-h-0 overflow-y-auto", isCollapsed && "overflow-x-hidden py-1 [scrollbar-gutter:stable_both-edges]")}
        data-tour="sidebar"
        data-folder-nav=""
        data-folder-rail={isCollapsed && !mvShell ? "" : undefined}
        data-pane="folders"
        onKeyDown={isCollapsed ? moveInRail : undefined}
      >
        {unifiedSectionShown && (
          <div>
            <SidebarSectionHeader
              label={t(crossAccountActive ? "all_accounts" : "unified_mailbox")}
              expanded={unifiedExpanded}
              onToggle={toggleUnified}
              isCollapsed={isCollapsed}
              first
              status={unifiedProgress && (
                <span
                  className="ms-2 text-xs font-normal tabular-nums text-muted-foreground animate-pulse"
                  title={t("all_accounts_loading", unifiedProgress)}
                  data-testid="unified-accounts-loading"
                >
                  <span aria-hidden="true">{unifiedProgress.loaded}/{unifiedProgress.total}</span>
                  <span className="sr-only">{t("all_accounts_loading", unifiedProgress)}</span>
                </span>
              )}
            />
            {((unifiedExpanded && !isCollapsed) || isCollapsed) && (
              <>
                {showUnified && unifiedCounts.map((count) => {
                  const unifiedId = UNIFIED_MAILBOX_IDS[count.role];
                  const Icon = getUnifiedIcon(count.role);
                  const isSelected = !selectedKeyword && selectedMailbox === unifiedId;
                  return (
                    <SidebarRow
                      key={unifiedId}
                      icon={<Icon className={getIconClass(isSelected, false, colorfulSidebarIcons, count.role)} />}
                      label={t(`unified_${count.role}`)}
                      testRole={count.role}
                      testName={`unified-${count.role}`}
                      testMailboxId={unifiedId}
                      depth={0}
                      isSelected={isSelected}
                      unread={count.unreadEmails}
                      total={count.totalEmails}
                      onClick={() => onMailboxSelect?.(unifiedId)}
                      isCollapsed={isCollapsed}
                    />
                  );
                })}
                {[
                  { show: showCrossUnread, id: CROSS_VIEW_IDS.unread, Icon: MailOpen, label: t('unified_all_unread'), unread: crossUnreadCount },
                  { show: showCrossStarred, id: CROSS_VIEW_IDS.starred, Icon: Star, label: t('unified_all_starred'), unread: undefined as number | undefined },
                  { show: showCrossAll, id: CROSS_VIEW_IDS.all, Icon: Mails, label: t('unified_all_mail'), unread: crossUnreadCount },
                ].map(({ show, id, Icon, label, unread }) => {
                  if (!show) return null;
                  const isSelected = !selectedKeyword && selectedMailbox === id;
                  return (
                    <SidebarRow
                      key={id}
                      icon={<Icon className={getIconClass(isSelected, false, colorfulSidebarIcons)} />}
                      label={label}
                      testName={id}
                      testMailboxId={id}
                      depth={0}
                      isSelected={isSelected}
                      unread={unread}
                      onClick={() => onMailboxSelect?.(id)}
                      isCollapsed={isCollapsed}
                    />
                  );
                })}
              </>
            )}
          </div>
        )}

        {useMultiAccount ? (
          accountGroups.map(({ account, isActive, tree, shared }) => {
            const expanded = !collapsedAccountGroups.has(account.id);
            const isViewing = isActive ? viewingAccountId === null : viewingAccountId === account.id;
            return (
              <div key={account.id} onContextMenu={isActive ? handleFoldersHeaderContextMenu : undefined}>
                <SidebarSectionHeader
                  label={toUnicodeEmail(account.label || account.email || account.username)}
                  expanded={expanded}
                  onToggle={() => toggleAccountGroup(account.id)}
                  onSettings={isActive ? openFolderSettings : undefined}
                  settingsTitle={isActive ? t('settings') : undefined}
                  isCollapsed={isCollapsed}
                  first={!showUnified && account.id === connectedAccounts[0]?.id}
                  icon={<User className="w-3.5 h-3.5 text-muted-foreground" />}
                />
                {((expanded && !isCollapsed) || isCollapsed) && (
                  <>
                    {tree.length === 0 ? (
                      // The page skeleton's folder rows, so nothing moves when the
                      // folders arrive (components/boot-skeleton).
                      <div data-testid="folders-loading">
                        <span className="sr-only">{t("loading_mailboxes")}</span>
                        {!isCollapsed && <FolderRowsSkeleton />}
                      </div>
                    ) : (
                      <>
                        {tree.filter(isSystemFolder).map((node) => (
                          <Fragment key={node.id}>
                            <MailboxTreeItem
                              node={node}
                              selectedMailbox={selectedKeyword || !isViewing ? "" : selectedMailbox}
                              expandedFolders={expandedFolders}
                              onMailboxSelect={(mailboxId) =>
                                onAccountMailboxSelect?.(isActive ? null : account.id, mailboxId)
                              }
                              onToggleExpand={handleToggleExpand}
                              isCollapsed={isCollapsed}
                              colorful={colorfulSidebarIcons}
                              onContextMenu={isActive ? handleMailboxContextMenu : undefined}
                              dragAccountId={isActive ? null : account.id}
                            />
                            {isActive && node.role === 'drafts' && renderScheduledRow(`scheduled-${account.id}`)}
                          </Fragment>
                        ))}
                        {isActive && !tree.some((node) => node.role === 'drafts') && renderScheduledRow(`scheduled-${account.id}`)}
                        {renderCustomFolders(account.id, tree.filter((node) => !isSystemFolder(node)), {
                          sub: true,
                          selected: selectedKeyword || !isViewing ? "" : selectedMailbox,
                          onSelect: (mailboxId) => onAccountMailboxSelect?.(isActive ? null : account.id, mailboxId),
                          active: isActive,
                          dragAccountId: isActive ? null : account.id,
                        })}
                        {renderSharedSection(shared, {
                          sub: true,
                          expanded: !collapsedCustomFolders.has(`${SHARED_KEY_PREFIX}${account.id}`),
                          onToggle: () => toggleCustomFolders(`${SHARED_KEY_PREFIX}${account.id}`),
                          // Another login's shared mailbox is opened by switching to that login.
                          selected: selectedKeyword || !isViewing || !isActive ? "" : selectedMailbox,
                          onSelect: isActive
                            ? (mailboxId) => onAccountMailboxSelect?.(null, mailboxId)
                            : (mailboxId) => onLoginSharedMailboxSelect?.(account.id, mailboxId),
                          active: isActive,
                        })}
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })
        ) : (
          <div onContextMenu={handleFoldersHeaderContextMenu}>
            {!mvFoldersHeadless && (
              <SidebarSectionHeader
                label={t("folders")}
                expanded={foldersExpanded}
                onToggle={toggleFolders}
                onSettings={openFolderSettings}
                settingsTitle={t('settings')}
                isCollapsed={isCollapsed}
                first={!unifiedSectionShown}
              />
            )}
            {(mvFoldersHeadless || (foldersExpanded && !isCollapsed) || isCollapsed) && (
              <>
                {mailboxes.length === 0 ? (
                  // The page skeleton's folder rows, so nothing moves when the
                  // folders arrive (components/boot-skeleton).
                  <div data-testid="folders-loading">
                    <span className="sr-only">{t("loading_mailboxes")}</span>
                    {!isCollapsed && <FolderRowsSkeleton />}
                  </div>
                ) : (
                  <>
                    {primaryTree.map((node) => (
                      <Fragment key={node.id}>
                        <MailboxTreeItem
                          node={node}
                          selectedMailbox={selectedKeyword ? "" : selectedMailbox}
                          expandedFolders={expandedFolders}
                          onMailboxSelect={onMailboxSelect}
                          onToggleExpand={handleToggleExpand}
                          isCollapsed={isCollapsed}
                          colorful={colorfulSidebarIcons}
                          onContextMenu={handleMailboxContextMenu}
                        />
                        {node.role === 'drafts' && renderScheduledRow('scheduled')}
                        {/* Mountain View lists Starred right under the Inbox. */}
                        {mvFlat && node.role === 'inbox' && onOpenStarred && (
                          <SidebarRow
                            // Drawn like the "All starred" row it stands in for.
                            icon={<Star className={getIconClass(!selectedKeyword && selectedMailbox === CROSS_VIEW_IDS.starred, false, colorfulSidebarIcons)} />}
                            label={t("mailboxes.starred")}
                            testName="mv-starred"
                            depth={0}
                            isSelected={!selectedKeyword && selectedMailbox === CROSS_VIEW_IDS.starred}
                            onClick={onOpenStarred}
                            isCollapsed={false}
                          />
                        )}
                      </Fragment>
                    ))}
                    {!primaryTree.some((node) => node.role === 'drafts') && renderScheduledRow('scheduled')}
                    {mvFlat && (
                      <SidebarRow
                        icon={moreExpanded
                          ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                          : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                        label={moreExpanded ? t("show_fewer") : t("show_more")}
                        testName="mv-more"
                        depth={0}
                        isSelected={false}
                        onClick={() => setMoreExpanded((prev) => !prev)}
                        isCollapsed={false}
                      />
                    )}
                    {mvFlat && moreExpanded && moreTree.map((node) => (
                      <MailboxTreeItem
                        key={node.id}
                        node={node}
                        selectedMailbox={selectedKeyword ? "" : selectedMailbox}
                        expandedFolders={expandedFolders}
                        onMailboxSelect={onMailboxSelect}
                        onToggleExpand={handleToggleExpand}
                        isCollapsed={isCollapsed}
                        colorful={colorfulSidebarIcons}
                        onContextMenu={handleMailboxContextMenu}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {!useMultiAccount && renderCustomFolders(OWN_FOLDERS_KEY, customTree, {
          selected: selectedKeyword ? "" : selectedMailbox,
          onSelect: onMailboxSelect,
        })}

        {mvFlat && !useMultiAccount && (
          <div data-mv-labels="">
            <div className="flex items-center justify-between ps-[26px] pe-3 pt-4 pb-1">
              <span className="text-base font-medium text-foreground">{t("labels")}</span>
              {onCreateFolder && (
                <button
                  type="button"
                  onClick={() => onCreateFolder()}
                  className="grid place-items-center w-8 h-8 rounded-full text-foreground hover:bg-[var(--mv-nav-hover)] transition-colors"
                  title={t("create_label")}
                  aria-label={t("create_label")}
                >
                  <Plus className="w-5 h-5" />
                </button>
              )}
            </div>
            {labelTree.map((node) => (
              <MailboxTreeItem
                key={node.id}
                node={node}
                selectedMailbox={selectedKeyword ? "" : selectedMailbox}
                expandedFolders={expandedFolders}
                onMailboxSelect={onMailboxSelect}
                onToggleExpand={handleToggleExpand}
                isCollapsed={isCollapsed}
                colorful={colorfulSidebarIcons}
                onContextMenu={handleMailboxContextMenu}
              />
            ))}
          </div>
        )}

        {tagsAboveShared && renderTags()}

        {!useMultiAccount && showSecondary && renderSharedSection(sharedAccounts, {
          expanded: sharedExpanded,
          onToggle: toggleShared,
          selected: selectedKeyword ? "" : selectedMailbox,
          onSelect: onMailboxSelect,
        })}

        {!tagsAboveShared && renderTags()}

        {!isCollapsed && <PluginSidebarSections mailboxId={selectedKeyword ? null : selectedMailbox || null} />}
        {!isCollapsed && <PluginSlot name="sidebar-widget" className="border-t border-border" />}
      </nav>

      {/* Folded: the whole tree, subfolders included, one click away (p2-9). */}
      {isCollapsed && !mvShell && (
        <div className="flex justify-center border-t border-border py-2">
          <IconButton
            ref={allFoldersRef}
            label={tP2("all_folders")}
            data-testid="folded-all-folders"
            onClick={() => setRailOpen(true)}
          >
            <FolderSync />
          </IconButton>
        </div>
      )}

      <MailboxContextMenu
        target={mailboxContextMenu.data}
        position={mailboxContextMenu.position}
        isOpen={mailboxContextMenu.isOpen}
        onClose={closeMailboxContextMenu}
        menuRef={mailboxMenuRef}
        mailboxes={mailboxes}
        onMarkFolderRead={onMarkFolderRead}
        onMarkFolderTreeRead={onMarkFolderTreeRead}
        onMarkAllFoldersRead={onMarkAllFoldersRead}
        onEmptyFolder={onEmptyFolder}
        onCreateSubfolder={onCreateSubfolder}
        onCreateFolder={onCreateFolder}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
        onShareFolder={onShareFolder}
        onImportEmail={onImportEmail}
        onRefresh={onRefreshMailboxes}
        onHideSharedAccount={hideSharedAccount}
        notifications={notificationActions}
      />
    </div>
  );
}

/**
 * The mail sidebar, re-rendered only when one of its props changes. The mail
 * view renders on every open and every list update; without this each of
 * those rendered the whole folder tree again. Its handlers come from
 * useStableHandlers in the mail view, so they keep their identity.
 */
export const Sidebar = memo(SidebarImpl);
