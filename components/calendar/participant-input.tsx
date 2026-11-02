"use client";

import { useState, useRef, useCallback, useEffect, useLayoutEffect, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { X, Users } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { useContactStore, getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";

interface Participant {
  name: string;
  email: string;
}

interface ParticipantSuggestion extends Participant {
  group?: { id: string; memberCount: number };
}

interface ParticipantInputProps {
  participants: Participant[];
  onAdd: (participant: Participant) => void;
  onRemove: (email: string) => void;
  disabled?: boolean;
  /** The field's id, for the label above it. */
  id?: string;
}

export interface ParticipantInputHandle {
  flush: () => Participant | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ParticipantInput = forwardRef<ParticipantInputHandle, ParticipantInputProps>(function ParticipantInput({ participants, onAdd, onRemove, disabled, id }, ref) {
  const t = useTranslations("calendar.participants");
  const tContacts = useTranslations("contacts");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ParticipantSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The list is rendered into <body> at a fixed position. Inside the event
  // form's scroll container it was clipped: overflow-y also clips sideways,
  // which cut off the avatars that sit left of the field.
  const [listPos, setListPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!showSuggestions) return;
    const place = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      // 36px left of the field: past the list's 1px border, 12px padding and
      // the 28px avatar plus gap, each name starts under the typed text. Kept
      // inside the window on a narrow screen.
      const left = Math.max(8, rect.left - 36);
      setListPos({ top: rect.bottom + 4, left, width: rect.right - left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [showSuggestions]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const updateSuggestions = useCallback((q: string) => {
    if (q.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const results = useContactStore.getState().getAutocomplete(q);
    const existing = new Set(participants.map(p => p.email.toLowerCase()));
    const filtered = results.filter(r => r.group || !existing.has(r.email.toLowerCase()));
    setSuggestions(filtered.slice(0, 8));
    setShowSuggestions(filtered.length > 0);
    setActiveIndex(-1);
  }, [participants]);

  const handleInputChange = useCallback((value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => updateSuggestions(value), 200);
  }, [updateSuggestions]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const addParticipant = useCallback((p: ParticipantSuggestion) => {
    if (!p.group && (!EMAIL_REGEX.test(p.email) || participants.some(e => e.email.toLowerCase() === p.email.toLowerCase()))) return;
    const candidates = p.group
      ? useContactStore.getState().getGroupMembers(p.group.id).map(contact => ({
        name: getContactDisplayName(contact),
        email: getContactPrimaryEmail(contact).trim(),
      }))
      : [p];
    const existing = new Set(participants.map(participant => participant.email.toLowerCase()));
    for (const candidate of candidates) {
      if (!EMAIL_REGEX.test(candidate.email) || existing.has(candidate.email.toLowerCase())) continue;
      existing.add(candidate.email.toLowerCase());
      onAdd({ name: candidate.name, email: candidate.email });
    }
    setQuery("");
    setSuggestions([]);
    setShowSuggestions(false);
    inputRef.current?.focus();
  }, [participants, onAdd]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && showSuggestions) {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp" && showSuggestions) {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        addParticipant(suggestions[activeIndex]);
      } else if (query.trim() && EMAIL_REGEX.test(query.trim())) {
        addParticipant({ name: "", email: query.trim() });
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }, [showSuggestions, activeIndex, suggestions, query, addParticipant]);

  const handleBlur = useCallback(() => {
    const trimmed = query.trim();
    if (trimmed && EMAIL_REGEX.test(trimmed)) {
      addParticipant({ name: "", email: trimmed });
    }
    setTimeout(() => setShowSuggestions(false), 200);
  }, [query, addParticipant]);

  useImperativeHandle(ref, () => ({
    flush: () => {
      const trimmed = query.trim();
      if (!trimmed || !EMAIL_REGEX.test(trimmed)) return null;
      if (participants.some(e => e.email.toLowerCase() === trimmed.toLowerCase())) return null;
      const p = { name: "", email: trimmed };
      onAdd(p);
      setQuery("");
      setSuggestions([]);
      setShowSuggestions(false);
      return p;
    },
  }), [query, participants, onAdd]);

  return (
    <div className="space-y-2">
      <div className="relative">
        {/* type="search": Bitwarden skips search fields unconditionally and
            otherwise offered logins for the e-mail placeholder. */}
        <Input
          ref={inputRef}
          id={id}
          type="search"
          autoComplete="off"
          enterKeyHint="enter"
          className="[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
          onBlur={handleBlur}
          placeholder={t("email_placeholder")}
          disabled={disabled}
          role="combobox"
          aria-expanded={showSuggestions}
          aria-controls="participant-suggestions"
          aria-activedescendant={activeIndex >= 0 ? `suggestion-${activeIndex}` : undefined}
          aria-autocomplete="list"
        />

        {showSuggestions && listPos && createPortal(
          <ul
            ref={listRef}
            id="participant-suggestions"
            role="listbox"
            style={{ top: listPos.top, left: listPos.left, width: listPos.width }}
            className="fixed z-[60] bg-background border border-border rounded-md shadow-lg max-h-48 overflow-y-auto"
          >
            {suggestions.map((s, i) => (
              <li
                key={s.group ? `group-${s.group.id}` : s.email}
                id={`suggestion-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => { e.preventDefault(); addParticipant(s); }}
                className={`px-3 py-2 text-sm cursor-pointer transition-colors flex items-center gap-2 ${
                  i === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                }`}
              >
                {s.group ? (
                  <span title={tContacts("directory.type.group")} className="shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                    <Users className="w-4 h-4 text-primary" aria-hidden />
                  </span>
                ) : (
                  <Avatar name={s.name} email={s.email} size="sm" className="shrink-0 w-7 h-7 text-[0.625rem]" />
                )}
                <div className="min-w-0">
                  <div className="font-medium truncate" title={s.name || s.email}>{s.name || s.email}</div>
                  {s.group ? (
                    <div className="text-xs text-muted-foreground truncate">
                      {tContacts("groups.member_count", { count: s.group.memberCount })}
                    </div>
                  ) : s.name && (
                    <div className="text-xs text-muted-foreground truncate" title={s.email}>{s.email}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>,
          document.body,
        )}
      </div>

      {participants.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {participants.map((p, i) => (
            <span
              key={`${p.email}-${i}`}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-muted text-foreground max-w-[200px]"
            >
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => {
                    onRemove(p.email);
                    setQuery(p.email);
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                  className="truncate hover:underline focus:outline-none focus:underline cursor-text"
                  aria-label={`${t("edit")} ${p.name || p.email}`}
                  title={p.email}
                >
                  {p.name || p.email}
                </button>
              ) : (
                <span className="truncate" title={p.email}>{p.name || p.email}</span>
              )}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onRemove(p.email)}
                  className="flex-shrink-0 p-0.5 rounded-full hover:bg-muted-foreground/20 transition-colors min-w-6 min-h-6 -m-0.5 flex items-center justify-center"
                  aria-label={`${t("remove")} ${p.name || p.email}`}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
