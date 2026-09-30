"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "@/components/icons";
import { useTranslations } from "next-intl";
import { useGlobalSearch } from "@/hooks/use-global-search";
import { openHit } from "@/lib/global-search/open-hit";
import type { SearchScope } from "@/lib/global-search/query-parser";
import { hitKey, SEARCH_KINDS, type GlobalSearchHit, type SearchKind } from "@/lib/global-search/types";
import { useAccountStore } from "@/stores/account-store";
import { useProTabStore, type ProSearchTabData } from "@/stores/pro-tab-store";
import { useSearchHistoryStore } from "@/stores/search-history-store";
import { SearchFacets } from "@/components/global-search/search-facets";
import { SearchPreview } from "@/components/global-search/search-preview";
import { SearchResultList } from "@/components/global-search/search-result-list";

export const SEARCH_TAB_REMOTE_LIMIT = 100;
export const SEARCH_TAB_LOCAL_LIMIT = 50;

export interface SearchTabBodyProps {
  tabId: string;
  data: ProSearchTabData;
}

/**
 * The full search-results tab (plan §3.2): facets · grouped result list ·
 * preview pane. The submitted query lives on the tab (it survives reloads);
 * editing it here re-runs the search and renames the tab. Folder navigation
 * in a mail tab never touches this tab - the Pro-side answer to #923.
 */
export function SearchTabBody({ tabId, data }: SearchTabBodyProps) {
  const t = useTranslations('global_search');
  const updateSearchTab = useProTabStore((s) => s.updateSearchTab);
  const addRecentSearch = useSearchHistoryStore((s) => s.addRecentSearch);

  const [draft, setDraft] = useState(data.query);
  useEffect(() => setDraft(data.query), [data.query]);
  const [flat, setFlat] = useState(false);
  const [selected, setSelected] = useState<GlobalSearchHit | null>(null);

  const { outcome, parsed, isSearching, loadMoreMail } = useGlobalSearch({
    query: data.query,
    scope: data.scope,
    accountId: data.accountId,
    localLimit: SEARCH_TAB_LOCAL_LIMIT,
    remoteLimit: SEARCH_TAB_REMOTE_LIMIT,
    debounceMs: 50,
  });

  // A new query invalidates the previewed hit.
  useEffect(() => setSelected(null), [data.query, data.scope, data.accountId]);

  const accounts = useAccountStore((s) => s.accounts);
  const accountFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const kind of SEARCH_KINDS) {
      for (const hit of outcome.hits[kind]) {
        counts.set(hit.localAccountId, (counts.get(hit.localAccountId) ?? 0) + 1);
      }
    }
    return accounts
      .filter((a) => a.isConnected)
      .map((a) => ({ localAccountId: a.id, label: a.label || a.email, count: counts.get(a.id) ?? 0 }));
  }, [accounts, outcome]);

  const kindCounts = useMemo(() => {
    const counts = {} as Record<SearchKind, number>;
    const more = {} as Record<SearchKind, boolean>;
    for (const kind of SEARCH_KINDS) {
      counts[kind] = outcome.hits[kind].length;
      more[kind] = outcome.status[kind].hasMore;
    }
    return { counts, more };
  }, [outcome]);

  const kinds = useMemo(
    () => SEARCH_KINDS.filter((kind) => parsed.scope === 'all' || parsed.scope === kind),
    [parsed.scope],
  );

  const submitDraft = () => {
    const query = draft.trim();
    if (!query || query === data.query) return;
    addRecentSearch(query);
    updateSearchTab(tabId, { query, title: query });
  };

  const setScope = (scope: SearchScope) => updateSearchTab(tabId, { scope });
  const setAccountId = (accountId: string | null) => updateSearchTab(tabId, { accountId });
  const handleOpen = (hit: GlobalSearchHit) => { void openHit(hit, { proShell: true }); };

  return (
    <div className="flex h-full min-h-0 w-full bg-background">
      <aside className="w-56 shrink-0 bg-secondary border-e border-border overflow-y-auto">
        <SearchFacets
          scope={data.scope}
          onScopeChange={setScope}
          kindCounts={kindCounts.counts}
          kindHasMore={kindCounts.more}
          accounts={accountFacets}
          accountId={data.accountId}
          onAccountChange={setAccountId}
          flat={flat}
          onFlatChange={setFlat}
        />
      </aside>

      <section className="flex-1 lg:flex-none lg:w-96 min-w-0 flex flex-col border-e border-border">
        <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border px-3">
          <Search className="w-4 h-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitDraft(); }}
            onBlur={submitDraft}
            aria-label={t('title')}
            placeholder={t('placeholder')}
            className="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          {isSearching && <Loader2 className="w-4 h-4 shrink-0 animate-spin text-muted-foreground" aria-label={t('searching')} />}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <SearchResultList
            outcome={outcome}
            kinds={kinds}
            flat={flat}
            selectedKey={selected ? hitKey(selected) : null}
            onSelect={setSelected}
            onOpen={handleOpen}
            onLoadMoreMail={loadMoreMail}
          />
          {kinds.every((kind) => outcome.hits[kind].length === 0) && !isSearching && (
            <div className="px-3 py-8 text-center">
              <p className="text-sm text-foreground">{t('no_results', { query: data.query })}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('server_hint')}</p>
            </div>
          )}
        </div>
      </section>

      <aside className="hidden lg:block flex-1 min-w-0 overflow-y-auto">
        <SearchPreview hit={selected} onOpen={handleOpen} onClose={() => setSelected(null)} />
      </aside>
    </div>
  );
}
