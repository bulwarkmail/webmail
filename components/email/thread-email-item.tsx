"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { formatDate } from "@/lib/utils";
import { Email } from "@/lib/jmap/types";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Paperclip, Star, Circle, CheckSquare, Square, Reply, Forward } from "lucide-react";
import { useEmailDrag } from "@/hooks/use-email-drag";
import { useLongPress } from "@/hooks/use-long-press";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";

interface ThreadEmailItemProps {
  email: Email;
  selected?: boolean;
  isLast?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent, email: Email) => void;
}

export function ThreadEmailItem({
  email,
  selected,
  isLast = false,
  onClick,
  onDoubleClick,
  onContextMenu,
}: ThreadEmailItemProps) {
  const t = useTranslations('email_viewer');
  const isUnread = !email.keywords?.$seen;
  const isStarred = email.keywords?.$flagged;
  const isAnswered = email.keywords?.$answered;
  const isForwarded = email.keywords?.$forwarded;
  const sender = email.from?.[0];
  const { selectedMailbox, selectedEmailIds, toggleEmailSelection, selectRangeEmails, clearSelection } = useEmailStore();
  const density = useSettingsStore((state) => state.density);
  const isChecked = selectedEmailIds.has(email.id);

  const { dragHandlers, isDragging } = useEmailDrag({
    email,
    sourceMailboxId: selectedMailbox,
  });

  const isMobile = useUIStore((state) => state.isMobile);

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

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu?.(e, email);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleEmailSelection(email.id);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleEmailSelection(email.id);
    } else if (e.shiftKey) {
      e.preventDefault();
      selectRangeEmails(email.id);
    } else {
      if (selectedEmailIds.size > 0) clearSelection();
      onClick?.();
    }
  };

  return (
    <div
      {...dragHandlers}
      {...longPressHandlers}
      className={cn(
        "relative cursor-pointer select-none transition-all duration-150",
        "ps-12 pe-4",
        "border-s-2 border-l-transparent",
        selected
          ? "bg-selection border-l-primary"
          : "hover:bg-muted/50",
        isUnread && !selected && "bg-warning/10",
        !isLast && "border-b border-border/30",
        isChecked && "ring-2 ring-primary/20 bg-accent/40",
        isDragging && "opacity-50 scale-[0.98] ring-2 ring-primary/30",
        isPressed && "bg-muted scale-[0.98] ring-2 ring-primary/30"
      )}
      onClick={handleClick}
      onDoubleClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (!onDoubleClick) return;
        e.preventDefault();
        onDoubleClick();
      }}
      onContextMenu={handleContextMenu}
      style={{ paddingBlock: 'var(--density-item-py)' }}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox - only visible when in selection mode */}
        {selectedEmailIds.size > 0 && (
          <button
            onClick={handleCheckboxClick}
            className={cn(
              "p-1 rounded mt-0.5 flex-shrink-0 transition-all duration-200",
              "hover:bg-muted/50 hover:scale-110",
              "active:scale-95",
              "animate-in fade-in zoom-in-95 duration-150",
              isChecked && "text-primary"
            )}
          >
            {isChecked ? (
              <CheckSquare className="w-3.5 h-3.5 animate-in zoom-in-50 duration-200" />
            ) : (
              <Square className="w-3.5 h-3.5 text-muted-foreground opacity-60 hover:opacity-100 transition-opacity" />
            )}
          </button>
        )}

        {/* Unread indicator */}
        {isUnread && (
          <div className="absolute start-7 top-1/2 -translate-y-1/2">
            <Circle className="w-1.5 h-1.5 fill-unread text-unread" />
          </div>
        )}

        {/* Small Avatar */}
        {density !== 'extra-compact' && (
          <Avatar
            name={sender?.name}
            email={sender?.email}
            size="sm"
            className="flex-shrink-0"
          />
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Single line: Sender, indicators, preview, date */}
          <div className="flex items-center gap-2">
            <span className={cn(
              "truncate text-sm flex-shrink-0 max-w-[150px]",
              isUnread
                ? "font-semibold text-foreground"
                : "font-medium text-muted-foreground"
            )}>
              {sender?.name || sender?.email?.split('@')[0] || "Unknown"}
            </span>

            {/* Indicators */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {isStarred && (
                <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
              )}
              {isAnswered && !isForwarded && (
                <Reply className="w-3 h-3 text-muted-foreground" />
              )}
              {isForwarded && !isAnswered && (
                <Forward className="w-3 h-3 text-muted-foreground" />
              )}
              {isAnswered && isForwarded && (
                <>
                  <Reply className="w-3 h-3 text-muted-foreground" />
                  <Forward className="w-3 h-3 text-muted-foreground" />
                </>
              )}
              {email.hasAttachment && (
                <Paperclip className="w-3 h-3 text-muted-foreground" />
              )}
            </div>

            {/* Preview snippet */}
            <span className={cn(
              "text-sm truncate flex-1 min-w-0",
              isUnread
                ? "text-muted-foreground"
                : "text-muted-foreground/70"
            )}>
              {email.preview || t('no_preview_available')}
            </span>

            {/* Date */}
            <span className={cn(
              "text-xs flex-shrink-0 tabular-nums",
              isUnread
                ? "text-foreground font-medium"
                : "text-muted-foreground"
            )}>
              {formatDate(email.receivedAt)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
