"use client";

import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp } from "@/components/icons";

interface MvListSectionHeaderProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Rows the section shows and how many it has in all, for the range readout. */
  shown: number;
  total: number;
}

/** A section of Mountain View's "Unread first" inbox: "Unread" or "Everything else", folding as in Gmail. */
export function MvListSectionHeader({ title, collapsed, onToggle, shown, total }: MvListSectionHeaderProps) {
  const t = useTranslations("email_list");
  const Chevron = collapsed ? ChevronDown : ChevronUp;
  return (
    <div className="flex h-12 items-center border-b border-border bg-list-section px-2" data-mv-list-section="">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex min-w-0 items-center gap-3 rounded-full py-1.5 ps-2 pe-3 text-base font-medium text-list-section-foreground hover:bg-[color-mix(in_srgb,var(--color-list-section-foreground)_10%,var(--color-list-section))]"
      >
        <Chevron className="h-4 w-4 shrink-0" />
        <span className="truncate">{title}</span>
      </button>
      <div className="flex-1" />
      {shown > 0 && (
        <span className="shrink-0 pe-3 text-xs tabular-nums text-list-section-foreground">
          {t("conversations_range", { from: 1, to: shown, total: Math.max(total, shown) })}
        </span>
      )}
    </div>
  );
}
