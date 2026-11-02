"use client";

import { useCallback } from "react";
import { emailDisplayDate } from "@/lib/email-date";
import { useTranslations } from "next-intl";
import { cleanPreview, formatDate } from "@/lib/utils";
import { Email } from "@/lib/jmap/types";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { useSenderWarning } from "@/hooks/use-sender-warning";
import { brandIndicatorDomain } from "@/lib/email-headers";
import { Paperclip, Star, Circle, CheckSquare, Square, Reply, Forward, CalendarClock } from "@/components/icons";
import { useEmailDrag } from "@/hooks/use-email-drag";
import { useLongPress } from "@/hooks/use-long-press";
import { useEmailStore } from "@/stores/email-store";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import { emailKeyFor, getEmailTagIds } from "@/lib/thread-utils";
import { useKeywordFormat } from "@/hooks/use-keyword-format";
import { useEmailTagScope } from "@/hooks/use-account-tags";
import { useTagDisplay } from "@/hooks/use-tag-display";
import { TagBadge } from "./tag-badge";
import { ROW_TAG_GROUP_CLASS } from "./row-tag-classes";
import { useListRowShape, LIST_COLUMN_CLASS } from "@/hooks/use-list-row-shape";
import { SizeCell, listLeadClass } from "./list-columns";
import { rowA11yProps, rowLabel } from "./list-a11y";

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
  const tBatch = useTranslations('email_list.batch_actions');
  const tStatus = useTranslations('email_list');
  const isUnread = !email.keywords?.$seen;
  const isStarred = email.keywords?.$flagged;
  const isAnswered = email.keywords?.$answered;
  const isForwarded = email.keywords?.$forwarded;
  const tagScope = useEmailTagScope(email);
  const { sortTagIds } = useKeywordFormat(tagScope);
  const { variant: tagVariant } = useTagDisplay();
  // A message inside an expanded thread carries its own tags; the collapsed
  // header pools them, so without this they disappear on the way in.
  const tagIds = sortTagIds(getEmailTagIds(email.keywords));
  const sender = email.from?.[0];
  const senderWarning = useSenderWarning(email);
  const { selectedMailbox, selectedEmailKeys, toggleEmailSelection, selectRangeEmails } = useEmailStore(useShallow((state) => ({
    selectedMailbox: state.selectedMailbox,
    selectedEmailKeys: state.selectedEmailKeys,
    toggleEmailSelection: state.toggleEmailSelection,
    selectRangeEmails: state.selectRangeEmails,
  })));
  const density = useSettingsStore((state) => state.density);
  const isChecked = selectedEmailKeys.has(emailKeyFor(email));

  const { dragHandlers, isDragging } = useEmailDrag({
    email,
    sourceMailboxId: selectedMailbox,
  });

  const isMobile = useUIStore((state) => state.isMobile);
  const { columns } = useListRowShape();

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
    toggleEmailSelection(email);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleEmailSelection(email);
    } else if (e.shiftKey) {
      e.preventDefault();
      selectRangeEmails(email);
    } else if (selectedEmailKeys.size > 0) {
      // Selection mode: the whole row is the checkbox (#1014).
      toggleEmailSelection(email);
    } else {
      onClick?.();
    }
  };

  const senderName = sender?.name || sender?.email?.split('@')[0] || t('unknown_sender');
  const selectLabel = tBatch('select_row', { sender: senderName, subject: email.subject || t('no_subject') });
  const a11y = rowA11yProps({
    rowKey: emailKeyFor(email),
    label: rowLabel([
      isUnread && t('unread'),
      senderName,
      formatDate(emailDisplayDate(email)),
      isStarred && tStatus('starred'),
      isAnswered && tStatus('replied'),
      isForwarded && tStatus('forwarded'),
      email.hasAttachment && tStatus('has_attachment'),
      // The row shows the message's text where the subject would be.
      cleanPreview(email.preview),
    ]),
    selected: !!selected,
    level: 2,
    checked: isChecked,
    selectionMode: selectedEmailKeys.size > 0,
    onToggleCheck: () => toggleEmailSelection(email),
    onOpenMenu: onContextMenu ? handleContextMenu : undefined,
  });

  const rowHandlers = {
    onClick: handleClick,
    onDoubleClick: (e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!onDoubleClick || selectedEmailKeys.size > 0) return;
      e.preventDefault();
      onDoubleClick();
    },
    onContextMenu: handleContextMenu,
  };

  if (columns) {
    // A message of an unfolded conversation as a row of the table: its own
    // sender and date in the columns, indented under the conversation's
    // names, and its text where the subject goes (#262).
    const selecting = selectedEmailKeys.size > 0;
    const lead = listLeadClass(density, selecting);
    return (
      <div
        {...dragHandlers}
        {...longPressHandlers}
        {...rowHandlers}
        {...a11y}
        data-testid="thread-email-row"
        className={cn(
          "relative cursor-pointer select-none px-3 transition-colors duration-150",
          selected ? "bg-selection" : "hover:bg-muted/50",
          isUnread && !selected && "bg-warning/10",
          !isLast && "border-b border-border/30",
          isChecked && "ring-2 ring-primary/20 bg-accent/40",
          isDragging && "opacity-50",
          isPressed && "bg-muted"
        )}
        style={{ paddingBlock: 'var(--density-item-py)' }}
      >
        <div role="gridcell" className="flex items-center" style={{ gap: 'var(--density-item-gap)' }}>
          {lead && (
            <span className={cn(lead, 'flex shrink-0 items-center justify-center')}>
              {selecting ? (
                <button
                  onClick={handleCheckboxClick}
                  role="checkbox"
                  aria-checked={isChecked}
                  aria-label={selectLabel}
                  className={cn("rounded p-1 hover:bg-muted/50", isChecked && "text-primary")}
                >
                  {isChecked ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
              ) : isUnread ? (
                <Circle className="w-1.5 h-1.5 fill-unread text-unread" />
              ) : null}
            </span>
          )}
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className={cn(LIST_COLUMN_CLASS.from, 'flex items-center gap-2 ps-9 text-sm')}>
                <span className={cn(
                  "min-w-0 truncate",
                  isUnread ? "font-semibold text-foreground" : "font-medium text-muted-foreground"
                )}>
                  {sender?.name || sender?.email?.split('@')[0] || t('unknown_sender')}
                </span>
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                {tagIds.length > 0 && (
                  <span className={ROW_TAG_GROUP_CLASS}>
                    {tagIds.map((id) => (
                      <TagBadge key={id} tagId={id} variant={tagVariant} scope={tagScope} className="max-w-[min(12rem,100%)]" />
                    ))}
                  </span>
                )}
                <span className={cn("min-w-0 shrink-[9999] truncate", isUnread ? "text-muted-foreground" : "text-muted-foreground")}>
                  {cleanPreview(email.preview) || t('no_preview_available')}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              {email.isScheduled && <CalendarClock className="w-3.5 h-3.5 text-primary" />}
              {isStarred && <Star className="w-3 h-3 fill-amber-400 text-amber-400" />}
              {isAnswered && <Reply className="w-3 h-3 text-muted-foreground" />}
              {isForwarded && <Forward className="w-3 h-3 text-muted-foreground" />}
              {email.hasAttachment && <Paperclip className="w-3 h-3 text-muted-foreground" />}
              <span className={cn(
                LIST_COLUMN_CLASS.date,
                "text-xs tabular-nums",
                isUnread ? "text-foreground font-medium" : "text-muted-foreground"
              )}>
                {formatDate(emailDisplayDate(email))}
              </span>
              <SizeCell bytes={email.size} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      {...dragHandlers}
      {...longPressHandlers}
      {...a11y}
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
        if (!onDoubleClick || selectedEmailKeys.size > 0) return;
        e.preventDefault();
        onDoubleClick();
      }}
      onContextMenu={handleContextMenu}
      style={{ paddingBlock: 'var(--density-item-py)' }}
    >
      <div role="gridcell" className="flex items-start gap-3">
        {/* Checkbox - only visible when in selection mode */}
        {selectedEmailKeys.size > 0 && (
          <button
            onClick={handleCheckboxClick}
            role="checkbox"
            aria-checked={isChecked}
            aria-label={selectLabel}
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

        {/* Unread indicator — anchored on the first line (top padding + half a
            small avatar), not on the row's midpoint, so it stays in line with
            the checkbox and avatar when the row wraps to a second line. */}
        {isUnread && (
          <div
            className="absolute start-7 -translate-y-1/2"
            style={{ top: `calc(var(--density-item-py) + ${density === 'extra-compact' ? '0.625rem' : '1rem'})` }}
          >
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
            senderWarning={senderWarning}
            brandDomain={brandIndicatorDomain(email)}
          />
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Single line: Sender, indicators, preview, date */}
          <div className="flex items-center gap-2">
            <span className={cn(
              "min-w-0 shrink-[9999] truncate text-sm max-w-[150px]",
              tagIds.length > 0 && "max-w-24 shrink-[2]",
              isUnread
                ? "font-semibold text-foreground"
                : "font-medium text-muted-foreground"
            )}>
              {sender?.name || sender?.email?.split('@')[0] || t('unknown_sender')}
            </span>

            {/* Indicators stay outside the clipped tag suffix. */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {email.isScheduled && (
                <CalendarClock className="w-3 h-3 text-primary" />
              )}
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
            {tagIds.length > 0 && (
              <span className={cn(ROW_TAG_GROUP_CLASS, 'basis-12 grow')}>
                {tagIds.map((id) => (
                  <TagBadge key={id} tagId={id} variant={tagVariant} scope={tagScope} className="max-w-[min(12rem,100%)]" />
                ))}
              </span>
            )}

            {/* Preview snippet */}
            <span className={cn(
              "text-sm truncate flex-1 min-w-0 shrink-[9999]",
              isUnread
                ? "text-muted-foreground"
                : "text-muted-foreground"
            )}>
              {cleanPreview(email.preview) || t('no_preview_available')}
            </span>

            {/* Date */}
            <span className={cn(
              "text-xs flex-shrink-0 tabular-nums",
              isUnread
                ? "text-foreground font-medium"
                : "text-muted-foreground"
            )}>
              {formatDate(emailDisplayDate(email))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
