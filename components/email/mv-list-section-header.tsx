"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "@/components/icons";

interface MvListSectionHeaderProps {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Rows the section shows and how many it has in all, for the range readout. */
  shown: number;
  total: number;
  /** Where the shown rows start among all of them (0 is the first). */
  position?: number;
  /**
   * Arrows to page through the section, as Gmail has them (#1791): drawn
   * when `paged`, each one only working while it has a handler.
   */
  paged?: boolean;
  onNewer?: () => Promise<void> | void;
  onOlder?: () => Promise<void> | void;
}

const ARROW_CLASS =
  "grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";

/** A section of Mountain View's "Unread first" inbox: "Unread" or "Everything else", folding as in Gmail. */
export function MvListSectionHeader({ title, collapsed, onToggle, shown, total, position = 0, paged = false, onNewer, onOlder }: MvListSectionHeaderProps) {
  const t = useTranslations("email_list");
  const [paging, setPaging] = useState(false);
  const Chevron = collapsed ? ChevronDown : ChevronUp;
  const page = async (step: (() => Promise<void> | void) | undefined) => {
    if (!step || paging) return;
    setPaging(true);
    try {
      await step();
    } finally {
      setPaging(false);
    }
  };
  return (
    <div className="flex h-12 items-center border-b border-border px-2" data-mv-list-section="">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex min-w-0 items-center gap-3 rounded-full py-1.5 ps-2 pe-3 text-base font-medium text-foreground hover:bg-muted"
      >
        <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{title}</span>
      </button>
      <div className="flex-1" />
      {shown > 0 && (
        <span className={paged ? "shrink-0 pe-1 text-xs tabular-nums text-muted-foreground" : "shrink-0 pe-3 text-xs tabular-nums text-muted-foreground"}>
          {t("conversations_range", { from: position + 1, to: position + shown, total: Math.max(total, position + shown) })}
        </span>
      )}
      {paged && (
        <>
          <button
            type="button"
            onClick={() => void page(onNewer)}
            disabled={!onNewer || paging}
            className={ARROW_CLASS}
            title={t("sections.unread_newer")}
            aria-label={t("sections.unread_newer")}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void page(onOlder)}
            disabled={!onOlder || paging}
            className={ARROW_CLASS}
            title={t("sections.unread_older")}
            aria-label={t("sections.unread_older")}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}
