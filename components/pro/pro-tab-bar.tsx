"use client";

import { useRef, useState, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { Mail, Calendar, BookUser, HardDrive, Settings, PenSquare, MailOpen, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProTabStore, type ProTab, type ProTabKind } from "@/stores/pro-tab-store";

/** Custom MIME type used to carry the dragged Pro tab id between handlers. */
export const PRO_TAB_DRAG_MIME = "application/x-pro-tab-id";

interface ProTabBarProps {
  /** All tabs (both panes). Order in the array is the order in the bar. */
  tabs: ProTab[];
  activeMainTabId: string | null;
  activeSplitTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onDragStateChange?: (dragging: boolean) => void;
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
};

type DropIndicator = { targetId: string; edge: "before" | "after" } | null;

export function ProTabBar({
  tabs,
  activeMainTabId,
  activeSplitTabId,
  onActivate,
  onClose,
  onDragStateChange,
  className,
}: ProTabBarProps) {
  const tSidebar = useTranslations("sidebar");
  const reorderTab = useProTabStore((s) => s.reorderTab);
  const focusedPaneId = useProTabStore((s) => s.focusedPaneId);

  const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null);
  const dragLeaveTimer = useRef<number | null>(null);

  const isProTabDrag = (e: DragEvent) =>
    e.dataTransfer.types.includes(PRO_TAB_DRAG_MIME);

  const handleDragStart = (e: DragEvent<HTMLDivElement>, tab: ProTab) => {
    e.dataTransfer.setData(PRO_TAB_DRAG_MIME, tab.id);
    e.dataTransfer.effectAllowed = "move";
    onDragStateChange?.(true);
  };

  const handleDragEnd = () => {
    setDropIndicator(null);
    onDragStateChange?.(false);
  };

  const handleTabDragOver = (e: DragEvent<HTMLDivElement>, tab: ProTab) => {
    if (!isProTabDrag(e)) return;
    e.preventDefault();
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
      dragLeaveTimer.current = null;
    }, 40);
  };

  const handleTabDrop = (e: DragEvent<HTMLDivElement>, tab: ProTab) => {
    if (!isProTabDrag(e)) return;
    e.preventDefault();
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
    if (!isProTabDrag(e)) return;
    e.preventDefault();
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
    if (!isProTabDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const last = tabs[tabs.length - 1];
    if (last) {
      setDropIndicator({ targetId: last.id, edge: "after" });
    }
  };

  return (
    <div
      className={cn(
        "flex items-stretch h-9 bg-secondary px-1 overflow-x-auto scroll-hidden flex-shrink-0",
        className,
      )}
      style={{ borderBottom: '1px solid rgba(128, 128, 128, 0.3)' }}
      role="tablist"
      onDragLeave={handleStripDragLeave}
    >
      {tabs.map((tab) => {
        const Icon = TAB_ICONS[tab.kind];
        const isActiveMain = tab.id === activeMainTabId && tab.paneId === 'main';
        const isActiveSplit = tab.id === activeSplitTabId && tab.paneId === 'split';
        const isActive = isActiveMain || isActiveSplit;
        const isFocusedActive =
          (isActiveMain && focusedPaneId === 'main')
          || (isActiveSplit && focusedPaneId === 'split');
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
