"use client";

import { useState, useEffect, useMemo, ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { Button } from "@/components/ui/button";
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
  Folder,
  FolderOpen,
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
  CalendarClock,
  BellOff,
  Mails,
  MailOpen,
} from "lucide-react";
import { cn, buildMailboxTree, MailboxNode } from "@/lib/utils";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { Mailbox } from "@/lib/jmap/types";
import { useContextMenu } from "@/hooks/use-context-menu";
import { MailboxContextMenu, type MailboxContextTarget } from "./mailbox-context-menu";
import { useAccountStore } from '@/stores/account-store';
import { UNIFIED_MAILBOX_IDS, CROSS_VIEW_IDS } from '@/lib/jmap/types';
import type { UnifiedMailboxRole } from '@/lib/jmap/types';
import { useDragDropContext } from "@/contexts/drag-drop-context";
import { useMailboxDrop } from "@/hooks/use-mailbox-drop";
import { useTagDrop } from "@/hooks/use-tag-drop";
import { useUIStore } from "@/stores/ui-store";
import { useAuthStore } from "@/stores/auth-store";
import { useVacationStore } from "@/stores/vacation-store";
import { useSettingsStore, KEYWORD_PALETTE, KeywordDefinition } from "@/stores/settings-store";
import { useEmailStore } from "@/stores/email-store";
import { toast } from "@/stores/toast-store";
import { debug } from "@/lib/debug";
import { AccountSwitcher } from "./account-switcher";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useTour } from "@/components/tour/tour-provider";

interface SidebarProps {
  mailboxes: Mailbox[];
  selectedMailbox?: string;
  selectedKeyword?: string | null;
  onMailboxSelect?: (mailboxId: string) => void;
  onTagSelect?: (keywordId: string | null) => void;
  onCompose?: () => void;
  onSidebarClose?: () => void;
  onUnreadFilterClick?: (mailboxId: string) => void;
  onMarkFolderRead?: (mailboxId: string) => void;
  onMarkFolderTreeRead?: (mailboxId: string) => void;
  onMarkAllFoldersRead?: () => void;
  onEmptyFolder?: (mailboxId: string) => void;
  onCreateSubfolder?: (parentId: string) => void;
  onCreateFolder?: () => void;
  onRenameFolder?: (mailboxId: string) => void;
  onDeleteFolder?: (mailboxId: string) => void;
  onImportEmail?: (mailboxId: string) => void;
  onRefreshMailboxes?: () => void;
  scheduledTotal?: number;
  showScheduledMailbox?: boolean;
  /** Gated "All Mail" virtual folder that merges all of the account's folders. */
  showAllMailMailbox?: boolean;
  /** Gated cross-account views in the "All accounts" section. */
  showCrossUnread?: boolean;
  showCrossStarred?: boolean;
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
}

const ROW_PX_BASE = 8;
const CHEVRON_SLOT = 20;
const INDENT_STEP = 12;

const getIconForMailbox = (role?: string, name?: string, hasChildren?: boolean, isExpanded?: boolean, _isShared?: boolean, id?: string) => {
  const lowerName = name?.toLowerCase() || "";

  if (id?.startsWith('shared-account-')) {
    return User;
  }

  if (role === "inbox" || lowerName.includes("inbox")) return Inbox;
  if (role === "sent" || lowerName.includes("sent")) return Send;
  if (role === "drafts" || lowerName.includes("draft")) return File;
  if (role === "trash" || lowerName.includes("trash") || lowerName.includes("deleted")) return Trash2;
  if (role === "junk" || role === "spam" || lowerName.includes("junk") || lowerName.includes("spam")) return Ban;
  if (role === "archive" || lowerName.includes("archive")) return Archive;
  if (role === "shared" || lowerName.includes("shared")) return Users;
  if (role === "important" || lowerName.includes("important")) return AlertTriangle;
  if (role === "memos" || lowerName.includes("memo")) return NotebookPen;
  if (role === "scheduled" || lowerName.includes("scheduled")) return CalendarClock;
  if (role === "snoozed" || lowerName.includes("snoozed")) return BellOff;
  if (lowerName.includes("star") || lowerName.includes("flag")) return Star;

  if (hasChildren) {
    return isExpanded ? FolderOpen : Folder;
  }

  return Folder;
};

const ROLE_ICON_COLOR: Record<string, string> = {
  inbox: "text-blue-600/80 dark:text-blue-400/80",
  sent: "text-emerald-600/80 dark:text-emerald-400/80",
  drafts: "text-violet-600/80 dark:text-violet-400/80",
  trash: "text-muted-foreground",
  junk: "text-red-600/80 dark:text-red-400/80",
  archive: "text-amber-600/80 dark:text-amber-400/80",
  shared: "text-cyan-600/80 dark:text-cyan-400/80",
  important: "text-orange-600/80 dark:text-orange-400/80",
  memos: "text-yellow-600/80 dark:text-yellow-400/80",
  scheduled: "text-sky-600/80 dark:text-sky-400/80",
  snoozed: "text-slate-500/80 dark:text-slate-400/80",
};

function resolveRoleKey(role?: string, name?: string): string | undefined {
  const lowerName = name?.toLowerCase() || "";
  if (role === "inbox" || lowerName.includes("inbox")) return "inbox";
  if (role === "sent" || lowerName.includes("sent")) return "sent";
  if (role === "drafts" || lowerName.includes("draft")) return "drafts";
  if (role === "trash" || lowerName.includes("trash") || lowerName.includes("deleted")) return "trash";
  if (role === "junk" || role === "spam" || lowerName.includes("junk") || lowerName.includes("spam")) return "junk";
  if (role === "archive" || lowerName.includes("archive")) return "archive";
  if (role === "shared" || lowerName.includes("shared")) return "shared";
  if (role === "important" || lowerName.includes("important")) return "important";
  if (role === "memos" || lowerName.includes("memo")) return "memos";
  if (role === "scheduled" || lowerName.includes("scheduled")) return "scheduled";
  if (role === "snoozed" || lowerName.includes("snoozed")) return "snoozed";
  return undefined;
}

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
  onUnreadClick,
}: {
  unread?: number;
  total?: number;
  isSelected: boolean;
  onUnreadClick?: () => void;
}) {
  const showFolderTotalCount = useSettingsStore(s => s.showFolderTotalCount);
  const unreadCount = unread ?? 0;
  const totalCount = showFolderTotalCount ? (total ?? 0) : 0;

  if (unreadCount === 0 && totalCount === 0) return null;

  const unreadClass = "text-xs font-semibold tabular-nums text-foreground";
  const totalClass = "text-xs tabular-nums text-muted-foreground";

  const unreadNode = unreadCount > 0 ? (
    onUnreadClick ? (
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onUnreadClick();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onUnreadClick();
          }
        }}
        className={cn(unreadClass, "cursor-pointer hover:underline")}
        title={`${unreadCount} unread`}
      >
        {unreadCount}
      </span>
    ) : (
      <span className={unreadClass}>{unreadCount}</span>
    )
  ) : null;

  return (
    <span
      className="ms-2 flex-shrink-0 flex items-baseline gap-1"
      title={totalCount > 0 ? `${unreadCount} unread / ${totalCount} total` : `${unreadCount} unread`}
      data-testid="folder-counts"
      data-unread={unreadCount}
      data-total={totalCount}
    >
      {unreadNode}
      {unreadCount > 0 && totalCount > 0 && (
        <span className="text-xs text-muted-foreground/60">/</span>
      )}
      {totalCount > 0 && <span className={totalClass}>{totalCount}</span>}
    </span>
  );
}

interface SidebarRowProps {
  icon: ReactNode;
  label: string;
  depth?: number;
  isSelected?: boolean;
  isVirtual?: boolean;
  unread?: number;
  total?: number;
  onClick?: () => void;
  hasChildren?: boolean;
  isExpanded?: boolean;
  onExpandToggle?: () => void;
  onUnreadClick?: () => void;
  isCollapsed: boolean;
  dropHandlers?: Record<string, unknown>;
  isValidDropTarget?: boolean;
  isInvalidDropTarget?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Stable identifiers for integration tests (not user-visible). */
  testRole?: string | null;
  testName?: string;
  testMailboxId?: string;
}

function SidebarRow({
  icon,
  label,
  depth = 0,
  isSelected = false,
  isVirtual = false,
  unread,
  total,
  onClick,
  hasChildren = false,
  isExpanded = false,
  onExpandToggle,
  onUnreadClick,
  isCollapsed,
  dropHandlers,
  isValidDropTarget,
  isInvalidDropTarget,
  onContextMenu,
  testRole,
  testName,
  testMailboxId,
}: SidebarRowProps) {
  const t = useTranslations('sidebar');
  const leftPad = isCollapsed ? 0 : ROW_PX_BASE + depth * INDENT_STEP;

  return (
    <div
      {...(dropHandlers || {})}
      onContextMenu={onContextMenu}
      data-testid="folder-row"
      data-folder-role={testRole ?? undefined}
      data-folder-name={testName ?? undefined}
      data-mailbox-id={testMailboxId ?? undefined}
      style={{ paddingBlock: 'var(--density-sidebar-py)' }}
      className={cn(
        "group w-full flex items-center max-lg:min-h-[44px] text-sm transition-colors duration-150",
        isCollapsed ? "justify-center px-1" : "pe-2",
        isVirtual
          ? "text-muted-foreground"
          : isSelected
            ? "bg-accent text-accent-foreground font-semibold border-s-2 border-primary"
            : "hover:bg-muted/50 text-foreground border-s-2 border-transparent",
        isValidDropTarget && "bg-primary/20 ring-2 ring-primary ring-inset",
        isInvalidDropTarget && "bg-destructive/10 ring-2 ring-destructive/30 ring-inset opacity-50"
      )}
    >
      {!isCollapsed && (
        <div
          className="flex items-center flex-shrink-0"
          style={{ paddingLeft: leftPad }}
        >
          {hasChildren && onExpandToggle ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onExpandToggle();
              }}
              className="flex items-center justify-center rounded hover:bg-muted active:bg-accent transition-colors"
              style={{ width: CHEVRON_SLOT, height: CHEVRON_SLOT }}
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
        className={cn(
          "flex items-center gap-2 min-w-0 transition-colors",
          isCollapsed ? "justify-center" : "flex-1 text-start",
          isVirtual && "cursor-default select-none"
        )}
        title={isCollapsed ? label : undefined}
      >
        <span className="flex items-center justify-center flex-shrink-0 w-4 h-4">
          {icon}
        </span>
        {!isCollapsed && (
          <>
            <span className="flex-1 truncate">{label}</span>
            <SidebarRowCounts
              unread={unread}
              total={total}
              isSelected={isSelected}
              onUnreadClick={onUnreadClick}
            />
          </>
        )}
      </button>
    </div>
  );
}

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
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  onSettings?: () => void;
  settingsTitle?: string;
  isCollapsed: boolean;
  first?: boolean;
  icon?: ReactNode;
  sub?: boolean;
}) {
  if (isCollapsed) {
    return first ? null : <div className="h-px bg-border/50 mx-2 my-2" aria-hidden />;
  }

  const paddingY = sub ? "pt-2" : first ? "pt-3" : "pt-5";
  const paddingX = sub ? "px-4" : "px-3";
  const textClass = sub
    ? "text-xs font-semibold text-muted-foreground truncate"
    : "text-sm font-semibold text-foreground truncate";

  return (
    <button
      onClick={onToggle}
      className={cn(
        "group w-full flex items-center pb-1 select-none rounded-sm hover:bg-muted/40 transition-colors",
        paddingX,
        paddingY
      )}
    >
      {expanded ? (
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      ) : (
        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      )}
      {icon && <span className="ms-1.5 flex-shrink-0">{icon}</span>}
      <span className={cn(textClass, icon ? "ms-1.5" : "ms-1.5")}>
        {label}
      </span>
      {onSettings && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onSettings();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onSettings();
            }
          }}
          className="ms-auto p-1 rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
          title={settingsTitle}
        >
          <Settings className="w-3.5 h-3.5" />
        </span>
      )}
    </button>
  );
}

function MailboxTreeItem({
  node,
  selectedMailbox,
  expandedFolders,
  onMailboxSelect,
  onToggleExpand,
  isCollapsed,
  onUnreadFilterClick,
  colorful,
  onContextMenu,
}: {
  node: MailboxNode;
  selectedMailbox: string;
  expandedFolders: Set<string>;
  onMailboxSelect?: (id: string) => void;
  onToggleExpand: (id: string) => void;
  isCollapsed: boolean;
  onUnreadFilterClick?: (mailboxId: string) => void;
  colorful: boolean;
  onContextMenu?: (e: React.MouseEvent, node: MailboxNode) => void;
}) {
  const tNotifications = useTranslations('notifications');
  const tSidebar = useTranslations('sidebar');
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedFolders.has(node.id);
  const Icon = getIconForMailbox(node.role, node.name, hasChildren, isExpanded, node.isShared, node.id);
  const isVirtualNode = node.id.startsWith('shared-');
  const isSelected = selectedMailbox === node.id;
  const roleKey = resolveRoleKey(node.role, node.name);
  const label = localizeMailboxName(node.role, node.name, (k) => tSidebar(`mailboxes.${k}`));

  const { isDragging: globalDragging } = useDragDropContext();
  const { dropHandlers, isValidDropTarget, isInvalidDropTarget } = useMailboxDrop({
    mailbox: node,
    onSuccess: (count, mailboxName) => {
      if (count === 1) {
        toast.success(
          tNotifications('email_moved'),
          tNotifications('moved_to_mailbox', { mailbox: mailboxName })
        );
      } else {
        toast.success(
          tNotifications('emails_moved', { count }),
          tNotifications('moved_to_mailbox', { mailbox: mailboxName })
        );
      }
    },
    onError: () => {
      toast.error(tNotifications('move_failed'), tNotifications('move_error'));
    },
  });

  return (
    <>
      <SidebarRow
        icon={<Icon className={getIconClass(isSelected, isVirtualNode, colorful, roleKey)} />}
        label={label}
        testRole={node.role}
        testName={node.name}
        testMailboxId={node.id}
        depth={node.depth}
        isSelected={isSelected}
        isVirtual={isVirtualNode}
        unread={node.unreadEmails}
        total={node.totalEmails}
        onClick={() => onMailboxSelect?.(node.id)}
        hasChildren={hasChildren}
        isExpanded={isExpanded}
        onExpandToggle={() => onToggleExpand(node.id)}
        onUnreadClick={() => onUnreadFilterClick?.(node.id)}
        isCollapsed={isCollapsed}
        dropHandlers={globalDragging ? (dropHandlers as Record<string, unknown>) : undefined}
        isValidDropTarget={isValidDropTarget}
        isInvalidDropTarget={isInvalidDropTarget}
        onContextMenu={onContextMenu && !isVirtualNode ? (e) => onContextMenu(e, node) : undefined}
      />

      {hasChildren && isExpanded && !isCollapsed && node.children.map((child) => (
        <MailboxTreeItem
          key={child.id}
          node={child}
          selectedMailbox={selectedMailbox}
          expandedFolders={expandedFolders}
          onMailboxSelect={onMailboxSelect}
          onToggleExpand={onToggleExpand}
          isCollapsed={isCollapsed}
          onUnreadFilterClick={onUnreadFilterClick}
          colorful={colorful}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  );
}

const TAG_ICON_COLOR: Record<string, string> = {
  red: "text-red-600/75 dark:text-red-400/75",
  orange: "text-orange-600/75 dark:text-orange-400/75",
  yellow: "text-yellow-600/75 dark:text-yellow-400/75",
  green: "text-green-600/75 dark:text-green-400/75",
  blue: "text-blue-600/75 dark:text-blue-400/75",
  purple: "text-purple-600/75 dark:text-purple-400/75",
  pink: "text-pink-600/75 dark:text-pink-400/75",
  teal: "text-teal-600/75 dark:text-teal-400/75",
  cyan: "text-cyan-600/75 dark:text-cyan-400/75",
  indigo: "text-indigo-600/75 dark:text-indigo-400/75",
  amber: "text-amber-600/75 dark:text-amber-400/75",
  lime: "text-lime-600/75 dark:text-lime-400/75",
  gray: "text-gray-500",
};

function TagItem({
  kw,
  isSelected,
  isCollapsed,
  onTagSelect,
  totalCount,
  unreadCount,
  colorful,
}: {
  kw: KeywordDefinition;
  isSelected: boolean;
  isCollapsed: boolean;
  onTagSelect?: (keywordId: string | null) => void;
  totalCount: number;
  unreadCount: number;
  colorful: boolean;
}) {
  const t = useTranslations('notifications');
  const palette = KEYWORD_PALETTE[kw.color];
  const { isDragging: globalDragging } = useDragDropContext();
  const { dropHandlers, isValidDropTarget } = useTagDrop({
    tagId: kw.id,
    onSuccess: (count, _tagLabel) => {
      if (count === 1) {
        toast.success(t('email_tagged'), kw.label);
      } else {
        toast.success(t('emails_tagged', { count }), kw.label);
      }
    },
    onError: () => {
      toast.error(t('tag_failed'), kw.label);
    },
  });

  const tagIcon = colorful ? (
    <Tag
      className={cn("w-4 h-4 flex-shrink-0", TAG_ICON_COLOR[kw.color] || "text-muted-foreground")}
      fill="currentColor"
    />
  ) : (
    <span className={cn("w-3 h-3 rounded-full", palette?.dot || "bg-gray-400")} />
  );

  return (
    <SidebarRow
      icon={tagIcon}
      label={kw.label}
      depth={0}
      isSelected={isSelected}
      unread={unreadCount}
      total={totalCount}
      onClick={() => onTagSelect?.(isSelected ? null : kw.id)}
      isCollapsed={isCollapsed}
      dropHandlers={globalDragging ? (dropHandlers as Record<string, unknown>) : undefined}
      isValidDropTarget={isValidDropTarget}
    />
  );
}

function DemoBanner() {
  const t = useTranslations('sidebar');
  const { isDemoMode, loginDemo } = useAuthStore();
  const { startTour, resetTourCompletion } = useTour();
  const router = useRouter();
  const [isResetting, setIsResetting] = useState(false);

  if (!isDemoMode) return null;

  const handleReset = async () => {
    setIsResetting(true);
    router.push('/');
    await loginDemo();
    setIsResetting(false);
  };

  const handleStartTour = () => {
    resetTourCompletion();
    router.push('/');
    setTimeout(() => startTour(), 100);
  };

  return (
    <div
      data-tour="demo-banner"
      className={cn(
        "flex flex-col gap-1.5 w-full px-3 py-2 text-xs",
        "bg-primary/10 dark:bg-primary/10 text-primary",
      )}
    >
      <div className="flex items-center gap-2">
        <FlaskConical className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="truncate font-medium">{t("demo_banner")}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={handleStartTour}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 hover:bg-primary/20 transition-colors"
          title={t("demo_tour")}
        >
          <PlayCircle className="w-3 h-3" />
          {t("demo_tour")}
        </button>
        <button
          onClick={handleReset}
          disabled={isResetting}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 hover:bg-primary/20 transition-colors disabled:opacity-50"
          title={t("demo_reset")}
        >
          {isResetting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RotateCcw className="w-3 h-3" />
          )}
          {t("demo_reset")}
        </button>
      </div>
    </div>
  );
}

function VacationBanner() {
  const t = useTranslations('sidebar');
  const router = useRouter();
  const { isEnabled, isSupported } = useVacationStore();

  if (!isSupported || !isEnabled) return null;

  return (
    <button
      onClick={() => router.push('/settings')}
      className={cn(
        "flex items-center gap-2 w-full px-3 py-2 text-xs",
        "bg-amber-500/10 dark:bg-amber-400/10 text-amber-700 dark:text-amber-400",
        "hover:bg-amber-500/15 dark:hover:bg-amber-400/15 transition-colors"
      )}
    >
      <Palmtree className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate font-medium">{t("vacation_active")}</span>
      <Settings className="w-3 h-3 ms-auto flex-shrink-0 opacity-60" />
    </button>
  );
}

export function Sidebar({
  mailboxes = [],
  selectedMailbox = "",
  selectedKeyword = null,
  onMailboxSelect,
  onTagSelect,
  onCompose: _onCompose,
  onSidebarClose,
  onUnreadFilterClick,
  onMarkFolderRead,
  onMarkFolderTreeRead,
  onMarkAllFoldersRead,
  onEmptyFolder,
  onCreateSubfolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onImportEmail,
  onRefreshMailboxes,
  scheduledTotal = 0,
  showScheduledMailbox = false,
  showAllMailMailbox = false,
  showCrossUnread = false,
  showCrossStarred = false,
  showCrossAll = false,
  crossUnreadCount = 0,
  className,
  multiAccountMode = false,
  accountMailboxes,
  viewingAccountId = null,
  onAccountMailboxSelect,
}: SidebarProps) {
  const router = useRouter();
  const { sidebarCollapsed: isCollapsed, toggleSidebarCollapsed } = useUIStore();
  const { primaryIdentity: _primaryIdentity, activeAccountId } = useAuthStore();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
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
  const emailKeywords = useSettingsStore(s => s.emailKeywords);
  const isEmbedded = useIsEmbedded();
  // The Pro shell owns the global chrome (rail + tab bar), so the sidebar's
  // own AccountSwitcher would be a redundant second account UI in the same
  // pane.
  const hideAccountSwitcher = useSettingsStore(s => s.hideAccountSwitcher) || isEmbedded;
  const enableUnifiedMailbox = useSettingsStore(s => s.enableUnifiedMailbox);
  const includeGroupInUnified = useSettingsStore(s => s.includeGroupInUnified);
  const colorfulSidebarIcons = useSettingsStore(s => s.colorfulSidebarIcons);
  const tagCounts = useEmailStore(s => s.tagCounts);
  const accounts = useAccountStore(s => s.accounts);
  const connectedAccounts = accounts.filter(a => a.isConnected);
  const hasGroupInboxes = useMemo(() => mailboxes.some(m => m.isShared), [mailboxes]);
  // Pro shell treats the unified mailbox as a core part of the multi-account
  // UI, so it ignores the user-facing `enableUnifiedMailbox` toggle. With a
  // single account we still surface unified when the user has opted into
  // merging group/shared inboxes — otherwise the counts would just duplicate
  // the one inbox.
  const showUnified =
    (multiAccountMode || enableUnifiedMailbox) &&
    (connectedAccounts.length > 1 || (includeGroupInUnified && hasGroupInboxes));
  const { unifiedCounts } = useEmailStore();
  const t = useTranslations('sidebar');

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

  // When the app renders its own virtual "Scheduled" folder (for delayed
  // sends, driven by EmailSubmission), hide the server-provided scheduled
  // mailbox (e.g. Stalwart's auto-created Scheduled folder, role === 'scheduled')
  // so it does not appear twice. (#495)
  const isServerScheduledNode = (n: MailboxNode) => showScheduledMailbox && n.role === 'scheduled';

  const mailboxTree = buildMailboxTree(mailboxes);
  const ownTree = mailboxTree.filter(n => !n.id.startsWith('shared-account-') && !isServerScheduledNode(n));
  const sharedAccounts = mailboxTree.filter(n => n.id.startsWith('shared-account-'));

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
        return { account, isActive, tree };
      })
    : [];

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
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
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

  const openFolderSettings = () => {
    try { sessionStorage.setItem('settings-deep-link-tab', 'folders'); } catch { /* */ }
    router.push('/settings');
  };
  const openKeywordSettings = () => {
    try { sessionStorage.setItem('settings-deep-link-tab', 'keywords'); } catch { /* */ }
    router.push('/settings');
  };

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

  return (
    <div
      className={cn(
        "relative flex flex-col h-full border-e transition-all duration-300 overflow-hidden",
        "bg-secondary border-border",
        "max-lg:w-full",
        isCollapsed ? "lg:w-12" : "lg:w-full",
        className
      )}
    >
      {/* Header - hidden in the Pro shell, which owns its own chrome and
          would otherwise render an empty strip (no collapse, no switcher). */}
      {!isEmbedded && (
        // Border lives on the wrapper (outside the h-14 box) so the bar's total
        // height matches the search/reply toolbars, which border-b their wrapper too.
        <div className="border-b border-border">
          <div className={cn("flex items-center h-14", isCollapsed ? "justify-center px-2" : "gap-1 px-2")}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onSidebarClose}
              className="lg:hidden h-9 w-9 flex-shrink-0"
              aria-label={t("close")}
            >
              <X className="w-5 h-5" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebarCollapsed}
              className="hidden lg:flex h-8 w-8 flex-shrink-0"
              title={isCollapsed ? t("expand_tooltip") : t("collapse_tooltip")}
            >
              {isCollapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
            </Button>

            {!isCollapsed && !hideAccountSwitcher && (
              <AccountSwitcher variant="expanded" className="flex-1" />
            )}
          </div>
        </div>
      )}

      {!isCollapsed && <DemoBanner />}
      {!isCollapsed && <VacationBanner />}

      {/* Mailbox List */}
      <div className="flex-1 overflow-y-auto" data-tour="sidebar">
        {showAllMailMailbox && (
          <SidebarRow
            icon={<Mails className={cn("w-4 h-4 flex-shrink-0", selectedMailbox === '__all_mail__' ? "text-foreground" : "text-muted-foreground")} />}
            label={t('mailboxes.all_mail')}
            depth={0}
            isSelected={!selectedKeyword && selectedMailbox === '__all_mail__'}
            onClick={() => onMailboxSelect?.('__all_mail__')}
            isCollapsed={isCollapsed}
          />
        )}
        {(showUnified || showCrossUnread || showCrossStarred || showCrossAll) && (
          <div>
            <SidebarSectionHeader
              label={t("all_accounts")}
              expanded={unifiedExpanded}
              onToggle={toggleUnified}
              isCollapsed={isCollapsed}
              first
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
          accountGroups.map(({ account, isActive, tree }) => {
            const expanded = !collapsedAccountGroups.has(account.id);
            const isViewing = isActive ? viewingAccountId === null : viewingAccountId === account.id;
            return (
              <div key={account.id} onContextMenu={isActive ? handleFoldersHeaderContextMenu : undefined}>
                <SidebarSectionHeader
                  label={account.label || account.email || account.username}
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
                      <div className="px-4 py-2 text-sm text-muted-foreground">
                        {!isCollapsed && t("loading_mailboxes")}
                      </div>
                    ) : (
                      <>
                        {tree.map((node) => (
                          <MailboxTreeItem
                            key={node.id}
                            node={node}
                            selectedMailbox={selectedKeyword || !isViewing ? "" : selectedMailbox}
                            expandedFolders={expandedFolders}
                            onMailboxSelect={(mailboxId) =>
                              onAccountMailboxSelect?.(isActive ? null : account.id, mailboxId)
                            }
                            onToggleExpand={handleToggleExpand}
                            isCollapsed={isCollapsed}
                            onUnreadFilterClick={isActive ? onUnreadFilterClick : undefined}
                            colorful={colorfulSidebarIcons}
                            onContextMenu={isActive ? handleMailboxContextMenu : undefined}
                          />
                        ))}
                        {isActive && showScheduledMailbox && (
                          <SidebarRow
                            icon={<CalendarClock className={cn("w-4 h-4 flex-shrink-0", selectedMailbox === '__scheduled__' ? "text-foreground" : "text-muted-foreground")} />}
                            label={t('scheduled')}
                            depth={0}
                            isSelected={!selectedKeyword && selectedMailbox === '__scheduled__'}
                            total={scheduledTotal}
                            onClick={() => onMailboxSelect?.('__scheduled__')}
                            isCollapsed={isCollapsed}
                          />
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })
        ) : (
          <div onContextMenu={handleFoldersHeaderContextMenu}>
            <SidebarSectionHeader
              label={t("folders")}
              expanded={foldersExpanded}
              onToggle={toggleFolders}
              onSettings={openFolderSettings}
              settingsTitle={t('settings')}
              isCollapsed={isCollapsed}
              first={!showUnified}
            />
            {((foldersExpanded && !isCollapsed) || isCollapsed) && (
              <>
                {mailboxes.length === 0 ? (
                  <div className="px-4 py-2 text-sm text-muted-foreground">
                    {!isCollapsed && t("loading_mailboxes")}
                  </div>
                ) : (
                  <>
                    {ownTree.map((node) => (
                        <MailboxTreeItem
                          key={node.id}
                          node={node}
                          selectedMailbox={selectedKeyword ? "" : selectedMailbox}
                          expandedFolders={expandedFolders}
                          onMailboxSelect={onMailboxSelect}
                          onToggleExpand={handleToggleExpand}
                          isCollapsed={isCollapsed}
                          onUnreadFilterClick={onUnreadFilterClick}
                          colorful={colorfulSidebarIcons}
                          onContextMenu={handleMailboxContextMenu}
                        />
                    ))}
                    {showScheduledMailbox && (
                      <SidebarRow
                        icon={<CalendarClock className={cn("w-4 h-4 flex-shrink-0", selectedMailbox === '__scheduled__' ? "text-foreground" : "text-muted-foreground")} />}
                        label={t('scheduled')}
                        depth={0}
                        isSelected={!selectedKeyword && selectedMailbox === '__scheduled__'}
                        total={scheduledTotal}
                        onClick={() => onMailboxSelect?.('__scheduled__')}
                        isCollapsed={isCollapsed}
                      />
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {!useMultiAccount && sharedAccounts.length > 0 && (
          <div>
            <SidebarSectionHeader
              label={t("shared")}
              expanded={sharedExpanded}
              onToggle={toggleShared}
              isCollapsed={isCollapsed}
            />
            {((sharedExpanded && !isCollapsed) || isCollapsed) && (
              <>
                {sharedAccounts.map((account) => {
                  const accountExpanded = expandedSharedAccounts.has(account.id);
                  return (
                    <div key={account.id}>
                      <SidebarSectionHeader
                        label={account.name}
                        expanded={accountExpanded}
                        onToggle={() => toggleSharedAccount(account.id)}
                        isCollapsed={isCollapsed}
                        sub
                        icon={<User className="w-3.5 h-3.5 text-muted-foreground" />}
                      />
                      {accountExpanded && !isCollapsed && account.children.map((child) => (
                        <MailboxTreeItem
                          key={child.id}
                          node={child}
                          selectedMailbox={selectedKeyword ? "" : selectedMailbox}
                          expandedFolders={expandedFolders}
                          onMailboxSelect={onMailboxSelect}
                          onToggleExpand={handleToggleExpand}
                          isCollapsed={isCollapsed}
                          onUnreadFilterClick={onUnreadFilterClick}
                          colorful={colorfulSidebarIcons}
                          onContextMenu={handleMailboxContextMenu}
                        />
                      ))}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {emailKeywords.length > 0 && (
          <div data-tour="keyword-tags">
            <SidebarSectionHeader
              label={t("tags")}
              expanded={tagsExpanded}
              onToggle={toggleTags}
              onSettings={openKeywordSettings}
              settingsTitle={t('settings')}
              isCollapsed={isCollapsed}
            />
            {((tagsExpanded && !isCollapsed) || isCollapsed) && (
              <>
                {emailKeywords.map((kw) => (
                  <TagItem
                    key={kw.id}
                    kw={kw}
                    isSelected={selectedKeyword === kw.id}
                    isCollapsed={isCollapsed}
                    onTagSelect={onTagSelect}
                    totalCount={tagCounts[kw.id]?.total ?? 0}
                    unreadCount={tagCounts[kw.id]?.unread ?? 0}
                    colorful={colorfulSidebarIcons}
                  />
                ))}
              </>
            )}
          </div>
        )}

        {!isCollapsed && <PluginSlot name="sidebar-widget" className="border-t border-border" />}
      </div>

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
        onImportEmail={onImportEmail}
        onRefresh={onRefreshMailboxes}
      />
    </div>
  );
}
