"use client";

import { useMemo } from "react";
import { Email } from "@/lib/jmap/types";
import { useSettingsStore } from "@/stores/settings-store";
import type { HoverAction } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { Trash2, Star, Mail, MailOpen, Archive, Inbox, Tag, ShieldAlert, ShieldCheck } from "@/components/icons";
import { mailboxesInView, useEmailStore } from "@/stores/email-store";
import { archiveInboxTarget } from "@/lib/archive-inbox";
import { useArchiveActionEnabled, withoutArchiveIfOff } from "@/lib/archive-gate";
import { useTranslations } from "next-intl";
import { useIsMobile } from "@/hooks/use-media-query";
import { TagPicker } from "@/components/email/tag-picker";
import { ContextMenu } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useEmailTagScope } from "@/hooks/use-account-tags";
import { getEmailTagIds } from "@/lib/thread-utils";
import { PluginActions, useMessageActionTarget, usePluginActions, useRowActionTarget } from "@/components/plugins/plugin-actions";
import { usePluginRowBadges } from "@/components/email/plugin-row-badges";

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
  /** Role of the folder the row is listed in; plugin buttons can be limited to some. */
  mailboxRole?: string | null;
  /**
   * Keep the actions on the row's first 40px line rather than centred on the
   * whole row, as Gmail does when attachment chips make the row taller.
   */
  pinToFirstLine?: boolean;
}

const ACTION_CONFIG: Record<HoverAction, {
  icon: typeof Trash2;
  titleKey: string;
  className?: string;
}> = {
  delete: {
    icon: Trash2,
    titleKey: "delete",
    className: "hover:text-destructive",
  },
  star: {
    icon: Star,
    titleKey: "star",
    className: "hover:text-foreground",
  },
  markRead: {
    icon: Mail,
    titleKey: "mark_read",
    className: "hover:text-foreground",
  },
  archive: {
    icon: Archive,
    titleKey: "archive",
    className: "hover:text-foreground",
  },
  tag: {
    icon: Tag,
    titleKey: "tag",
    className: "hover:text-foreground",
  },
  spam: {
    icon: ShieldAlert,
    titleKey: "spam",
    className: "hover:text-foreground",
  },
};

/** The quick actions as shipped, before the user reorders them. */
const DEFAULT_HOVER_ACTIONS: readonly HoverAction[] = ['delete', 'star', 'markRead', 'archive'];
/** Gmail's row actions, in Gmail's order. */
const MOUNTAIN_VIEW_HOVER_ACTIONS: readonly HoverAction[] = ['archive', 'delete', 'markRead'];

/**
 * The actions a Mountain View row shows on hover: Gmail's set while the user
 * has not chosen their own, and never the star, which the row already leads
 * with.
 */
export function mountainViewHoverActions(configured: readonly HoverAction[]): HoverAction[] {
  const isDefault = configured.length === DEFAULT_HOVER_ACTIONS.length
    && configured.every((action, i) => action === DEFAULT_HOVER_ACTIONS[i]);
  return (isDefault ? MOUNTAIN_VIEW_HOVER_ACTIONS : configured).filter((action) => action !== 'star');
}

const CORNER_CLASSES = {
  'top-right': 'top-1 right-1',
  'top-left': 'top-1 left-1',
  'bottom-right': 'bottom-1 right-1',
  'bottom-left': 'bottom-1 left-1',
} as const;

/** Roughly the picker's height; used to flip it above the row near the viewport bottom. */

/** How far the inline strip keeps off the row's edges: the width of the row's outline. */
const STRIP_INSET = "var(--focus-ring-width, 2px)";

/**
 * Tells the row how wide the shown strip is: `--row-actions-w` and
 * `data-hover-actions-shown` on the row (the `[data-menu-row]` around it),
 * while the strip is on screen. In a right-to-left list the row's text keeps
 * clear of it by that much (globals.css), so a left-aligned English subject
 * isn't hidden under the buttons (mail-p3-10).
 *
 * A ref callback with a cleanup, defined once here so React calls it only
 * when the strip comes and goes. Holding the element in state cost every
 * row that mounts a second render pass (a search's results, a new folder).
 */
function reserveRowRoom(actions: HTMLDivElement | null): (() => void) | void {
  const row = actions?.closest<HTMLElement>("[data-menu-row]");
  if (!actions || !row) return;
  const apply = () => {
    const width = actions.offsetWidth;
    if (width > 0) {
      row.style.setProperty("--row-actions-w", `${width}px`);
      row.setAttribute("data-hover-actions-shown", "");
    } else {
      row.removeAttribute("data-hover-actions-shown");
    }
  };
  apply();
  if (typeof ResizeObserver === "undefined") return () => row.removeAttribute("data-hover-actions-shown");
  // Shown and hidden by CSS (hover, keyboard focus): its size says which.
  const observer = new ResizeObserver(apply);
  observer.observe(actions);
  return () => {
    observer.disconnect();
    row.removeAttribute("data-hover-actions-shown");
  };
}

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
  mailboxRole = null,
  pinToFirstLine = false,
}: EmailHoverActionsProps) {
  const tagScope = useEmailTagScope(email);
  const configuredHoverActions = useSettingsStore((state) => state.hoverActions);
  const mountainView = useSettingsStore((state) => state.interfaceLayout === 'mountain-view');
  const archiveActionEnabled = useArchiveActionEnabled();
  const hoverActions = withoutArchiveIfOff(
    mountainView ? mountainViewHoverActions(configuredHoverActions) : configuredHoverActions,
    archiveActionEnabled,
  );
  const hoverActionsMode = useSettingsStore((state) => state.hoverActionsMode);
  const hoverActionsCorner = useSettingsStore((state) => state.hoverActionsCorner);
  // The words the row's menu uses for the same actions (R10).
  const t = useTranslations("context_menu");
  const tP3 = useTranslations("mail_p3_actions");
  // In Archive the archive button brings mail back to the Inbox, as the row
  // menu's entry in its place does (mail-p3-4). The folder on screen is one
  // of the browsed login's (mailboxesInView), as Archive itself decides.
  const archiveMovesToInbox = useEmailStore((state) => !!archiveInboxTarget(mailboxesInView(state), state.selectedMailbox));
  const isMobile = useIsMobile();
  // Buttons plugins add to the row (message-row-actions), after the app's own.
  // The row's badges too, for actions shown by a plugin's badge (hasBadge).
  const pluginTarget = useRowActionTarget(useMessageActionTarget(email), usePluginRowBadges(email));
  const pluginActionCount = usePluginActions("message-row-actions", {
    mailboxRole, accountKind: pluginTarget.accountKind, keywords: pluginTarget.keywords, badges: pluginTarget.badges,
  }).length;
  const pluginContext = useMemo(() => ({ emailId: email.id }), [email.id]);

  // The tag quick-action opens the same picker the context menu and the reading
  // pane use. It is portalled to the body because every row sits inside a
  // `transform`ed virtual item, which would make a `fixed` child scroll with the
  // list and clip it at the scroller's edge.
  // The app's menu, under the button, with the picker in it.
  const tagMenu = useContextMenu<null>();
  const tagPickerOpen = tagMenu.contextMenu.isOpen;

  const isUnread = !email.keywords?.$seen;
  const isStarred = email.keywords?.$flagged;
  const currentTagIds = getEmailTagIds(email.keywords);
  const hoverBackgroundClassName = backgroundClassName;

  if (isMobile) return null;
  if (hoverActions.length === 0 && pluginActionCount === 0) return null;

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
        if (tagPickerOpen) tagMenu.closeContextMenu();
        else tagMenu.openContextMenuFrom(e.currentTarget as HTMLElement, null, "start");
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
          : actionId === "archive" && archiveMovesToInbox
            ? Inbox
            : Icon;
    const title = isNotSpam ? t("not_spam")
      : actionId === "markRead" ? t(isUnread ? "mark_read" : "mark_unread")
      : actionId === "star" ? t(isStarred ? "unstar" : "star")
      : actionId === "spam" ? t("mark_as_spam")
      : actionId === "archive" && archiveMovesToInbox ? tP3("move_to_inbox")
      : t(config.titleKey);
    const className = isNotSpam
      ? "hover:text-foreground"
      : config.className;

    return (
      <button
        key={actionId}
        type="button"
        data-testid={`hover-action-${actionId}`}
        onClick={(e) => handleAction(e, actionId)}
        onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
        title={title}
        aria-label={title}
        aria-haspopup={actionId === "tag" ? "menu" : undefined}
        aria-expanded={actionId === "tag" ? tagPickerOpen : undefined}
        className={cn(
          "transition-colors duration-100 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10",
          // Gmail's are round 40px targets that darken rather than change hue.
          mountainView ? "p-2 rounded-full hover:text-foreground" : cn("p-1.5 rounded-md", className),
        )}
      >
        <DisplayIcon
          className={cn(
            mountainView ? "w-5 h-5" : "w-4 h-4",
            actionId === "star" && isStarred && "fill-amber-400 text-amber-400",
          )}
        />
      </button>
    );
  });
  if (pluginActionCount > 0) {
    actionButtons.push(
      // In a narrow list the row's menu has these: all of them in a row would
      // lie over the avatar, where a click meant to select hits Delete.
      <div key="plugin-actions" className="hidden @[20rem]/mail-row:flex">
        <PluginActions
          surface="message-row-actions"
          context={pluginContext}
          target={pluginTarget}
          mailboxRole={mailboxRole}
          compact
          className="flex-nowrap gap-0.5"
        />
      </div>,
    );
  }

  const tagPicker = onSetTag ? (
    <ContextMenu
      ref={tagMenu.menuRef}
      isOpen={tagPickerOpen}
      position={tagMenu.contextMenu.position}
      onClose={tagMenu.closeContextMenu}
      label={t("tag")}
    >
      {/* The menu is rendered in a portal, but React still bubbles its clicks to the row. */}
      <div
        data-testid="hover-tag-picker"
        className="w-56 max-w-[18rem]"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <TagPicker selectedIds={currentTagIds} scope={tagScope} onToggle={(tagId) => onSetTag(tagId)} />
      </div>
    </ContextMenu>
  ) : null;

  // While the picker is open the row is no longer hovered, so the toolbar has to
  // stay mounted and visible or the picker would close under its own anchor.
  // Shown on keyboard focus too (R7), not only on hover. Only a control inside
  // the row counts, and only from the keyboard: a click focuses the row itself
  // (or the button clicked), and focus-within kept the toolbar on the open row.
  const visibilityClass = tagPickerOpen ? "flex" : "hidden group-hover:flex group-has-[:focus-visible]:flex";

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
    // Inset by the focus ring's width: the row's own outline (keyboard focus,
    // menu open) stays drawn around the strip instead of fading out under its
    // edge, which in dark mode read as a lighter strip on the blue (mail-p3-14).
    <div
      className={cn("absolute z-10 items-center", pinToFirstLine && "h-10", visibilityClass)}
      style={{ insetInlineEnd: STRIP_INSET, top: STRIP_INSET, bottom: pinToFirstLine ? undefined : STRIP_INSET }}
      data-hover-strip=""
      ref={reserveRowRoom}
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
