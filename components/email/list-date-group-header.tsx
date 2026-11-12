"use client";

import { ChevronDown, ChevronRight } from "@/components/icons";
import { cn } from "@/lib/utils";

/** The list's row height for a date header; estimateSize in EmailList returns it. */
export const LIST_DATE_GROUP_HEADER_HEIGHT = 36;

interface ListDateGroupHeaderProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
}

/** A date group of the message list ("Today", "Yesterday", ...), folding as in Outlook. */
export function ListDateGroupHeader({ title, collapsed, onToggle }: ListDateGroupHeaderProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="flex h-9 items-center border-b border-border px-2" data-list-date-group="">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex min-w-0 items-center gap-2 rounded-md py-1 ps-2 pe-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Chevron className={cn("h-4 w-4 shrink-0", collapsed && "rtl:rotate-180")} />
        <span className="truncate">{title}</span>
      </button>
    </div>
  );
}
