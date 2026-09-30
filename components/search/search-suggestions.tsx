"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Clock, X } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { splitHighlight, type ContactSuggestion, type SearchSuggestion } from "@/lib/search-suggestions";

export function suggestionOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

function HighlightedText({ text, query, className }: { text: string; query: string; className?: string }) {
  return (
    <span className={className}>
      {splitHighlight(text, query).map((segment, i) =>
        segment.match ? (
          <mark key={i} className="bg-transparent text-inherit font-semibold">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

interface SearchSuggestionsProps {
  id: string;
  query: string;
  suggestions: SearchSuggestion[];
  selectedIndex: number;
  onSelect: (suggestion: SearchSuggestion) => void;
  /** Run a `to:` search for the contact instead of the default `from:`. */
  onSelectContactTo: (contact: ContactSuggestion) => void;
  onRemoveRecent: (query: string) => void;
}

/**
 * Dropdown under the mail search bar (#845): recent searches first, then
 * contact / sender matches. Purely presentational — the owner tracks the
 * highlighted index and handles keyboard navigation on the input, mirroring
 * the composer's recipient autocomplete.
 */
export function SearchSuggestions({
  id,
  query,
  suggestions,
  selectedIndex,
  onSelect,
  onSelectContactTo,
  onRemoveRecent,
}: SearchSuggestionsProps) {
  const t = useTranslations("advanced_search");

  // Keep the keyboard-highlighted row visible when the list overflows.
  useEffect(() => {
    if (selectedIndex < 0) return;
    const el = document.getElementById(suggestionOptionId(id, selectedIndex));
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [id, selectedIndex]);

  if (suggestions.length === 0) return null;

  const firstContactIndex = suggestions.findIndex((s) => s.kind === "contact");
  const hasRecent = suggestions.some((s) => s.kind === "recent");

  return (
    <div
      id={id}
      role="listbox"
      className="absolute top-full start-0 end-0 z-50 mt-1 bg-background border border-border rounded-md shadow-lg max-h-72 overflow-y-auto py-1"
    >
      {suggestions.map((suggestion, i) => {
        const selected = i === selectedIndex;
        const rowClass = cn(
          "group w-full px-3 py-2 text-start text-sm flex items-center gap-2 cursor-pointer",
          selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
        );

        const heading =
          (i === 0 && hasRecent && suggestion.kind === "recent" && (
            <div className="px-3 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("suggestions_recent")}
            </div>
          )) ||
          (i === firstContactIndex && (
            <div
              className={cn(
                "px-3 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                hasRecent && "mt-1 border-t border-border pt-2",
              )}
            >
              {t("suggestions_people")}
            </div>
          ));

        if (suggestion.kind === "recent") {
          return (
            <div key={`recent-${suggestion.query}`}>
              {heading}
              <div
                id={suggestionOptionId(id, i)}
                role="option"
                aria-selected={selected}
                className={rowClass}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(suggestion);
                }}
              >
                <Clock className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden />
                <HighlightedText text={suggestion.query} query={query} className="flex-1 truncate" />
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t("suggestions_remove_recent")}
                  title={t("suggestions_remove_recent")}
                  className={cn(
                    "shrink-0 p-0.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 transition-opacity",
                    selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemoveRecent(suggestion.query);
                  }}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        }

        const contact: ContactSuggestion = { name: suggestion.name, email: suggestion.email };
        const fromLabel = t("suggestions_from", { address: suggestion.email });
        return (
          <div key={`contact-${suggestion.email}`}>
            {heading}
            <div
              id={suggestionOptionId(id, i)}
              role="option"
              aria-selected={selected}
              aria-label={fromLabel}
              title={fromLabel}
              className={rowClass}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(suggestion);
              }}
            >
              <Avatar name={suggestion.name} email={suggestion.email} size="sm" className="shrink-0 w-6 h-6 text-[10px]" />
              <span className="flex-1 min-w-0 flex items-baseline gap-1.5 truncate">
                {suggestion.name ? (
                  <>
                    <HighlightedText text={suggestion.name} query={query} className="truncate" />
                    <HighlightedText text={`<${suggestion.email}>`} query={query} className="text-muted-foreground truncate" />
                  </>
                ) : (
                  <HighlightedText text={suggestion.email} query={query} className="truncate" />
                )}
              </span>
              <span className="shrink-0 flex items-center gap-1 text-[11px]">
                <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">{t("from")}</span>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t("suggestions_to", { address: suggestion.email })}
                  title={t("suggestions_to", { address: suggestion.email })}
                  className={cn(
                    "px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-opacity",
                    selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectContactTo(contact);
                  }}
                >
                  {t("to")}
                </button>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
