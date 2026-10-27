"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Search, X, RefreshCw, Loader2, Lock, AlertCircle, BookUser, CheckSquare, Square, ChevronLeft, ChevronRight, Menu, Users, MapPin, Box } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { useContactStore, type DirectoryEntry } from "@/stores/contact-store";

export const DIRECTORY_PAGE_SIZE = 50;

/** Case-insensitive key of a directory entry, used for selection. */
export function directoryKey(entry: DirectoryEntry): string {
  return entry.email.toLowerCase();
}

export function filterDirectory(entries: DirectoryEntry[], query: string, locale?: string): DirectoryEntry[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? entries.filter((e) =>
      e.name.toLowerCase().includes(q) ||
      e.email.toLowerCase().includes(q) ||
      (e.description?.toLowerCase().includes(q) ?? false))
    : entries;
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  return [...matched].sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.email, b.email));
}

function TypeIcon({ type }: { type: DirectoryEntry["type"] }) {
  if (type === "group") return <Users className="w-3.5 h-3.5" />;
  if (type === "location") return <MapPin className="w-3.5 h-3.5" />;
  if (type === "resource") return <Box className="w-3.5 h-3.5" />;
  return null;
}

interface DirectoryBrowserProps {
  client: IJMAPClient | null;
  /** Keys (lowercased addresses) of the checked entries. */
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** Contacts view: clicking a row opens it. Without this, clicking toggles it. */
  onOpen?: (entry: DirectoryEntry) => void;
  activeKey?: string | null;
  onMenuClick?: () => void;
  autoFocusSearch?: boolean;
  className?: string;
}

/**
 * The company directory (RFC 9670 principals the server lists for this
 * account), read-only: search, pages, multi-select. Used by the Contacts
 * "Directory" entry and the composer's recipient picker.
 */
export function DirectoryBrowser({
  client,
  selected,
  onSelectedChange,
  onOpen,
  activeKey,
  onMenuClick,
  autoFocusSearch,
  className,
}: DirectoryBrowserProps) {
  const t = useTranslations("contacts.directory");
  const tContacts = useTranslations("contacts");
  const locale = useLocale();
  const entries = useContactStore((s) => s.directoryPrincipals);
  const status = useContactStore((s) => s.directoryStatus);
  const fetchDirectory = useContactStore((s) => s.fetchDirectory);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // The directory loads at sign-in; fetch here only if that never ran.
  useEffect(() => {
    if (client && status === "idle") void fetchDirectory(client);
  }, [client, status, fetchDirectory]);

  useEffect(() => {
    if (autoFocusSearch) searchRef.current?.focus();
  }, [autoFocusSearch]);

  const filtered = useMemo(() => filterDirectory(entries, query, locale), [entries, query, locale]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / DIRECTORY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageEntries = filtered.slice(currentPage * DIRECTORY_PAGE_SIZE, (currentPage + 1) * DIRECTORY_PAGE_SIZE);

  const loading = status === "loading" || (status === "idle" && !!client);
  const refresh = () => { if (client) void fetchDirectory(client); };

  const toggle = (entry: DirectoryEntry) => {
    const next = new Set(selected);
    const key = directoryKey(entry);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedChange(next);
  };

  const pageAllSelected = pageEntries.length > 0 && pageEntries.every((e) => selected.has(directoryKey(e)));
  const togglePage = () => {
    const next = new Set(selected);
    for (const e of pageEntries) {
      if (pageAllSelected) next.delete(directoryKey(e));
      else next.add(directoryKey(e));
    }
    onSelectedChange(next);
  };

  let placeholder: React.ReactNode = null;
  if (entries.length === 0) {
    if (loading) {
      placeholder = (
        <StatePanel icon={<Loader2 className="w-6 h-6 animate-spin" />} title={t("loading")} />
      );
    } else if (status === "unavailable" || !client) {
      placeholder = <StatePanel icon={<BookUser className="w-6 h-6" />} title={t("unavailable_title")} hint={t("unavailable_hint")} />;
    } else if (status === "forbidden") {
      placeholder = <StatePanel icon={<Lock className="w-6 h-6" />} title={t("forbidden_title")} hint={t("forbidden_hint")} onRetry={refresh} retryLabel={t("retry")} />;
    } else if (status === "error") {
      placeholder = <StatePanel icon={<AlertCircle className="w-6 h-6" />} title={t("error_title")} hint={t("error_hint")} onRetry={refresh} retryLabel={t("retry")} />;
    } else {
      placeholder = <StatePanel icon={<BookUser className="w-6 h-6" />} title={t("empty_title")} hint={t("empty_hint")} />;
    }
  } else if (filtered.length === 0) {
    placeholder = <StatePanel icon={<Search className="w-6 h-6" />} title={t("no_match")} />;
  }

  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      <div className="border-b border-border bg-background px-3 py-3">
        <div className="flex items-center gap-1.5">
          {onMenuClick && (
            <button
              type="button"
              onClick={onMenuClick}
              className="flex-shrink-0 p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label={tContacts("open_categories")}
            >
              <Menu className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={togglePage}
            disabled={pageEntries.length === 0}
            className={cn(
              "flex-shrink-0 p-2 rounded-md transition-colors disabled:opacity-50",
              selected.size > 0 ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
            title={pageAllSelected ? t("deselect_page") : t("select_page")}
            aria-label={pageAllSelected ? t("deselect_page") : t("select_page")}
          >
            {pageAllSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
          </button>
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="text"
              placeholder={t("search_placeholder")}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }}
              className={cn("ps-9 h-9", query && "pe-8")}
              aria-label={t("search_placeholder")}
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(""); setPage(0); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                aria-label={tContacts("clear_search")}
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={!client || status === "loading" || status === "unavailable"}
            className="flex-shrink-0 p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            title={t("refresh")}
            aria-label={t("refresh")}
          >
            <RefreshCw className={cn("w-4 h-4", status === "loading" && "animate-spin")} />
          </button>
        </div>
        {entries.length > 0 && status === "error" && (
          <p role="alert" className="mt-2 text-xs text-destructive">{t("refresh_failed")}</p>
        )}
        {/* A refused listing (Stalwart 1.0 with directory queries off) still
            holds the principals the user knows; nothing failed to refresh. */}
        {entries.length > 0 && status === "forbidden" && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">{t("forbidden_hint")}</p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto" role="list" aria-label={t("title")}>
        {placeholder ?? pageEntries.map((entry) => {
          const key = directoryKey(entry);
          const checked = selected.has(key);
          const showEmail = entry.name !== entry.email;
          return (
            <div
              key={key}
              role="listitem"
              onClick={() => (onOpen ? onOpen(entry) : toggle(entry))}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-2 border-b border-border cursor-pointer select-none transition-colors",
                activeKey === key ? "bg-selection" : "hover:bg-muted",
                checked && activeKey !== key && "bg-selection/60",
              )}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                aria-label={t("select_entry", { name: entry.name })}
                onClick={(e) => { e.stopPropagation(); toggle(entry); }}
                className={cn("p-1 rounded flex-shrink-0 hover:bg-muted/50", checked ? "text-primary" : "text-muted-foreground")}
              >
                {checked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
              </button>
              <Avatar name={entry.name} email={entry.email} size="sm" className="flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{entry.name}</span>
                  {entry.type && entry.type !== "individual" && (
                    <span className="text-muted-foreground flex-shrink-0" title={t(`type.${entry.type}`)}>
                      <TypeIcon type={entry.type} />
                    </span>
                  )}
                </div>
                {showEmail && <div className="text-xs text-muted-foreground truncate">{entry.email}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length > 0 && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border text-xs text-muted-foreground">
          <span className="tabular-nums">
            {t("range", {
              from: currentPage * DIRECTORY_PAGE_SIZE + 1,
              to: currentPage * DIRECTORY_PAGE_SIZE + pageEntries.length,
              total: filtered.length,
            })}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage(currentPage - 1)}
                disabled={currentPage === 0}
                className="p-1.5 rounded-md hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                aria-label={t("previous_page")}
              >
                <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
              </button>
              <span className="tabular-nums">{t("page", { page: currentPage + 1, count: pageCount })}</span>
              <button
                type="button"
                onClick={() => setPage(currentPage + 1)}
                disabled={currentPage >= pageCount - 1}
                className="p-1.5 rounded-md hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                aria-label={t("next_page")}
              >
                <ChevronRight className="w-4 h-4 rtl:rotate-180" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatePanel({ icon, title, hint, onRetry, retryLabel }: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 px-6 py-12 text-muted-foreground">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="text-xs max-w-xs">{hint}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 text-xs font-medium text-primary hover:underline"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
