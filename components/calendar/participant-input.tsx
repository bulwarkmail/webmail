"use client";

import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { useTranslations } from "next-intl";
import { X } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { useContactStore } from "@/stores/contact-store";

interface Participant {
  name: string;
  email: string;
}

interface ParticipantInputProps {
  participants: Participant[];
  onAdd: (participant: Participant) => void;
  onRemove: (email: string) => void;
  disabled?: boolean;
}

export interface ParticipantInputHandle {
  flush: () => Participant | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ParticipantInput = forwardRef<ParticipantInputHandle, ParticipantInputProps>(function ParticipantInput({ participants, onAdd, onRemove, disabled }, ref) {
  const t = useTranslations("calendar.participants");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Participant[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const updateSuggestions = useCallback((q: string) => {
    if (q.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const results = useContactStore.getState().getAutocomplete(q);
    const existing = new Set(participants.map(p => p.email.toLowerCase()));
    const filtered = results.filter(r => !existing.has(r.email.toLowerCase()));
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

  const addParticipant = useCallback((p: Participant) => {
    if (!p.email || !EMAIL_REGEX.test(p.email)) return;
    if (participants.some(e => e.email.toLowerCase() === p.email.toLowerCase())) return;
    onAdd(p);
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
        <Input
          ref={inputRef}
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

        {showSuggestions && (
          <ul
            ref={listRef}
            id="participant-suggestions"
            role="listbox"
            className="absolute z-50 w-full mt-1 bg-background border border-border rounded-md shadow-lg max-h-48 overflow-y-auto"
          >
            {suggestions.map((s, i) => (
              <li
                key={s.email}
                id={`suggestion-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => { e.preventDefault(); addParticipant(s); }}
                className={`px-3 py-2 text-sm cursor-pointer transition-colors flex items-center gap-2 ${
                  i === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                }`}
              >
                <Avatar name={s.name} email={s.email} size="sm" className="shrink-0 w-7 h-7 text-[10px]" />
                <div className="min-w-0">
                  <div className="font-medium truncate">{s.name || s.email}</div>
                  {s.name && (
                    <div className="text-xs text-muted-foreground truncate">{s.email}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
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
                >
                  {p.name || p.email}
                </button>
              ) : (
                <span className="truncate">{p.name || p.email}</span>
              )}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onRemove(p.email)}
                  className="flex-shrink-0 p-0.5 rounded-full hover:bg-muted-foreground/20 transition-colors min-w-[20px] min-h-[20px] flex items-center justify-center"
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
