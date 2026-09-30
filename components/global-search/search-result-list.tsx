"use client";

import { AlertTriangle, Loader2 } from "@/components/icons";
import { useTranslations } from "next-intl";
import { compareByRecency } from "@/lib/global-search/rank";
import { hitKey, SEARCH_KINDS, type GlobalSearchHit, type SearchKind, type SearchOutcome } from "@/lib/global-search/types";
import { cn } from "@/lib/utils";
import { PaletteResultRow } from "@/components/global-search/palette-result-row";

export interface SearchResultListProps {
  outcome: SearchOutcome;
  kinds: readonly SearchKind[];
  /** Flat = one list, newest first; grouped = a section per kind. */
  flat: boolean;
  selectedKey: string | null;
  onSelect: (hit: GlobalSearchHit) => void;
  /** Double-click: open the hit on its full surface. */
  onOpen: (hit: GlobalSearchHit) => void;
  onLoadMoreMail: () => void;
}

function Row({ hit, selected, onSelect, onOpen }: {
  hit: GlobalSearchHit;
  selected: boolean;
  onSelect: (hit: GlobalSearchHit) => void;
  onOpen: (hit: GlobalSearchHit) => void;
}) {
  return (
    <div onDoubleClick={() => onOpen(hit)}>
      <PaletteResultRow hit={hit} onOpen={onSelect} className={cn("rounded-none", selected && "bg-accent hover:bg-accent")} />
    </div>
  );
}

/** Result list of the search tab. Single click previews, double click opens. */
export function SearchResultList({ outcome, kinds, flat, selectedKey, onSelect, onOpen, onLoadMoreMail }: SearchResultListProps) {
  const t = useTranslations('global_search');

  const errorRows = (kind: SearchKind) => outcome.status[kind].errors.map((error) => (
    <div key={`${kind}-${error.localAccountId}`} className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-500" />
      {t('account_error', { account: error.accountLabel })}
    </div>
  ));

  if (flat) {
    const all = kinds.flatMap((kind) => outcome.hits[kind]).sort(compareByRecency);
    return (
      <div className="py-1">
        {all.map((hit) => (
          <Row key={hitKey(hit)} hit={hit} selected={selectedKey === hitKey(hit)} onSelect={onSelect} onOpen={onOpen} />
        ))}
        {SEARCH_KINDS.filter((kind) => kinds.includes(kind)).flatMap((kind) => errorRows(kind))}
        {outcome.status.mail.hasMore && kinds.includes('mail') && (
          <button type="button" onClick={onLoadMoreMail} className="w-full px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer">
            {t('load_more')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="py-1">
      {kinds.map((kind) => {
        const hits = outcome.hits[kind];
        const status = outcome.status[kind];
        if (hits.length === 0 && status.errors.length === 0 && status.status !== 'loading') return null;
        return (
          <section key={kind} className="pb-2">
            <h3 className="flex items-center gap-2 px-3 pt-3 pb-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider sticky top-0 z-10 bg-background">
              {t(`scope_${kind}`)}
              <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold tabular-nums normal-case">
                {hits.length}{status.hasMore ? '+' : ''}
              </span>
              {status.status === 'loading' && <Loader2 className="w-3 h-3 animate-spin" aria-label={t('searching')} />}
            </h3>
            {hits.map((hit) => (
              <Row key={hitKey(hit)} hit={hit} selected={selectedKey === hitKey(hit)} onSelect={onSelect} onOpen={onOpen} />
            ))}
            {errorRows(kind)}
            {kind === 'mail' && status.hasMore && (
              <button type="button" onClick={onLoadMoreMail} className="w-full px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer">
                {t('load_more')}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
