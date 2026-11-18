"use client";

import { type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, GripHorizontal, List, Loader2, Rows3 } from "@/components/icons";
import { SearchSnippetText } from "@/components/email/search-snippet-text";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { cn, formatDate } from "@/lib/utils";
import { isFilterEmpty } from "@/lib/jmap/search-utils";
import { runPluginAction } from "@/lib/plugin-sandbox/actions";
import type { ProvidedSearchResult } from "@/lib/plugin-search-results";
import { parseSearchSnippet } from "@/lib/search-snippet";
import type { SearchResultEmail } from "@/lib/plugin-types";
import type { Email } from "@/lib/jmap/types";
import { type OpenableEmail, reachableEmail } from "@/lib/plugin-sandbox/open-email";
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

/** ms a plugin may take before the block holds its place for the entries to come. */
export const PENDING_GRACE_MS = 300;

/**
 * Whether the block holds its place for this search: a plugin asked had not
 * answered after PENDING_GRACE_MS. A plugin that answers at once (one that
 * does not search for this query) shows nothing.
 */
function useHeldPlace(pending: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!pending) return;
    setHeld(false);
    const timer = setTimeout(() => setHeld(true), PENDING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  return held;
}

/** The block's share of the list's height until the user drags its edge: half, the messages the other half. */
export const DEFAULT_SHARE = 0.5;
/** The most of the list's height the block may take; the messages below keep the rest. */
export const MAX_SHARE = 0.85;
/** px: the block never gets lower than a group heading and one entry. */
export const MIN_HEIGHT = 64;
/** px around half the list within which a drag takes half. Less than a key's step, so the arrows get past it. */
export const SNAP_PX = 8;
/** px a pointer may move on the edge of a section that has the whole height before that counts as a drag. */
export const WHOLE_SLACK_PX = 4;
const SHARE_KEY = "pluginSearchResultsShare";

/** The section that has the list's whole height, the other one down to its heading. */
type Whole = "plugins" | "messages";

/** The share the user dragged the block to, or null for DEFAULT_SHARE. */
function readShare(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const n = parseFloat(localStorage.getItem(SHARE_KEY) ?? "");
    return Number.isFinite(n) && n > 0 && n <= MAX_SHARE ? n : null;
  } catch { return null; }
}

function writeShare(share: number | null) {
  try {
    if (share == null) localStorage.removeItem(SHARE_KEY);
    else localStorage.setItem(SHARE_KEY, share.toFixed(3));
  } catch { /* storage blocked */ }
}

const COMPACT_KEY = "pluginSearchResultsCompact";

/** Whether the user chose one line per entry. */
function readCompact(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(COMPACT_KEY) === "1"; } catch { return false; }
}

function writeCompact(compact: boolean) {
  try {
    if (compact) localStorage.setItem(COMPACT_KEY, "1");
    else localStorage.removeItem(COMPACT_KEY);
  } catch { /* storage blocked */ }
}

/** The snippet as plain text, for a compact row's tooltip. */
function snippetText(snippet: string): string {
  return parseSearchSnippet(snippet).map((segment) => segment.text).join("");
}

/** An entry's score as five bars, as many filled as it is out of 1. */
function ScoreBars({ score, label }: { score: number; label: string }) {
  const filled = Math.round(score * 5);
  return (
    <span role="img" aria-label={label} className="inline-flex shrink-0 items-end gap-px">
      {[1, 2, 3, 4, 5].map((bar) => (
        <span
          key={bar}
          className={cn("h-2.5 w-[3px] rounded-[1px]", bar <= filled ? "bg-foreground/70" : "bg-muted-foreground/30")}
        />
      ))}
    </span>
  );
}

/** The block's height and its list's, in px, kept while the block shows. */
function useBox(ref: RefObject<HTMLDivElement | null>, shown: boolean): { height: number; list: number } {
  const [box, setBox] = useState({ height: 0, list: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!shown || !el) return;
    const measure = () => setBox({ height: el.offsetHeight, list: el.parentElement?.clientHeight ?? 0 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [ref, shown]);
  return box;
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
 * without entries. While a plugin takes longer than PENDING_GRACE_MS the block
 * shows at its share of the list with placeholder rows, which its entries then
 * fill, so the list moves once, with its own results, and not again when a
 * slow plugin answers with entries enough for that height (fewer give the
 * messages the room back). Its lower edge drags, up and down: the block takes
 * up to MAX_SHARE of the list (never more than its entries need) and keeps
 * that share for later searches (a search with few results leaves it as it
 * was); a double click gives it DEFAULT_SHARE again, and a drag snaps to half
 * the list. The edge is the heading of the messages below, so the search
 * reads as two sections. A click on a section's heading gives it the whole
 * height and leaves the other its heading, a second click gives both their
 * shares back; that lasts for this search only. Groups of several plugins
 * each fold by a chevron of their own. A toggle at the first heading shows one
 * line per entry (score, title, from, date; the snippet in its tooltip and
 * under the entry open in the reader), kept as the share is. A click on an entry naming a message the user reaches opens it; any
 * other goes back to the plugin that gave the entry.
 */
export function PluginSearchResults({ surface, onOpenEmail }: PluginSearchResultsProps) {
  const results = useEmailStore((s) => s.externalSearchResults);
  const openEmail = useEmailStore((s) => s.selectedEmail);
  const query = useEmailStore((s) => s.searchQuery);
  const filters = useEmailStore((s) => s.searchFilters);
  const searching = useEmailStore((s) => !!s.searchQuery.trim() || !isFilterEmpty(s.searchFilters));
  const pending = useEmailStore((s) => s.externalSearchPending.length > 0);
  const plugins = usePluginStore((s) => s.plugins);
  const held = useHeldPlace(pending);
  const t = useTranslations('email_list');
  const tFold = useTranslations('settings.folders');
  const idPrefix = useId();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [compact, setCompact] = useState(readCompact);
  const [share, setShare] = useState<number | null>(readShare);
  // For the search it was chosen in: another query or other filters, and one
  // begun after this one was left, start with the shares.
  const [whole, setWhole] = useState<Whole | null>(null);
  const [search, setSearch] = useState({ query, filters });
  if (search.query !== query || search.filters !== filters) {
    setSearch({ query, filters });
    setWhole(null);
  }
  // The latest share, for the end of a drag to keep.
  const shareRef = useRef(share);
  const dragStart = useRef(0);
  // The share as a drag found it, in px of the list.
  const shareStart = useRef(0);
  const blockRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () => groupResults(results, (id) => plugins.find((p) => p.id === id)?.name ?? id),
    [results, plugins],
  );

  const waiting = pending && held;
  // The share as a height the list's own height is counted in, never below MIN_HEIGHT.
  const limit = `max(${MIN_HEIGHT}px, ${(share ?? DEFAULT_SHARE) * 100}%)`;
  const shown = searching && (groups.length > 0 || waiting);
  const box = useBox(blockRef, shown);
  if (!shown) return null;
  const most = Math.max(MIN_HEIGHT, Math.round(box.list * MAX_SHARE));

  const click = (r: ProvidedSearchResult) => {
    const reachable = r.email && onOpenEmail ? reachableEmail(r.email) : null;
    if (reachable) onOpenEmail?.(reachable);
    else void runPluginAction(r.pluginId, surface, r.key, { query });
  };

  const give = (section: Whole) => setWhole(whole === section ? null : section);
  // One group needs no fold: the messages' heading gives them its room.
  const many = groups.length > 1;
  const pluginsWhole = whole === "plugins" && !waiting;

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <div
        ref={blockRef}
        data-plugin-surface={surface}
        // With the whole height the block takes what its entries need and
        // shrinks to what the list has; the messages keep the rest, if any.
        className={cn("overflow-y-auto bg-muted/30", pluginsWhole ? "min-h-0 shrink" : "flex-shrink-0")}
        // Waiting, the block is as high as its share, whatever it holds yet;
        // with its answers the share is the most it takes. Never a height of
        // its own beside the share: the edge could then only be dragged below it.
        // The share does not count while either section has the whole height.
        style={whole === "messages" || pluginsWhole ? undefined : waiting ? { height: limit } : { maxHeight: limit }}
      >
        {groups.map((group, index) => {
          const open = whole !== "messages" && !(many && collapsed.has(group.id));
          const listId = `${idPrefix}-${index}`;
          return (
            <section key={group.id} aria-label={group.heading}>
              <div className="flex items-center">
                {many && whole !== "messages" && (
                  <button
                    type="button"
                    onClick={() => toggle(group.id)}
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-label={tFold(open ? 'collapse' : 'expand', { name: group.heading })}
                    className="ms-1.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => give("plugins")}
                  aria-pressed={pluginsWhole}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pe-3 text-xs font-semibold text-muted-foreground hover:text-foreground",
                    many && whole !== "messages" ? "ps-1" : "ps-3",
                    pluginsWhole && "text-foreground",
                  )}
                >
                  <span className="truncate">{group.heading}</span>
                  <span className="font-normal">({group.results.length})</span>
                </button>
                {index === 0 && (
                  <button
                    type="button"
                    onClick={() => setCompact((was) => { writeCompact(!was); return !was; })}
                    aria-pressed={compact}
                    aria-label={t('compact_plugin_results')}
                    title={t('compact_plugin_results')}
                    className={cn(
                      "me-1.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground",
                      compact && "text-foreground",
                    )}
                  >
                    {compact ? <List className="h-3.5 w-3.5" /> : <Rows3 className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
              {open && (
                <ul id={listId} className="pb-1">
                  {group.results.map((r) => {
                    const current = isOpen(r.email, openEmail);
                    const bars = !compact || r.score === undefined ? null : (
                      <ScoreBars score={r.score} label={t('plugin_result_score', { count: Math.round(r.score * 5) })} />
                    );
                    const date = compact && r.date ? formatDate(r.date) : "";
                    const snippet = r.snippet && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        <SearchSnippetText snippet={r.snippet} />
                      </span>
                    );
                    return (
                      <li key={r.key}>
                        <button
                          type="button"
                          onClick={() => click(r)}
                          aria-current={current ? "true" : undefined}
                          title={compact && r.snippet ? snippetText(r.snippet) : undefined}
                          className={cn(
                            "flex w-full flex-col items-start text-start",
                            compact ? "px-3 py-1" : "gap-0.5 px-3 py-1.5",
                            "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                            current && "bg-accent",
                          )}
                        >
                          {compact ? (
                            <span className="flex w-full min-w-0 items-center gap-2 text-sm">
                              {bars}
                              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{r.title}</span>
                              {r.from && <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">{r.from}</span>}
                              {date && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{date}</span>}
                            </span>
                          ) : (
                            <span className="w-full truncate text-sm font-medium text-foreground">{r.title}</span>
                          )}
                          {/* A compact row shows its snippet only while its message is open. */}
                          {(!compact || current) && snippet}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
        {waiting && (
          <section aria-label={t('more_results_searching')} aria-busy="true">
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="truncate">{t('more_results_searching')}</span>
            </div>
            {whole !== "messages" && [0, 1, 2].map((row) => (
              <div key={row} className="flex flex-col gap-1.5 px-3 py-2" aria-hidden="true">
                <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-4/5 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </section>
        )}
      </div>
      {/*
        The messages' heading, and the block's lower edge. The heading is a
        button of its own; the rest of the row is the handle: drag it, or use
        the arrow keys; a double click gives the default share back.
      */}
      <div className="flex flex-shrink-0 items-stretch border-y border-border bg-muted/30">
        <button
          type="button"
          onClick={() => give("messages")}
          aria-pressed={whole === "messages"}
          className={cn(
            "px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground",
            whole === "messages" && "text-foreground",
          )}
        >
          {t('listbox_label')}
        </button>
        <ResizeHandle
          orientation="horizontal"
          testId="plugin-search-results-resize"
          // The row's free part, with a grip, in place of a line.
          className="my-0 flex h-auto flex-1 items-center justify-end bg-transparent px-3 text-muted-foreground"
          label={t('resize_plugin_results')}
          // With the whole height or down to its headings the block is outside its limits.
          value={Math.max(MIN_HEIGHT, Math.min(most, box.height))}
          min={MIN_HEIGHT}
          max={most}
          onResizeStart={() => {
            const el = blockRef.current;
            const list = el?.parentElement?.clientHeight ?? box.list;
            // From the whole height the edge starts at the most a share gives, so it follows the pointer at once.
            dragStart.current = Math.min(el?.offsetHeight ?? box.height, list > 0 ? list * MAX_SHARE : Infinity);
            shareStart.current = (shareRef.current ?? DEFAULT_SHARE) * list;
          }}
          onResize={(delta) => {
            const el = blockRef.current;
            const list = el?.parentElement?.clientHeight ?? box.list;
            // A press that moves nowhere changes nothing.
            if (list <= 0 || delta === 0) return;
            if (whole) {
              // A section with the whole height has its edge at the end: only
              // a move back into the list is a drag, and not a slip of the
              // hand on a click. Else the share kept would be lost unseen.
              const inward = whole === "messages" ? delta : -delta;
              if (inward < WHOLE_SLACK_PX) return;
            }
            const limit = list * MAX_SHARE;
            let next = Math.max(MIN_HEIGHT, Math.min(limit, dragStart.current + delta));
            const half = list / 2;
            if (Math.abs(next - half) <= SNAP_PX) next = half;
            // The block shows no more than its entries need. Past them the
            // edge stays where it is and so does the share, unless the entries
            // need more than it gave: a search with few results must not
            // shrink the share kept for the next one. Waiting, or down to its
            // headings, it shows none to measure.
            const entries = waiting || whole === "messages" ? 0 : el?.scrollHeight ?? 0;
            if (entries > 0 && next >= entries) next = Math.max(entries, Math.min(limit, shareStart.current));
            // A drag is a choice of its own: neither section has the whole height any more.
            if (whole) setWhole(null);
            shareRef.current = next / list;
            setShare(shareRef.current);
          }}
          onResizeEnd={() => writeShare(shareRef.current)}
          onDoubleClick={() => { shareRef.current = null; setShare(null); writeShare(null); setWhole(null); }}
        >
          <GripHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        </ResizeHandle>
      </div>
    </>
  );
}
