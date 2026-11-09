"use client";

import { useTranslations } from "next-intl";
import type { SearchScope } from "@/lib/global-search/query-parser";
import { SEARCH_KINDS, type SearchKind } from "@/lib/global-search/types";
import { cn } from "@/lib/utils";

export interface SearchFacetsProps {
  scope: SearchScope;
  onScopeChange: (scope: SearchScope) => void;
  kindCounts: Record<SearchKind, number>;
  /** '+' suffix on the count (the server reported more than was fetched). */
  kindHasMore: Record<SearchKind, boolean>;
  accounts: Array<{ localAccountId: string; label: string; count: number }>;
  accountId: string | null;
  onAccountChange: (accountId: string | null) => void;
  flat: boolean;
  onFlatChange: (flat: boolean) => void;
}

/** Section title, styled like the mail sidebar's section rows. */
function FacetSection({ title, first, children }: { title: string; first?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <div className={cn("px-3 pb-1", first ? "pt-3" : "pt-5")}>
        <span className="text-xs font-semibold text-muted-foreground truncate">{title}</span>
      </div>
      {children}
    </section>
  );
}

/** One facet row, styled like a mail sidebar folder row (start-border selection marker). */
function FacetButton({ active, label, count, onClick }: { active: boolean; label: string; count?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{ paddingBlock: 'var(--density-sidebar-py)' }}
      className={cn(
        "w-full flex items-center gap-2 ps-3 pe-2 text-sm text-left transition-colors duration-150 cursor-pointer",
        "tap:min-h-[44px] border-s-2",
        active
          ? "bg-accent text-accent-foreground font-semibold border-primary"
          : "hover:bg-muted/50 text-foreground border-transparent",
      )}
    >
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className={cn("shrink-0 text-xs tabular-nums", active ? "font-semibold text-accent-foreground" : "text-muted-foreground")}>{count}</span>
      )}
    </button>
  );
}

/** Facet column of the search tab: result kind, account, grouped/flat order. */
export function SearchFacets({
  scope, onScopeChange, kindCounts, kindHasMore,
  accounts, accountId, onAccountChange,
  flat, onFlatChange,
}: SearchFacetsProps) {
  const t = useTranslations('global_search');
  const total = SEARCH_KINDS.reduce((sum, kind) => sum + kindCounts[kind], 0);
  const anyMore = SEARCH_KINDS.some((kind) => kindHasMore[kind]);
  return (
    <div className="flex flex-col pb-3 overflow-y-auto">
      <FacetSection title={t('scope_label')} first>
        <FacetButton
          active={scope === 'all'}
          label={t('scope_all')}
          count={`${total}${anyMore ? '+' : ''}`}
          onClick={() => onScopeChange('all')}
        />
        {SEARCH_KINDS.map((kind) => (
          <FacetButton
            key={kind}
            active={scope === kind}
            label={t(`scope_${kind}`)}
            count={`${kindCounts[kind]}${kindHasMore[kind] ? '+' : ''}`}
            onClick={() => onScopeChange(kind)}
          />
        ))}
      </FacetSection>

      {accounts.length > 1 && (
        <FacetSection title={t('account_label')}>
          <FacetButton active={accountId === null} label={t('all_accounts')} onClick={() => onAccountChange(null)} />
          {accounts.map((account) => (
            <FacetButton
              key={account.localAccountId}
              active={accountId === account.localAccountId}
              label={account.label}
              count={String(account.count)}
              onClick={() => onAccountChange(account.localAccountId)}
            />
          ))}
        </FacetSection>
      )}

      <FacetSection title={t('view_label')}>
        <FacetButton active={!flat} label={t('grouped')} onClick={() => onFlatChange(false)} />
        <FacetButton active={flat} label={t('flat_by_date')} onClick={() => onFlatChange(true)} />
      </FacetSection>
    </div>
  );
}
