"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ToolbarSearch } from "@/components/ui/toolbar";
import { useContactStore } from "@/stores/contact-store";
import { useSearchHistoryStore } from "@/stores/search-history-store";
import { buildSearchSuggestions, listSenderMatches, type ContactSuggestion, type SearchSuggestion } from "@/lib/search-suggestions";
import { useEmailStore } from "@/stores/email-store";
import { SearchSuggestions, suggestionOptionId } from "./search-suggestions";

export type ContactSearchField = "from" | "to";

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  /** Submit a free-text search (Enter, or picking a recent search). */
  onSubmit: (query: string) => void;
  onClear: () => void;
  /** Run a sender / recipient search for a suggested contact. */
  onSelectContact: (contact: ContactSuggestion, field: ContactSearchField) => void;
  disabled?: boolean;
  title?: string;
  /** Focus on mount — the mobile search panel opens straight to the keyboard. */
  autoFocus?: boolean;
  /** Overrides the default placeholder, which carries the `/` shortcut hint. */
  placeholder?: string;
  /** A control at the end of the field, after the clear button (the filter toggle). */
  trailing?: React.ReactNode;
}

/**
 * The mail search bar (#845): a text input with a suggestion dropdown that
 * offers recent searches and contact / sender matches while typing. The
 * dropdown is keyboard-navigable (arrows + Enter, Escape to dismiss) and
 * reuses the composer's contact autocomplete lookup so directory principals,
 * address-book contacts and recent recipients all surface here too.
 */
export function SearchBox({ value, onChange, onSubmit, onClear, onSelectContact, disabled = false, title, autoFocus, placeholder, trailing }: SearchBoxProps) {
  const t = useTranslations("sidebar");
  const listId = `search-suggestions-${useId().replace(/:/g, "")}`;

  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  // The text being typed belongs to the box until it is submitted, cleared or
  // the box loses focus. `value` is the search in force; handing it every
  // keystroke re-rendered the whole mail view per character typed.
  const [draft, setDraft] = useState(value);
  const [adopted, setAdopted] = useState(value);
  if (value !== adopted) {
    setAdopted(value);
    setDraft(value);
  }
  const commitDraft = () => {
    if (draft !== value) onChange(draft);
  };

  const getAutocomplete = useContactStore((s) => s.getAutocomplete);
  // Subscribed only so the memo below recomputes as the lookup's inputs load.
  const contacts = useContactStore((s) => s.contacts);
  const recentRecipients = useContactStore((s) => s.recentRecipients);
  const directoryPrincipals = useContactStore((s) => s.directoryPrincipals);
  const recentSearches = useSearchHistoryStore((s) => s.recentSearches);
  const removeRecentSearch = useSearchHistoryStore((s) => s.removeRecentSearch);

  const suggestions = useMemo<SearchSuggestion[]>(() => {
    const query = draft.trim();
    const matches = query ? getAutocomplete(query).filter((r) => !r.group && r.email) : [];
    // Then the senders of the mail on screen, read as typed (no subscription:
    // the list changing doesn't need the box drawn again).
    const senders = query ? listSenderMatches(useEmailStore.getState().emails, query) : [];
    return buildSearchSuggestions(draft, recentSearches, [...matches, ...senders]);
    // The three store slices are inputs of getAutocomplete (read via get()),
    // not of this closure — list them so the memo recomputes when they load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, recentSearches, getAutocomplete, contacts, recentRecipients, directoryPrincipals]);

  const showDropdown = open && !disabled && suggestions.length > 0;
  const activeIndex = showDropdown && selectedIndex < suggestions.length ? selectedIndex : -1;

  const close = useCallback(() => {
    setOpen(false);
    setSelectedIndex(-1);
  }, []);

  const select = useCallback(
    (suggestion: SearchSuggestion) => {
      close();
      if (suggestion.kind === "recent") {
        setDraft(suggestion.query);
        onChange(suggestion.query);
        onSubmit(suggestion.query);
      } else {
        onSelectContact({ name: suggestion.name, email: suggestion.email }, "from");
      }
    },
    [close, onChange, onSubmit, onSelectContact],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown) {
      if (e.key === "ArrowDown" && suggestions.length > 0 && !disabled) {
        e.preventDefault();
        setOpen(true);
        setSelectedIndex(0);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, -1));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      select(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <div ref={containerRef} className="relative flex-1">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) {
            close();
            onSubmit(draft);
          } else if (value) {
            // Enter on an emptied box leaves the search, as the clear button does.
            close();
            onClear();
          }
        }}
      >
        <ToolbarSearch
          autoFocus={autoFocus}
          // Short, so a narrow list column doesn't cut it; the "/" shortcut
          // shows as a key cap instead of in the text.
          placeholder={placeholder ?? t("search_placeholder")}
          shortcut="/"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
            setSelectedIndex(-1);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={(e) => {
            // Focus moving into the dropdown (e.g. its action buttons) keeps it open.
            const next = e.relatedTarget as Node | null;
            if (next && containerRef.current?.contains(next)) return;
            // Anything that reads the query from outside (the filter panel's
            // search) sees what was typed once focus moves to it.
            commitDraft();
            close();
          }}
          onKeyDown={handleKeyDown}
          onClear={() => {
            setDraft("");
            close();
            onClear();
          }}
          clearLabel={t("clear_search")}
          trailing={trailing}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? suggestionOptionId(listId, activeIndex) : undefined}
          autoComplete="off"
          data-search-input
          data-tour="search-input"
          disabled={disabled}
          title={title}
        />
      </form>
      {showDropdown && (
        <SearchSuggestions
          id={listId}
          query={draft}
          suggestions={suggestions}
          selectedIndex={activeIndex}
          onSelect={select}
          onSelectContactTo={(contact) => {
            close();
            onSelectContact(contact, "to");
          }}
          onRemoveRecent={removeRecentSearch}
        />
      )}
    </div>
  );
}
