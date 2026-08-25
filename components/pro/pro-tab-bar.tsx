"use client";

import { useRef, useState, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { Mail, Calendar, BookUser, HardDrive, Settings, PenSquare, MailOpen, Folder, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProTabStore, type ProTab, type ProTabKind, type ProPaneId } from "@/stores/pro-tab-store";
import {
  PRO_TAB_DRAG_MIME,
  EMAIL_IDS_DRAG_MIME,
  MAILBOX_DRAG_MIME,
  dragKindFromTypes,
  parseEmailIdsPayload,
  parseMailboxDragPayload,
  type MailboxDragPayload,
} from "@/components/pro/pro-shell-drop";

export { PRO_TAB_DRAG_MIME };

interface ProTabBarProps {
  /** The pane this strip belongs to - it renders only that pane's tabs. */
  paneId: ProPaneId;
  tabs: ProTab[];
  activeTabId: string | null;
  /** Whether this strip's pane holds keyboard/interaction focus. */
  isFocused: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Fires on tab drag start/end so the shell can show body drop zones. */
  onDragStateChange?: (dragging: boolean, tabId: string | null) => void;
  /** Emails dragged from a message list and dropped on this strip. */
  onEmailDrop?: (emailIds: string[]) => void;
  /** A sidebar folder dragged onto this strip - opens it as a folder tab. */
  onFolderDrop?: (payload: MailboxDragPayload) => void;
  className?: string;
}

const TAB_ICONS: Record<ProTabKind, LucideIcon> = {
  mail: Mail,
  calendar: Calendar,
  contacts: BookUser,
  files: HardDrive,
  settings: Settings,
  compose: PenSquare,
  email: MailOpen,
  folder: Folder,
};

type DropIndicator = { targetId: string; edge: "before" | "after" } | null;

export function ProTabBar({
  paneId,
  tabs,
  activeTabId,
  isFocused,
  onActivate,
  onClose,
  onDragStateChange,
  onEmailDrop,
  onFolderDrop,
  className,
}: ProTabBarProps) {
  const tSidebar = useTranslations("sidebar");
  const reorderTab = useProTabStore((s) => s.reorderTab);

  const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null);
  // True while an email or folder payload hovers the strip (both drop "anywhere").
  const [isPayloadDragOver, setIsPayloadDragOver] = useState(false);
  const dragLeaveTimer = useRef<number | null>(null);

  const dragKind = (e: DragEvent) => dragKindFromTypes(e.dataTransfer.types);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, tab: ProTab) => {
    e.dataTransfer.setData(PRO_TAB_DRAG_MIME, tab.id);
    e.dataTransfer.effectAllowed = "move";
    onDragStateChange?.(true, tab.id);
  };

  const handleDragEnd = () => {
    setDropIndicator(null);
    setIsPayloadDragOver(false);
    onDragStateChange?.(false, null);
  };

  const handleTabDragOver = (e: DragEvent<HTMLDivElement>, tab: ProTab) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    if (kind === "email" || kind === "folder") {
      // Emails/folders can land anywhere on the strip - no per-tab insertion caret.
      e.dataTransfer.dropEffect = "copy";
      setIsPayloadDragOver(true);
      return;
    }
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const edge: "before" | "after" =
      e.clientX < rect.left + rect.width / 2 ? "before" : "after";
    setDropIndicator((prev) =>
      prev && prev.targetId === tab.id && prev.edge === edge
        ? prev
        : { targetId: tab.id, edge },
    );
    if (dragLeaveTimer.current !== null) {
      window.clearTimeout(dragLeaveTimer.current);
      dragLeaveTimer.current = null;
    }
  };

  const handleStripDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    if (dragLeaveTimer.current !== null) window.clearTimeout(dragLeaveTimer.current);
    dragLeaveTimer.current = window.setTimeout(() => {
      setDropIndicator(null);
      setIsPayloadDragOver(false);
      dragLeaveTimer.current = null;
    }, 40);
  };

  /** Dropped email/folder payloads - anything that isn't a tab reorder. */
  const handlePayloadDrop = (e: DragEvent<HTMLDivElement>): boolean => {
    if (e.dataTransfer.types.includes(MAILBOX_DRAG_MIME)) {
      const payload = parseMailboxDragPayload(e.dataTransfer.getData(MAILBOX_DRAG_MIME));
      if (payload) onFolderDrop?.(payload);
      return true;
    }
    if (!e.dataTransfer.types.includes(EMAIL_IDS_DRAG_MIME)) return false;
    const ids = parseEmailIdsPayload(e.dataTransfer.getData(EMAIL_IDS_DRAG_MIME));
    if (ids.length > 0) onEmailDrop?.(ids);
    return true;
  };

  const handleTabDrop = (e: DragEvent<HTMLDivElement>, tab: ProTab) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    if (kind === "email" || kind === "folder") {
      handlePayloadDrop(e);
      handleDragEnd();
      return;
    }
    const draggedId = e.dataTransfer.getData(PRO_TAB_DRAG_MIME);
    if (!draggedId || draggedId === tab.id) {
      handleDragEnd();
      return;
    }
    const edge = dropIndicator?.targetId === tab.id ? dropIndicator.edge : "after";
    reorderTab(draggedId, tab.id, edge);
    handleDragEnd();
  };

  const handleStripEndDrop = (e: DragEvent<HTMLDivElement>) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    if (kind === "email" || kind === "folder") {
      handlePayloadDrop(e);
      handleDragEnd();
      return;
    }
    const draggedId = e.dataTransfer.getData(PRO_TAB_DRAG_MIME);
    if (!draggedId) {
      handleDragEnd();
      return;
    }
    const last = tabs[tabs.length - 1];
    if (last && last.id !== draggedId) {
      reorderTab(draggedId, last.id, "after");
    }
    handleDragEnd();
  };

  const handleStripEndDragOver = (e: DragEvent<HTMLDivElement>) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    if (kind === "email" || kind === "folder") {
      e.dataTransfer.dropEffect = "copy";
      setIsPayloadDragOver(true);
      return;
    }
    e.dataTransfer.dropEffect = "move";
    const last = tabs[tabs.length - 1];
    if (last) {
      setDropIndicator({ targetId: last.id, edge: "after" });
    }
  };

  return (
    <div
      className={cn(
        "relative flex items-stretch h-9 bg-secondary px-1 overflow-x-auto scroll-hidden flex-shrink-0",
        isPayloadDragOver && "bg-primary/10",
        className,
      )}
      style={{ borderBottom: '1px solid rgba(128, 128, 128, 0.3)' }}
      role="tablist"
      data-pane-strip={paneId}
      onDragLeave={handleStripDragLeave}
    >
      {tabs.map((tab) => {
        const Icon = TAB_ICONS[tab.kind];
        const isActive = tab.id === activeTabId;
        const isFocusedActive = isActive && isFocused;
        const label = tab.title ?? tSidebar(tab.labelKey);
        const showBefore = dropIndicator?.targetId === tab.id && dropIndicator.edge === "before";
        const showAfter = dropIndicator?.targetId === tab.id && dropIndicator.edge === "after";
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            data-tab-id={tab.id}
            data-pane-id={tab.paneId}
            draggable
            onClick={() => onActivate(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1 && tab.closeable) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            onDragStart={(e) => handleDragStart(e, tab)}
            onDragOver={(e) => handleTabDragOver(e, tab)}
            onDrop={(e) => handleTabDrop(e, tab)}
            onDragEnd={handleDragEnd}
            className={cn(
              "group relative flex items-center gap-1.5 px-3 h-9 text-sm cursor-pointer select-none transition-colors",
              "min-w-0 flex-1 basis-0 max-w-[200px] [min-width:80px]",
              "border-e border-border first:border-s",
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
              isFocusedActive && "font-medium",
            )}
            style={
              isActive
                ? { borderRightColor: 'rgba(128, 128, 128, 0.3)', borderLeftColor: 'rgba(128, 128, 128, 0.3)' }
                : undefined
            }
          >
            <Icon className={cn("w-4 h-4 flex-shrink-0", isFocusedActive && "text-primary")} />
            <span className="truncate flex-1 min-w-0" title={label}>{label}</span>

            {tab.closeable && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className={cn(
                  "ms-1 flex items-center justify-center w-4 h-4 rounded-sm transition-colors flex-shrink-0",
                  "text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground",
                  !isActive && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
                aria-label={tSidebar("close")}
                tabIndex={isActive ? 0 : -1}
              >
                <X className="w-3 h-3" />
              </button>
            )}

            {isActive && (
              <span
                className="absolute left-0 right-0 -bottom-px h-px bg-background"
                aria-hidden="true"
              />
            )}
            {/* Focused pane affordance: the active tab of the focused pane
                carries an accent top edge, so it's always visible which side
                of a split the next click/open will affect. */}
            {isFocusedActive && (
              <span
                className="absolute left-0 right-0 top-0 h-0.5 bg-primary"
                aria-hidden="true"
              />
            )}

            {showBefore && (
              <span
                className="pointer-events-none absolute top-1 bottom-1 left-0 w-0.5 -translate-x-1/2 bg-primary rounded-full"
                aria-hidden="true"
              />
            )}
            {showAfter && (
              <span
                className="pointer-events-none absolute top-1 bottom-1 right-0 w-0.5 translate-x-1/2 bg-primary rounded-full"
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}

      {/* Trailing area soaks up drops past the last tab. */}
      <div
        className="flex-1 min-w-[8px]"
        onDragOver={handleStripEndDragOver}
        onDrop={handleStripEndDrop}
        aria-hidden="true"
      />
    </div>
  );
}
