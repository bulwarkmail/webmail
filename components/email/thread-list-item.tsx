"use client";

import React, { useCallback } from "react";
import { formatDate } from "@/lib/utils";
import { Email, ThreadGroup } from "@/lib/jmap/types";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Paperclip, Star, Circle, ChevronRight, ChevronDown, Loader2, MessageSquare, CheckSquare, Square, Reply, Forward } from "lucide-react";
import { useSettingsStore, KEYWORD_PALETTE } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import { useEmailStore } from "@/stores/email-store";
import { useAccountStore } from "@/stores/account-store";
import { getThreadColorTag, getEmailColorTags } from "@/lib/thread-utils";
import { useEmailDrag } from "@/hooks/use-email-drag";
import { useLongPress } from "@/hooks/use-long-press";
import { ThreadEmailItem } from "./thread-email-item";
import { EmailHoverActions } from "./email-hover-actions";
import { useTranslations } from "next-intl";

interface ThreadListItemProps {
  thread: ThreadGroup;
  isExpanded: boolean;
  selectedEmailId?: string;
  isLoading?: boolean;
  expandedEmails?: Email[];
  onToggleExpand: () => void;
  onEmailSelect: (email: Email) => void;
  onContextMenu?: (e: React.MouseEvent, email: Email) => void;
  onOpenConversation?: (thread: ThreadGroup) => void;
  onToggleStar?: (email: Email) => void;
  onMarkAsRead?: (email: Email, read: boolean) => void;
  onDelete?: (email: Email) => void;
  onArchive?: (email: Email) => void;
  onSetColorTag?: (emailId: string, color: string | null) => void;
  onMarkAsSpam?: (email: Email) => void;
}

interface SingleEmailItemProps {
  email: Email;
  selected: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent, email: Email) => void;
  showPreview: boolean;
  colorTag: string | null;
  onToggleStar?: () => void;
  onMarkAsRead?: (read: boolean) => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onSetColorTag?: (color: string | null) => void;
  onMarkAsSpam?: () => void;
}

const SingleEmailItem = React.forwardRef<HTMLDivElement, SingleEmailItemProps>(
  function SingleEmailItem({ email, selected, onClick, onContextMenu, showPreview, colorTag, onToggleStar, onMarkAsRead, onDelete, onArchive, onSetColorTag, onMarkAsSpam }, ref) {
    const isUnread = !email.keywords?.$seen;
    const isStarred = email.keywords?.$flagged;
    const isAnswered = email.keywords?.$answered;
    const isForwarded = email.keywords?.$forwarded;
    const { selectedMailbox, mailboxes, selectedEmailIds, toggleEmailSelection, selectRangeEmails, clearSelection } = useEmailStore();
    // In Sent/Drafts folders, show recipient instead of sender (which is always "me")
    const currentMailboxRole = mailboxes.find(mb => mb.id === selectedMailbox)?.role;
    const showRecipient = currentMailboxRole === 'sent' || currentMailboxRole === 'drafts';
    const sender = showRecipient ? (email.to?.[0] ?? email.from?.[0]) : email.from?.[0];
    const emailKeywords = useSettingsStore((state) => state.emailKeywords);
    const density = useSettingsStore((state) => state.density);
    const mailLayout = useSettingsStore((state) => state.mailLayout);
    const showAvatarsInJunk = useSettingsStore((state) => state.showAvatarsInJunk);
    const hideJunkAvatarImages = currentMailboxRole === 'junk' && !showAvatarsInJunk;
    const isUnifiedView = useEmailStore((state) => state.isUnifiedView);
    const getAccountById = useAccountStore((state) => state.getAccountById);
    const accountColor = email.accountId ? getAccountById(email.accountId)?.avatarColor : undefined;
    const isChecked = selectedEmailIds.has(email.id);
    const isFocusedMailLayout = mailLayout === 'focus';
    const inlinePreview = showPreview && email.preview ? ` ${email.preview}` : '';

    // Resolve color tags using keyword definitions; unknown tags fall back to gray
    const tagIds = getEmailColorTags(email.keywords);
    const resolvedKeywordDefs = tagIds.map(id => emailKeywords.find(k => k.id === id) ?? { id, label: id, color: 'gray' });
    const resolvedKeywordDef = resolvedKeywordDefs[0] ?? null;
    const resolvedColorTag = (() => {
      if (colorTag) return colorTag;
      return resolvedKeywordDef ? KEYWORD_PALETTE[resolvedKeywordDef.color]?.bg ?? null : null;
    })();

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

    const handleCheckboxClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleEmailSelection(email.id);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      onContextMenu?.(e, email);
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
        onClick();
      }
    };

    return (
      <div
        ref={ref}
        {...dragHandlers}
        {...longPressHandlers}
        className={cn(
          "relative group cursor-pointer select-none transition-shadow duration-200 border-b border-border overflow-hidden",
          resolvedColorTag ? resolvedColorTag : (
            selected
              ? "bg-accent"
              : "bg-background"
          ),
          selected && !resolvedColorTag && "shadow-sm",
          !resolvedColorTag && !selected && !isChecked && "hover:bg-muted hover:shadow-sm",
          !resolvedColorTag && (selected || isChecked) && "hover:bg-accent hover:shadow-sm",
          resolvedColorTag && "hover:brightness-95 dark:hover:brightness-110",
          isUnread && !resolvedColorTag && "bg-accent/30",
          isChecked && "ring-2 ring-primary/20 bg-accent/40",
          isDragging && "opacity-50 scale-[0.98] ring-2 ring-primary/30",
          isPressed && "bg-muted scale-[0.98] ring-2 ring-primary/30"
        )}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        style={{ minHeight: isFocusedMailLayout ? undefined : 'var(--list-item-height)' }}
      >
        <div
          className={cn('px-3', isFocusedMailLayout ? 'flex items-center py-2.5' : 'flex items-start')}
          style={isFocusedMailLayout ? { gap: '12px' } : { gap: 'var(--density-item-gap)', paddingBlock: 'var(--density-item-py)' }}
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

          {isUnread && (
            <div className="absolute left-1 top-1/2 -translate-y-1/2">
              <Circle className="w-2 h-2 fill-unread text-unread" />
            </div>
          )}

          {!isFocusedMailLayout && density !== 'extra-compact' && (
            <Avatar
              name={sender?.name}
              email={sender?.email}
              size="md"
              className="flex-shrink-0 shadow-sm"
              disableImages={hideJunkAvatarImages}
            />
          )}

          <div className="flex-1 min-w-0">
            {isFocusedMailLayout ? (
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {isUnifiedView && email.accountId && accountColor && (
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: accountColor }}
                      title={email.accountLabel}
                    />
                  )}
                  <span className={cn(
                    'w-32 shrink-0 truncate text-sm lg:w-40',
                    isUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/80'
                  )}>
                    {sender?.name || sender?.email || 'Unknown'}
                  </span>
                  <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                    <span className={cn(
                      'shrink-0 truncate',
                      isUnread ? 'font-semibold text-foreground' : 'text-foreground/90'
                    )}>
                      {email.subject || '(no subject)'}
                    </span>
                    {inlinePreview && (
                      <span className="min-w-0 truncate text-muted-foreground">{inlinePreview}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2.5 shrink-0">
                  {isStarred && <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />}
                  {isAnswered && !isForwarded && <Reply className="w-3.5 h-3.5 text-muted-foreground" />}
                  {isForwarded && !isAnswered && <Forward className="w-3.5 h-3.5 text-muted-foreground" />}
                  {isAnswered && isForwarded && (
                    <>
                      <Reply className="w-3.5 h-3.5 text-muted-foreground" />
                      <Forward className="w-3.5 h-3.5 text-muted-foreground" />
                    </>
                  )}
                  {email.hasAttachment && <Paperclip className="w-3.5 h-3.5 text-muted-foreground" />}
                  {resolvedKeywordDefs.map((kd) => (
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
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {isUnifiedView && email.accountId && accountColor && (
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: accountColor }}
                        title={email.accountLabel}
                      />
                    )}
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
                    {resolvedKeywordDefs.map((kd) => (
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

                <div className={cn(
                  "mb-1 line-clamp-1 text-sm",
                  isUnread
                    ? "font-semibold text-foreground"
                    : "font-normal text-foreground/90"
                )}>
                  {email.subject || "(no subject)"}
                </div>

                {showPreview && density !== 'extra-compact' && density !== 'compact' && (
                  <p className={cn(
                    "text-sm leading-relaxed line-clamp-2",
                    isUnread
                      ? "text-muted-foreground"
                      : "text-muted-foreground/80"
                  )}>
                    {email.preview || "No preview available"}
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* Hover Quick Actions */}
        <EmailHoverActions
          email={email}
          backgroundClassName={resolvedColorTag ? resolvedColorTag : ((selected || isChecked) ? "bg-accent" : "bg-muted")}
          onToggleStar={onToggleStar}
          onMarkAsRead={onMarkAsRead}
          onDelete={onDelete}
          onArchive={onArchive}
          onSetColorTag={onSetColorTag}
          onMarkAsSpam={onMarkAsSpam}
        />
      </div>
    );
  }
);

export const ThreadListItem = React.forwardRef<HTMLDivElement, ThreadListItemProps>(
  function ThreadListItem({
    thread,
    isExpanded,
    selectedEmailId,
    isLoading = false,
    expandedEmails,
    onToggleExpand,
    onEmailSelect,
    onContextMenu,
    onOpenConversation,
    onToggleStar,
    onMarkAsRead,
    onDelete,
    onArchive,
    onSetColorTag,
    onMarkAsSpam,
  }, ref) {
    const t = useTranslations('threads');
    const showPreview = useSettingsStore((state) => state.showPreview);
    const density = useSettingsStore((state) => state.density);
    const mailLayout = useSettingsStore((state) => state.mailLayout);
    const showAvatarsInJunk = useSettingsStore((state) => state.showAvatarsInJunk);
    const isMobile = useUIStore((state) => state.isMobile);
    const { latestEmail, participantNames, hasUnread, hasStarred, hasAttachment, hasAnswered, hasForwarded, emailCount } = thread;
    const isFocusedMailLayout = mailLayout === 'focus';
    const inlinePreview = showPreview && latestEmail.preview ? ` ${latestEmail.preview}` : '';

    const { selectedMailbox, mailboxes, selectedEmailIds, toggleEmailSelection, selectRangeEmails, clearSelection, isUnifiedView } = useEmailStore();
    const getAccountById = useAccountStore((state) => state.getAccountById);
    const threadAccountColor = latestEmail.accountId ? getAccountById(latestEmail.accountId)?.avatarColor : undefined;
    // In Sent/Drafts folders, show recipient instead of sender (which is always "me")
    const currentMailboxRole = mailboxes.find(mb => mb.id === selectedMailbox)?.role;
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

    const threadColor = getThreadColorTag(thread.emails);
    const emailKeywordDefs = useSettingsStore((state) => state.emailKeywords);
    const keywordDef = threadColor ? (emailKeywordDefs.find(k => k.id === threadColor) ?? { id: threadColor, label: threadColor, color: 'gray' }) : null;
    const colorTag = keywordDef ? KEYWORD_PALETTE[keywordDef.color]?.bg ?? null : null;

    const isSelected = selectedEmailId === latestEmail.id ||
      thread.emails.some(e => e.id === selectedEmailId);

    const isChecked = thread.emails.some(e => selectedEmailIds.has(e.id));

    if (emailCount === 1) {
      return (
        <SingleEmailItem
          ref={ref}
          email={latestEmail}
          selected={selectedEmailId === latestEmail.id}
          onClick={() => onEmailSelect(latestEmail)}
          onContextMenu={onContextMenu}
          showPreview={showPreview}
          colorTag={colorTag}
          onToggleStar={onToggleStar ? () => onToggleStar(latestEmail) : undefined}
          onMarkAsRead={onMarkAsRead ? (read) => onMarkAsRead(latestEmail, read) : undefined}
          onDelete={onDelete ? () => onDelete(latestEmail) : undefined}
          onArchive={onArchive ? () => onArchive(latestEmail) : undefined}
          onSetColorTag={onSetColorTag ? (color) => onSetColorTag(latestEmail.id, color) : undefined}
          onMarkAsSpam={onMarkAsSpam ? () => onMarkAsSpam(latestEmail) : undefined}
        />
      );
    }

    const emailsToShow = expandedEmails || thread.emails;

    const handleThreadCheckboxClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      // Toggle selection for all emails in this thread
      const allSelected = thread.emails.every(em => selectedEmailIds.has(em.id));
      const newSelection = new Set(selectedEmailIds);
      thread.emails.forEach(em => {
        if (allSelected) {
          newSelection.delete(em.id);
        } else {
          newSelection.add(em.id);
        }
      });
      useEmailStore.setState({ selectedEmailIds: newSelection, lastSelectedEmailId: latestEmail.id });
    };

    const handleHeaderClick = (e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Ctrl+Click: toggle selection for all thread emails
        thread.emails.forEach(em => toggleEmailSelection(em.id));
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        selectRangeEmails(latestEmail.id);
        return;
      }

      if (isMobile && onOpenConversation) {
        onOpenConversation(thread);
        return;
      }

      const target = e.target as HTMLElement;
      if (target.closest('[data-expand-toggle]')) {
        onToggleExpand();
      } else {
        if (selectedEmailIds.size > 0) clearSelection();
        if (!isExpanded) {
          onToggleExpand();
        }
        onEmailSelect(latestEmail);
      }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      onContextMenu?.(e, latestEmail);
    };

    return (
      <div ref={ref} className={cn("border-b border-border", isThreadDragging && "opacity-50 scale-[0.98] ring-2 ring-primary/30")}>
        <div
          {...dragHandlers}
          {...threadLongPressHandlers}
          className={cn(
            "relative group cursor-pointer select-none transition-shadow duration-200 overflow-hidden",
            colorTag ? colorTag : (
              isSelected
                ? "bg-accent"
                : "bg-background"
            ),
            isSelected && !colorTag && "shadow-sm",
            !colorTag && !isSelected && !isChecked && "hover:bg-muted hover:shadow-sm",
            !colorTag && (isSelected || isChecked) && "hover:bg-accent hover:shadow-sm",
            colorTag && "hover:brightness-95 dark:hover:brightness-110",
            hasUnread && !colorTag && !isSelected && "bg-accent/30",
            isExpanded && "border-b border-border/50",
            isChecked && "ring-2 ring-primary/20 bg-accent/40",
            isThreadPressed && "bg-muted scale-[0.98] ring-2 ring-primary/30"
          )}
          onClick={handleHeaderClick}
          onContextMenu={handleContextMenu}
          style={{ minHeight: isFocusedMailLayout ? undefined : 'var(--list-item-height)' }}
        >
          <div
            className={cn('px-3', isFocusedMailLayout ? 'flex items-center py-2.5' : 'flex items-start')}
            style={isFocusedMailLayout ? { gap: '12px' } : { gap: 'var(--density-item-gap)', paddingBlock: 'var(--density-item-py)' }}
          >
            {/* Checkbox for thread selection - only visible when in selection mode */}
            {selectedEmailIds.size > 0 && (
              <button
                onClick={handleThreadCheckboxClick}
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

            {!isMobile && !isFocusedMailLayout && (
              <button
                data-expand-toggle
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand();
                }}
                className={cn(
                  "p-1 rounded mt-2 flex-shrink-0 transition-all duration-200",
                  "hover:bg-muted/50 hover:scale-110",
                  "active:scale-95",
                  "text-muted-foreground hover:text-foreground"
                )}
                aria-expanded={isExpanded}
                aria-label={t('toggle_thread')}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isExpanded ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>
            )}

            {hasUnread && (
              <div className="absolute left-1 top-1/2 -translate-y-1/2">
                <Circle className="w-2 h-2 fill-unread text-unread" />
              </div>
            )}

            {!isFocusedMailLayout && density !== 'extra-compact' && (
              <Avatar
                name={avatarPerson?.name}
                email={avatarPerson?.email}
                size="md"
                className="flex-shrink-0 shadow-sm"
                disableImages={hideJunkAvatarImages}
              />
            )}

            <div className="flex-1 min-w-0">
              {isFocusedMailLayout ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    {isUnifiedView && latestEmail.accountId && threadAccountColor && (
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: threadAccountColor }}
                        title={latestEmail.accountLabel}
                      />
                    )}
                    <span className={cn(
                      'w-32 shrink-0 truncate text-sm lg:w-44',
                      hasUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/80'
                    )}>
                      {displayNames.join(', ')}
                    </span>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-medium',
                        hasUnread ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                      )}
                      title={t('messages_tooltip', { count: emailCount })}
                    >
                      <MessageSquare className="w-3 h-3" />
                      {emailCount}
                    </span>
                    <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <span className={cn(
                        'shrink-0 truncate',
                        hasUnread ? 'font-semibold text-foreground' : 'text-foreground/90'
                      )}>
                        {latestEmail.subject || '(no subject)'}
                      </span>
                      {inlinePreview && (
                        <span className="min-w-0 truncate text-muted-foreground">{inlinePreview}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    {hasStarred && <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />}
                    {hasAnswered && !hasForwarded && <Reply className="w-3.5 h-3.5 text-muted-foreground" />}
                    {hasForwarded && !hasAnswered && <Forward className="w-3.5 h-3.5 text-muted-foreground" />}
                    {hasAnswered && hasForwarded && (
                      <>
                        <Reply className="w-3.5 h-3.5 text-muted-foreground" />
                        <Forward className="w-3.5 h-3.5 text-muted-foreground" />
                      </>
                    )}
                    {hasAttachment && <Paperclip className="w-3.5 h-3.5 text-muted-foreground" />}
                    {keywordDef && (
                      <span className={cn('h-2.5 w-2.5 rounded-full', KEYWORD_PALETTE[keywordDef.color]?.dot || 'bg-gray-400')} />
                    )}
                    <span className={cn(
                      'text-xs tabular-nums',
                      hasUnread ? 'text-foreground font-semibold' : 'text-muted-foreground'
                    )}>
                      {formatDate(latestEmail.receivedAt)}
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      {isUnifiedView && latestEmail.accountId && threadAccountColor && (
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: threadAccountColor }}
                          title={latestEmail.accountLabel}
                        />
                      )}
                      <span className={cn(
                        "truncate text-sm",
                        hasUnread
                          ? "font-bold text-foreground"
                          : "font-medium text-muted-foreground"
                      )}>
                        {displayNames.join(", ")}
                      </span>
                      <span
                        className={cn(
                          "flex-shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded-full font-medium",
                          hasUnread
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        )}
                        title={t('messages_tooltip', { count: emailCount })}
                      >
                        <MessageSquare className="w-3 h-3" />
                        {emailCount}
                      </span>
                      <div className="flex items-center gap-1.5">
                        {hasStarred && (
                          <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                        )}
                        {hasAnswered && !hasForwarded && (
                          <Reply className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                        {hasForwarded && !hasAnswered && (
                          <Forward className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                        {hasAnswered && hasForwarded && (
                          <>
                            <Reply className="w-3.5 h-3.5 text-muted-foreground" />
                            <Forward className="w-3.5 h-3.5 text-muted-foreground" />
                          </>
                        )}
                        {hasAttachment && (
                          <Paperclip className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {keywordDef && (
                        <span className={cn(
                          "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full",
                          KEYWORD_PALETTE[keywordDef.color]?.bg || "bg-muted"
                        )}>
                          <span className={cn("w-1.5 h-1.5 rounded-full", KEYWORD_PALETTE[keywordDef.color]?.dot || "bg-gray-400")} />
                          {keywordDef.label}
                        </span>
                      )}
                      <span className={cn(
                        "text-xs tabular-nums",
                        hasUnread
                          ? "text-foreground font-semibold"
                          : "text-muted-foreground"
                      )}>
                        {formatDate(latestEmail.receivedAt)}
                      </span>
                    </div>
                  </div>

                  <div className={cn(
                    "mb-1 line-clamp-1 text-sm",
                    hasUnread
                      ? "font-semibold text-foreground"
                      : "font-normal text-foreground/90"
                  )}>
                    {latestEmail.subject || "(no subject)"}
                  </div>

                  {showPreview && density !== 'extra-compact' && density !== 'compact' && (
                    <p className={cn(
                      "text-sm leading-relaxed line-clamp-2",
                      hasUnread
                        ? "text-muted-foreground"
                        : "text-muted-foreground/80"
                    )}>
                      {latestEmail.preview || "No preview available"}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Hover Quick Actions for thread header */}
          <EmailHoverActions
            email={latestEmail}
            backgroundClassName={colorTag ? colorTag : ((isSelected || isChecked) ? "bg-accent" : "bg-muted")}
            onToggleStar={onToggleStar ? () => onToggleStar(latestEmail) : undefined}
            onMarkAsRead={onMarkAsRead ? (read) => onMarkAsRead(latestEmail, read) : undefined}
            onDelete={onDelete ? () => onDelete(latestEmail) : undefined}
            onArchive={onArchive ? () => onArchive(latestEmail) : undefined}
            onSetColorTag={onSetColorTag ? (color) => onSetColorTag(latestEmail.id, color) : undefined}
            onMarkAsSpam={onMarkAsSpam ? () => onMarkAsSpam(latestEmail) : undefined}
          />
        </div>

        {isExpanded && !isMobile && !isFocusedMailLayout && (
          <div className="bg-muted/20 animate-in slide-in-from-top-2 duration-200">
            {isLoading ? (
              <div className="py-4 flex items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                {t('loading')}
              </div>
            ) : (
              emailsToShow.map((email, index) => (
                <ThreadEmailItem
                  key={email.id}
                  email={email}
                  selected={email.id === selectedEmailId}
                  isLast={index === emailsToShow.length - 1}
                  onClick={() => onEmailSelect(email)}
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
