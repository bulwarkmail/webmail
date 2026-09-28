"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Email } from "@/lib/jmap/types";
import { useSettingsStore } from "@/stores/settings-store";
import type { HoverAction } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { Trash2, Star, Mail, MailOpen, Archive, Tag, ShieldAlert, ShieldCheck } from "@/components/icons";
import { useTranslations } from "next-intl";
import { useIsMobile } from "@/hooks/use-media-query";
import { TagPicker } from "@/components/email/tag-picker";
import { getEmailTagIds } from "@/lib/thread-utils";

interface EmailHoverActionsProps {
  email: Email;
  backgroundClassName?: string;
  onToggleStar?: () => void;
  onMarkAsRead?: (read: boolean) => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onSetTag?: (tagId: string | null) => void;
  onMarkAsSpam?: () => void;
  // When the email lives in a junk folder (incl. the aggregate "All Junk" view)
  // the spam quick-action flips to "not spam".
  isInJunk?: boolean;
  onUndoSpam?: () => void;
  // Hidden where marking spam is meaningless for self-authored mail (Drafts, Sent).
  spamApplicable?: boolean;
}

const ACTION_CONFIG: Record<HoverAction, {
  icon: typeof Trash2;
  titleKey: string;
  className?: string;
}> = {
  delete: {
    icon: Trash2,
    titleKey: "delete",
    className: "hover:text-red-600 dark:hover:text-red-400",
  },
  star: {
    icon: Star,
    titleKey: "star",
    className: "hover:text-amber-500 dark:hover:text-amber-400",
  },
  markRead: {
    icon: Mail,
    titleKey: "mark_read",
    className: "hover:text-blue-600 dark:hover:text-blue-400",
  },
  archive: {
    icon: Archive,
    titleKey: "archive",
    className: "hover:text-green-600 dark:hover:text-green-400",
  },
  tag: {
    icon: Tag,
    titleKey: "tag",
    className: "hover:text-purple-600 dark:hover:text-purple-400",
  },
  spam: {
    icon: ShieldAlert,
    titleKey: "spam",
    className: "hover:text-orange-600 dark:hover:text-orange-400",
  },
};

const CORNER_CLASSES = {
  'top-right': 'top-1 right-1',
  'top-left': 'top-1 left-1',
  'bottom-right': 'bottom-1 right-1',
  'bottom-left': 'bottom-1 left-1',
} as const;

/** Roughly the picker's height; used to flip it above the row near the viewport bottom. */
const TAG_PICKER_MAX_HEIGHT = 320;
const TAG_PICKER_WIDTH = 224;

export function EmailHoverActions({
  email,
  backgroundClassName = "bg-muted",
  onToggleStar,
  onMarkAsRead,
  onDelete,
  onArchive,
  onSetTag,
  onMarkAsSpam,
  isInJunk = false,
  onUndoSpam,
  spamApplicable = true,
}: EmailHoverActionsProps) {
  const hoverActions = useSettingsStore((state) => state.hoverActions);
  const hoverActionsMode = useSettingsStore((state) => state.hoverActionsMode);
  const hoverActionsCorner = useSettingsStore((state) => state.hoverActionsCorner);
  const t = useTranslations("settings.email_behavior.hover_actions");
  const isMobile = useIsMobile();

  // The tag quick-action opens the same picker the context menu and the reading
  // pane use. It is portalled to the body because every row sits inside a
  // `transform`ed virtual item, which would make a `fixed` child scroll with the
  // list and clip it at the scroller's edge.
  const [tagPickerPos, setTagPickerPos] = useState<{ top: number; left: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const tagButtonRef = useRef<HTMLElement | null>(null);
  const closeTagPicker = useCallback(() => setTagPickerPos(null), []);

  useEffect(() => {
    if (!tagPickerPos) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The anchor is left to its own click handler, which toggles the picker
      // shut - closing here first would let that click reopen it.
      if (tagButtonRef.current?.contains(target)) return;
      if (!pickerRef.current?.contains(target)) closeTagPicker();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTagPicker();
    };
    // The anchor moves with the list, so scrolling dismisses rather than chases
    // it - but the picker's own tag list scrolls too, and that must not close it.
    const onScroll = (event: Event) => {
      if (pickerRef.current?.contains(event.target as Node)) return;
      closeTagPicker();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", closeTagPicker);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", closeTagPicker);
    };
  }, [tagPickerPos, closeTagPicker]);

  const isUnread = !email.keywords?.$seen;
  const isStarred = email.keywords?.$flagged;
  const currentTagIds = getEmailTagIds(email.keywords);
  const hoverBackgroundClassName = backgroundClassName;

  if (isMobile) return null;
  if (hoverActions.length === 0) return null;

  const handleAction = (e: React.MouseEvent, action: HoverAction) => {
    e.stopPropagation();
    e.preventDefault();
    switch (action) {
      case "delete":
        onDelete?.();
        break;
      case "star":
        onToggleStar?.();
        break;
      case "markRead":
        onMarkAsRead?.(isUnread);
        break;
      case "archive":
        onArchive?.();
        break;
      case "tag": {
        // Previously this cleared every tag on the message, which is a no-op on
        // an untagged one - hence "clicking it does nothing". Open the picker.
        if (!onSetTag) break;
        tagButtonRef.current = e.currentTarget as HTMLElement;
        const rect = e.currentTarget.getBoundingClientRect();
        setTagPickerPos((open) =>
          open
            ? null
            : {
                top:
                  rect.bottom + TAG_PICKER_MAX_HEIGHT > window.innerHeight
                    ? Math.max(8, rect.top - TAG_PICKER_MAX_HEIGHT - 4)
                    : rect.bottom + 4,
                left: Math.max(
                  8,
                  Math.min(rect.left, window.innerWidth - TAG_PICKER_WIDTH - 8),
                ),
              },
        );
        break;
      }
      case "spam":
        if (isInJunk) onUndoSpam?.();
        else onMarkAsSpam?.();
        break;
    }
  };

  const actionButtons = hoverActions.map((actionId) => {
    const config = ACTION_CONFIG[actionId];
    if (!config) return null;
    if (actionId === "spam" && !spamApplicable) return null;
    const Icon = config.icon;

    // In a junk context the spam action becomes "not spam".
    const isNotSpam = actionId === "spam" && isInJunk;
    const DisplayIcon = actionId === "markRead"
      ? (isUnread ? MailOpen : Mail)
      : actionId === "star" && isStarred
        ? Star
        : isNotSpam
          ? ShieldCheck
          : Icon;
    const title = isNotSpam ? t("not_spam") : t(config.titleKey);
    const className = isNotSpam
      ? "hover:text-green-600 dark:hover:text-green-400"
      : config.className;

    return (
      <button
        key={actionId}
        type="button"
        data-testid={`hover-action-${actionId}`}
        onClick={(e) => handleAction(e, actionId)}
        onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
        title={title}
        aria-haspopup={actionId === "tag" ? "menu" : undefined}
        aria-expanded={actionId === "tag" ? tagPickerPos !== null : undefined}
        className={cn(
          "p-1.5 rounded-md transition-colors duration-100 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10",
          className,
        )}
      >
        <DisplayIcon
          className={cn(
            "w-4 h-4",
            actionId === "star" && isStarred && "fill-amber-400 text-amber-400",
          )}
        />
      </button>
    );
  });

  const tagPicker =
    tagPickerPos && onSetTag
      ? createPortal(
          <div
            ref={pickerRef}
            data-testid="hover-tag-picker"
            role="menu"
            className="fixed z-50 w-56 max-w-[18rem] rounded-lg border border-border bg-popover py-1 shadow-lg"
            style={{ top: tagPickerPos.top, left: tagPickerPos.left }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <TagPicker
              selectedIds={currentTagIds}
              onToggle={(tagId) => onSetTag(tagId)}
            />
          </div>,
          document.body,
        )
      : null;

  // While the picker is open the row is no longer hovered, so the toolbar has to
  // stay mounted and visible or the picker would close under its own anchor.
  const visibilityClass = tagPickerPos ? "flex" : "hidden group-hover:flex";

  if (hoverActionsMode === 'floating') {
    return (
      <div
        className={cn(
          "absolute z-10 items-center",
          visibilityClass,
          CORNER_CLASSES[hoverActionsCorner],
        )}
      >
        <div className="relative flex items-center rounded-lg shadow-md border border-border overflow-hidden bg-background">
          <div className={cn("absolute inset-0", hoverBackgroundClassName)} />
          <div className="relative flex items-center gap-0.5 px-1.5 py-0.5">
            {actionButtons}
          </div>
        </div>
        {tagPicker}
      </div>
    );
  }

  return (
    <div
      className={cn("absolute end-0 top-0 bottom-0 z-10 items-center", visibilityClass)}
    >
      <div
        className={cn(
          "relative w-8 h-full bg-background",
          "[mask-image:linear-gradient(to_right,transparent,black)] [-webkit-mask-image:linear-gradient(to_right,transparent,black)]",
          "rtl:[mask-image:linear-gradient(to_left,transparent,black)] rtl:[-webkit-mask-image:linear-gradient(to_left,transparent,black)]",
        )}
      >
        <div className={cn("absolute inset-0", hoverBackgroundClassName)} />
      </div>
      <div className="relative flex items-center h-full bg-background">
        <div className={cn("absolute inset-0", hoverBackgroundClassName)} />
        <div className="relative flex items-center gap-0.5 h-full pe-3 ps-0.5">
          {actionButtons}
        </div>
      </div>
      {tagPicker}
    </div>
  );
}
