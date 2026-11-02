"use client";

import { useTranslations } from "next-intl";
import { cn, formatFileSize } from "@/lib/utils";
import { LIST_COLUMN_CLASS } from "@/hooks/use-list-row-shape";
import type { Density } from "@/stores/settings-store";

/**
 * The width of what leads a list row before its From cell: the small avatar,
 * or under extra-compact the checkbox once something is ticked (nothing
 * otherwise). The header and the message sub-rows reserve the same width so
 * their columns start where the rows' do.
 */
export function listLeadClass(density: Density, selecting: boolean): string | null {
  if (density !== 'extra-compact') return 'w-8';
  return selecting ? 'w-10 lg:w-6' : null;
}

/** The Size column: the message's size on the server, or a conversation's total. */
export function SizeCell({ bytes }: { bytes: number }) {
  return (
    <span data-list-size="" className={cn(LIST_COLUMN_CLASS.size, 'text-xs tabular-nums text-muted-foreground')}>
      {formatFileSize(bytes)}
    </span>
  );
}

/**
 * The column titles above the rows when the list is drawn as a table (#262).
 * It mirrors a row's layout (padding, lead, gaps) so each title sits over its
 * column.
 */
export function ListColumnsHeader({ density, selecting, showRecipient }: {
  density: Density;
  selecting: boolean;
  /** Sent and Drafts list who a message went to, not who sent it. */
  showRecipient: boolean;
}) {
  const t = useTranslations('email_list.columns');
  const lead = listLeadClass(density, selecting);
  return (
    <div
      data-memail-list-columns=""
      data-testid="list-columns-header"
      className="flex items-center border-b border-border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground"
      // The rows sit in a scroller; keep the scrollbar's width free here too.
      style={{ gap: 'var(--density-item-gap)', scrollbarGutter: 'stable', overflowY: 'hidden' }}
    >
      {lead && <span aria-hidden="true" className={cn(lead, 'shrink-0')} />}
      <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className={cn(LIST_COLUMN_CLASS.from, 'flex items-center gap-2')}>
            <span aria-hidden="true" className="w-3.5 shrink-0" />
            <span className="truncate">{showRecipient ? t('to') : t('from')}</span>
          </span>
          <span className="min-w-0 flex-1 truncate">{t('subject')}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className={LIST_COLUMN_CLASS.date}>{t('date')}</span>
          <span className={LIST_COLUMN_CLASS.size}>{t('size')}</span>
        </div>
      </div>
    </div>
  );
}
