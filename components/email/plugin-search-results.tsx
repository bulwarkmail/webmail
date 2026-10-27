"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "@/components/icons";
import { cn } from "@/lib/utils";
import { isFilterEmpty } from "@/lib/jmap/search-utils";
import { runPluginAction } from "@/lib/plugin-sandbox/actions";
import type { ProvidedSearchResult } from "@/lib/plugin-search-results";
import type { SearchResultEmail } from "@/lib/plugin-types";
import type { Email } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { usePluginStore } from "@/stores/plugin-store";

interface Group {
  id: string;
  heading: string;
  results: ProvidedSearchResult[];
}

/** One group per plugin and source, in the order the entries came. */
function groupResults(results: ProvidedSearchResult[], pluginName: (id: string) => string): Group[] {
  const groups = new Map<string, Group>();
  for (const r of results) {
    const id = `${r.pluginId}\u0000${r.source ?? ""}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, heading: r.source ?? pluginName(r.pluginId), results: [] };
      groups.set(id, group);
    }
    group.results.push(r);
  }
  return [...groups.values()];
}

/** A message as the reader opens one that is not a row of the list: the login reaching it and its account. */
export type OpenableEmail = Required<Pick<Email, "id" | "sourceClientAccountId" | "sourceAccountId">>;

/**
 * The login through which the user reaches a message an entry names, the
 * active one first; null when none does (an account the user cannot read).
 * Without an account the message is the active login's own.
 */
export function reachableEmail(email: SearchResultEmail): OpenableEmail | null {
  const auth = useAuthStore.getState();
  const clients = [...auth.getAllConnectedClients()]
    .sort(([a], [b]) => Number(b === auth.activeAccountId) - Number(a === auth.activeAccountId));
  for (const [login, client] of clients) {
    if (!email.accountId) {
      return login === auth.activeAccountId
        ? { id: email.id, sourceClientAccountId: login, sourceAccountId: client.getAccountId() }
        : null;
    }
    const reaches = client.getAccountId() === email.accountId
      || client.getSharedAccounts().some((a) => a.id === email.accountId && a.capabilities.mail);
    if (reaches) return { id: email.id, sourceClientAccountId: login, sourceAccountId: email.accountId };
  }
  return null;
}

/** The active login's own account. */
function ownAccountId(): string | undefined {
  const auth = useAuthStore.getState();
  return auth.activeAccountId ? auth.getAllConnectedClients().get(auth.activeAccountId)?.getAccountId() : undefined;
}

/**
 * Whether the message open in the reader is the one an entry names. JMAP ids
 * are unique per account only, so the accounts are compared too, a missing
 * one being the active login's own.
 */
function isOpen(email: SearchResultEmail | undefined, open: Email | null): boolean {
  if (!email || !open || open.id !== email.id) return false;
  const own = ownAccountId();
  return (open.sourceAccountId ?? own) === (email.accountId ?? own);
}

interface PluginSearchResultsProps {
  /** Entries plugins return from onProvideSearchResults; a click is the plugin's onAction. */
  surface: "search-results";
  /** Opens a message in the reader, as a click on a list row does; without it every click is onAction. */
  onOpenEmail?: (email: OpenableEmail) => void;
}

/**
 * Results from elsewhere for the search that is running (CRM hits, chat
 * messages, ...), above its message list. Renders nothing outside a search or
 * without entries. A click on an entry naming a message the user reaches opens
 * it; any other goes back to the plugin that gave the entry.
 */
export function PluginSearchResults({ surface, onOpenEmail }: PluginSearchResultsProps) {
  const results = useEmailStore((s) => s.externalSearchResults);
  const openEmail = useEmailStore((s) => s.selectedEmail);
  const query = useEmailStore((s) => s.searchQuery);
  const searching = useEmailStore((s) => !!s.searchQuery.trim() || !isFilterEmpty(s.searchFilters));
  const plugins = usePluginStore((s) => s.plugins);
  const idPrefix = useId();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const groups = useMemo(
    () => groupResults(results, (id) => plugins.find((p) => p.id === id)?.name ?? id),
    [results, plugins],
  );

  if (!searching || groups.length === 0) return null;

  const click = (r: ProvidedSearchResult) => {
    const reachable = r.email && onOpenEmail ? reachableEmail(r.email) : null;
    if (reachable) onOpenEmail?.(reachable);
    else void runPluginAction(r.pluginId, surface, r.key, { query });
  };

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div data-plugin-surface={surface} className="max-h-[40%] flex-shrink-0 overflow-y-auto border-b border-border bg-muted/30">
      {groups.map((group, index) => {
        const open = !collapsed.has(group.id);
        const listId = `${idPrefix}-${index}`;
        return (
          <section key={group.id} aria-label={group.heading}>
            <button
              type="button"
              onClick={() => toggle(group.id)}
              aria-expanded={open}
              aria-controls={listId}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5 rtl:-scale-x-100" />}
              <span className="truncate">{group.heading}</span>
              <span className="font-normal">({group.results.length})</span>
            </button>
            {open && (
              <ul id={listId} className="pb-1">
                {group.results.map((r) => {
                  const current = isOpen(r.email, openEmail);
                  return (
                    <li key={r.key}>
                      <button
                        type="button"
                        onClick={() => click(r)}
                        aria-current={current ? "true" : undefined}
                        className={cn(
                          "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-start",
                          "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                          current && "bg-accent",
                        )}
                      >
                        <span className="w-full truncate text-sm font-medium text-foreground">{r.title}</span>
                        {r.snippet && <span className="line-clamp-2 text-xs text-muted-foreground">{r.snippet}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
