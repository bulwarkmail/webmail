"use client";

import * as React from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/cn";
import { formatTimeOfDay, isFinishedTimeOfDay, parseTimeOfDay, stepTimeOfDay } from "@/lib/time-of-day";

export interface TimeFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "step"> {
  /** "HH:mm" (24-hour), or "" for no time yet. */
  value: string;
  /**
   * Called with "HH:mm" once the typed text is a whole time ("15:30",
   * "1530", "2pm"), and on blur, Enter and the arrow keys.
   */
  onChange: (value: string) => void;
  /** Minutes the arrow keys move the time by. */
  step?: number;
}

/**
 * A time of day typed as text and shown in the app's 12- or 24-hour
 * setting. A native time input follows the browser's language instead and
 * can't be told otherwise. "14:30", "1430", "2:30 pm" and "2p" all work;
 * the arrow keys move the time by `step` minutes. Text that isn't a time is
 * marked invalid and goes back to the last time on blur.
 *
 * Half-typed text isn't handed on: "1", "15" and "153" on the way to
 * "15:30" would each move an event's end with its start.
 */
export const TimeField = React.forwardRef<HTMLInputElement, TimeFieldProps>(
  ({ value, onChange, step = 15, onBlur, onKeyDown, placeholder, className, ...props }, ref) => {
    const timeFormat = useSettingsStore((s) => s.timeFormat);
    // What is being typed; null shows the value in the app's format.
    const [draft, setDraft] = React.useState<string | null>(null);
    // The last time handed on. The value can lag behind it (quiet hours wait
    // for the desktop app to answer), so the arrows step from this one, and
    // typing back to the old value still goes out.
    const committed = React.useRef(value);
    React.useEffect(() => {
      committed.current = value;
    }, [value]);
    const commit = (next: string | null) => {
      if (next === null || next === committed.current) return;
      committed.current = next;
      onChange(next);
    };
    const text = draft ?? formatTimeOfDay(value, timeFormat);
    const invalid = draft !== null && draft.trim() !== "" && parseTimeOfDay(draft) === null;

    return (
      <input
        ref={ref}
        type="text"
        autoComplete="off"
        spellCheck={false}
        // "2:30 PM" stays in that order in a right-to-left language.
        dir="ltr"
        placeholder={placeholder ?? formatTimeOfDay("09:00", timeFormat)}
        {...props}
        className={cn("placeholder:text-muted-foreground", className)}
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          if (isFinishedTimeOfDay(event.target.value)) commit(parseTimeOfDay(event.target.value));
        }}
        onBlur={(event) => {
          if (draft !== null) commit(parseTimeOfDay(draft));
          setDraft(null);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter") {
            // Before the editor's Ctrl+Enter save, which runs after this.
            if (draft !== null) commit(parseTimeOfDay(draft));
            setDraft(null);
          } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey) {
            event.preventDefault();
            const from = (draft !== null ? parseTimeOfDay(draft) : null) ?? committed.current;
            setDraft(null);
            commit(stepTimeOfDay(from, event.key === "ArrowUp" ? step : -step));
          }
        }}
      />
    );
  },
);
TimeField.displayName = "TimeField";
