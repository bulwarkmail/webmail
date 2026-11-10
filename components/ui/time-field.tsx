"use client";

import * as React from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { formatTimeOfDay, parseTimeOfDay, stepTimeOfDay } from "@/lib/time-of-day";

export interface TimeFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "step"> {
  /** "HH:mm" (24-hour), or "" for no time yet. */
  value: string;
  /** Called with "HH:mm" as soon as the text reads as a time. */
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
 */
export const TimeField = React.forwardRef<HTMLInputElement, TimeFieldProps>(
  ({ value, onChange, step = 15, onBlur, onKeyDown, placeholder, ...props }, ref) => {
    const timeFormat = useSettingsStore((s) => s.timeFormat);
    // What is being typed; null shows the value in the app's format.
    const [draft, setDraft] = React.useState<string | null>(null);
    const text = draft ?? formatTimeOfDay(value, timeFormat);
    const invalid = draft !== null && draft.trim() !== "" && parseTimeOfDay(draft) === null;

    return (
      <input
        ref={ref}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder ?? formatTimeOfDay("09:00", timeFormat)}
        {...props}
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = parseTimeOfDay(event.target.value);
          if (next && next !== value) onChange(next);
        }}
        onBlur={(event) => {
          setDraft(null);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter") {
            setDraft(null);
          } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey) {
            event.preventDefault();
            const from = (draft !== null ? parseTimeOfDay(draft) : null) ?? value;
            const next = stepTimeOfDay(from, event.key === "ArrowUp" ? step : -step);
            setDraft(null);
            if (next !== value) onChange(next);
          }
        }}
      />
    );
  },
);
TimeField.displayName = "TimeField";
