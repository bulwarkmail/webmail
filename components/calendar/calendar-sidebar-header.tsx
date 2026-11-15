"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Plus } from "@/components/icons";

interface CalendarSidebarHeaderProps {
  onCreateEvent: () => void;
  /** The create button's name: what it makes in the current view. */
  createLabel?: string;
  /** Mark the button for the guided tour; off while the toolbar's own "+" is the visible one. */
  tourTarget?: boolean;
  /** The app's name, when it isn't the calendar (the Tasks app). */
  title?: string;
}

/**
 * Title row at the top of the calendar sidebar, the same shape as the
 * contacts sidebar header: the app name on the left and "+" on the right.
 */
export function CalendarSidebarHeader({ onCreateEvent, createLabel, tourTarget = true, title }: CalendarSidebarHeaderProps) {
  const t = useTranslations("calendar");
  const label = createLabel ?? t("events.create");

  return (
    // Same h-14 box as the mail sidebar's account switcher, so the apps line up;
    // box-content keeps the border outside it, as in mail.
    <div className="px-3 h-14 box-content border-b border-border flex items-center justify-between flex-shrink-0">
      <span className="text-sm font-semibold truncate">{title ?? t("title")}</span>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onCreateEvent}
        className="flex-shrink-0"
        aria-label={label}
        title={label}
        data-tour={tourTarget ? "create-event-button" : undefined}
      >
        <Plus className="w-4 h-4" />
      </Button>
    </div>
  );
}
