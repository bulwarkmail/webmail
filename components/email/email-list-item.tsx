"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { formatDate, stripInvisibleLeading } from "@/lib/utils";
import { Email } from "@/lib/jmap/types";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Paperclip, Star, Circle, CheckSquare, Square, Reply, Forward } from "lucide-react";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore, KEYWORD_PALETTE } from "@/stores/settings-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailDrag } from "@/hooks/use-email-drag";
import { useLongPress } from "@/hooks/use-long-press";
import { useUIStore } from "@/stores/ui-store";
import { EmailIdentityBadge } from "./email-identity-badge";
import { EmailHoverActions } from "./email-hover-actions";
import { getEmailColorTags } from "@/lib/thread-utils";

interface EmailListItemProps {
  email: Email;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent, email: Email) => void;
  onToggleStar?: () => void;
  onMarkAsRead?: (read: boolean) => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onSetColorTag?: (color: string | null) => void;
  onMarkAsSpam?: () => void;
  onUndoSpam?: () => void;
}

export function EmailListItem({ email, selected, onClick, onDoubleClick, onContextMenu, onToggleStar, onMarkAsRead, onDelete, onArchive, onSetColorTag, onMarkAsSpam, onUndoSpam }: EmailListItemProps) {
  const t = useTranslations('email_viewer');
  const { selectedEmailIds, toggleEmailSelection, selectRangeEmails, selectedMailbox, mailboxes, clearSelection, isUnifiedView, unifiedRole } = useEmailStore();
  const showPreview = useSettingsStore((state) => state.showPreview);
  const density = useSettingsStore((state) => state.density);
  const mailLayout = useSettingsStore((state) => state.mailLayout);
  const emailKeywords = useSettingsStore((state) => state.emailKeywords);
  const showAvatarsInJunk = useSettingsStore((state) => state.showAvatarsInJunk);
  const { identities } = useAuthStore();
  const isChecked = selectedEmailIds.has(email.id);
  const isUnread = !email.keywords?.$seen;
  const isStarred = email.keywords?.$flagged;
  const isImportant = email.keywords?.["$important"];
  const isAnswered = email.keywords?.$answered;
  const isForwarded = email.keywords?.$forwarded;
  // In Sent/Drafts folders, show recipient instead of sender (which is always "me").
  // In aggregate role-views the selected mailbox is virtual → fall back to the
  // unified role so junk-contextual UI (spam ↔ not-spam) and avatar hiding work.
  const currentMailboxRole = mailboxes.find(mb => mb.id === selectedMailbox)?.role
    ?? (isUnifiedView ? (unifiedRole ?? undefined) : undefined);
  const showRecipient = currentMailboxRole === 'sent' || currentMailboxRole === 'drafts';
  const sender = showRecipient ? (email.to?.[0] ?? email.from?.[0]) : email.from?.[0];
  const isMobile = useUIStore((state) => state.isMobile);
  // The horizontal one-line "focus" layout doesn't fit on narrow screens; fall back to multi-line on mobile.
  const isFocusedMailLayout = mailLayout === 'focus' && !isMobile;
  const hideJunkAvatarImages = currentMailboxRole === 'junk' && !showAvatarsInJunk;
  const trimmedPreview = stripInvisibleLeading(email.preview ?? '');
  const inlinePreview = showPreview && trimmedPreview ? ` ${trimmedPreview}` : '';

  // Resolve color tags using keyword definitions from settings; unknown tags fall back to gray
  const colorTagIds = getEmailColorTags(email.keywords);
  const keywordDefs = colorTagIds.map(id => emailKeywords.find(k => k.id === id) ?? { id, label: id, color: 'gray' });
  // Use first tag for background coloring
  const keywordDef = keywordDefs[0] ?? null;
  const colorTag = keywordDef ? KEYWORD_PALETTE[keywordDef.color]?.bg ?? null : null;

  // Drag and drop functionality
  const { dragHandlers, isDragging } = useEmailDrag({
    email,
    sourceMailboxId: selectedMailbox,
  });

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

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      // Shift-click extends the selection from the anchor to here, like
      // shift-clicking the row (the checkbox stops propagation, so the
      // row's shift handler never runs — replicate it here).
      selectRangeEmails(email.id);
    } else {
      toggleEmailSelection(email.id);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu?.(e, email);
  };

  return (
    <div
      {...dragHandlers}
      {...longPressHandlers}
      className={cn(
        "relative group cursor-pointer select-none transition-shadow duration-200 border-b border-border overflow-hidden",
        // Apply color tag as background, with selected and unread states
        colorTag ? colorTag : (
          selected
            ? "bg-selection"
            : "bg-background"
        ),
        selected && !colorTag && "shadow-sm",
        !colorTag && !selected && !isChecked && "hover:bg-muted hover:shadow-sm",
        !colorTag && (selected || isChecked) && "hover:bg-accent hover:shadow-sm",
        colorTag && "hover:brightness-95 dark:hover:brightness-110",
        isUnread && !selected && !colorTag && "bg-warning/10",
        // Add visual feedback for checked state
        isChecked && "ring-2 ring-primary/20 bg-selection/60",
        // Drag state visual feedback
        isDragging && "opacity-50 scale-[0.98] ring-2 ring-primary/30",
        // Long press visual feedback
        isPressed && "bg-muted scale-[0.98] ring-2 ring-primary/30"
      )}
      onClick={(e) => {
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
      }}
      onDoubleClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (!onDoubleClick) return;
        e.preventDefault();
        onDoubleClick();
      }}
      onContextMenu={handleContextMenu}
      style={{ minHeight: isFocusedMailLayout ? undefined : 'var(--list-item-height)' }}
    >
      <div
        className={cn('px-4', isFocusedMailLayout ? 'flex items-center' : 'flex items-start')}
        style={{ gap: 'var(--density-item-gap)', paddingBlock: 'var(--density-item-py)' }}
      >
        {/* Checkbox - only visible when in selection mode */}
        {selectedEmailIds.size > 0 && (
          <button
            onClick={handleCheckboxClick}
            className={cn(
              "p-3 lg:p-1 rounded flex-shrink-0 transition-all duration-200",
              !isFocusedMailLayout && 'mt-2',
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

        {/* Unread indicator */}
        {isUnread && (
          <div className="absolute left-0.5 top-1/2 -translate-y-1/2">
            <Circle className="w-2 h-2 fill-unread text-unread" />
          </div>
        )}

        {/* Avatar */}
        {density !== 'extra-compact' && (
          <Avatar
            name={sender?.name}
            email={sender?.email}
            size={isFocusedMailLayout ? "sm" : "md"}
            className="flex-shrink-0 shadow-sm"
            disableImages={hideJunkAvatarImages}
          />
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          {isFocusedMailLayout ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className={cn(
                  'w-32 shrink-0 truncate text-sm lg:w-40',
                  isUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/80'
                )}>
                  {sender?.name || sender?.email || 'Unknown'}
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <span className={cn(
                    'min-w-0 truncate',
                    isUnread ? 'font-semibold text-foreground' : 'text-foreground/90'
                  )}>
                    {email.subject || t('no_subject')}
                  </span>
                  {inlinePreview && (
                    <span className="min-w-0 shrink-[9999] truncate text-muted-foreground">{inlinePreview}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2.5 shrink-0">
                {isStarred && <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />}
                {isImportant && <span className="h-2 w-2 rounded-full bg-warning" />}
                {isAnswered && !isForwarded && <Reply className="w-3.5 h-3.5 text-muted-foreground" />}
                {isForwarded && !isAnswered && <Forward className="w-3.5 h-3.5 text-muted-foreground" />}
                {isAnswered && isForwarded && (
                  <>
                    <Reply className="w-3.5 h-3.5 text-muted-foreground" />
                    <Forward className="w-3.5 h-3.5 text-muted-foreground" />
                  </>
                )}
                {email.hasAttachment && <Paperclip className="w-3.5 h-3.5 text-muted-foreground" />}
                {keywordDefs.map((kd) => (
                  <span key={kd.id} className={cn('h-2.5 w-2.5 rounded-full', KEYWORD_PALETTE[kd.color]?.dot || 'bg-gray-400')} />
                ))}
                <span className={cn(
                  'text-xs tabular-nums',
                  isUnread ? 'text-foreground font-semibold' : 'text-muted-foreground'
                )}>
                  {formatDate(email.receivedAt)}
                </span>
              </div>
            </div>
          ) : (
            <>
              {/* First Line: Sender and Date */}
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className={cn(
                    "truncate text-sm",
                    isUnread
                      ? "font-bold text-foreground"
                      : "font-medium text-muted-foreground"
                  )}>
                    {sender?.name || sender?.email || "Unknown"}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {isStarred && (
                      <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                    )}
                    {isImportant && (
                      <span className="px-1.5 py-0.5 text-xs bg-warning/15 text-warning dark:text-warning rounded font-medium">
                        Important
                      </span>
                    )}
                    <EmailIdentityBadge email={email} identities={identities} compact={true} />
                    {isAnswered && !isForwarded && (
                      <Reply className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                    {isForwarded && !isAnswered && (
                      <Forward className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                    {isAnswered && isForwarded && (
                      <>
                        <Reply className="w-3.5 h-3.5 text-muted-foreground" />
                        <Forward className="w-3.5 h-3.5 text-muted-foreground" />
                      </>
                    )}
                    {email.hasAttachment && (
                      <Paperclip className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {keywordDefs.map((kd) => (
                    <span key={kd.id} className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full",
                      KEYWORD_PALETTE[kd.color]?.bg || "bg-muted"
                    )}>
                      <span className={cn("w-1.5 h-1.5 rounded-full", KEYWORD_PALETTE[kd.color]?.dot || "bg-gray-400")} />
                      {kd.label}
                    </span>
                  ))}
                  <span className={cn(
                    "text-xs tabular-nums",
                    isUnread
                      ? "text-foreground font-semibold"
                      : "text-muted-foreground"
                  )}>
                    {formatDate(email.receivedAt)}
                  </span>
                </div>
              </div>

              {/* Second Line: Subject */}
              <div className={cn(
                "mb-1 line-clamp-1 text-sm",
                isUnread
                  ? "font-semibold text-foreground"
                  : "font-normal text-foreground/90"
              )}>
                {email.subject || t('no_subject')}
              </div>

              {/* Third Line: Preview (controlled by showPreview setting) */}
              {showPreview && density !== 'extra-compact' && density !== 'compact' && (
                <p className={cn(
                  "text-sm leading-relaxed line-clamp-2",
                  isUnread
                    ? "text-muted-foreground"
                    : "text-muted-foreground/80"
                )}>
                  {trimmedPreview || t('no_preview_available')}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Hover Quick Actions */}
      <EmailHoverActions
        email={email}
        backgroundClassName={colorTag ? colorTag : ((selected || isChecked) ? "bg-accent" : "bg-muted")}
        onToggleStar={onToggleStar}
        onMarkAsRead={onMarkAsRead}
        onDelete={onDelete}
        onArchive={onArchive}
        onSetColorTag={onSetColorTag}
        onMarkAsSpam={onMarkAsSpam}
        onUndoSpam={onUndoSpam}
        isInJunk={currentMailboxRole === 'junk'}
      />
    </div>
  );
}