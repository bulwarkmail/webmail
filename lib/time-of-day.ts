import type { TimeFormat } from "@/stores/settings-store";

/**
 * A time of day as the editors keep it ("HH:mm", 24-hour), read from what
 * someone typed: "14:30", "1430", "14h30", "2:30 pm", "2.30p", "9", "930am".
 * Without "am" or "pm" the hour counts as 24-hour. Null when it isn't a time.
 */
export function parseTimeOfDay(text: string): string | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const match =
    /^(\d{1,2})(?:\s*[:.h]\s*(\d{1,2})?)?\s*(?:([ap])\.?\s*(?:m\.?)?)?$/.exec(s) ??
    /^(\d{1,2})(\d{2})\s*(?:([ap])\.?\s*(?:m\.?)?)?$/.exec(s);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * An "HH:mm" value as the app shows times: "14:30" with the 24-hour
 * setting, "2:30 PM" with the 12-hour one, the same as the calendar.
 */
export function formatTimeOfDay(value: string, timeFormat: TimeFormat): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;
  if (timeFormat !== "12h") return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * The value `minutes` later (or earlier, when negative), wrapping round
 * midnight. A time off the step snaps to the next step in that direction:
 * 09:10 goes up to 09:15 and down to 09:00 with a 15-minute step.
 */
export function stepTimeOfDay(value: string, minutes: number): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const current = match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  const step = Math.abs(minutes);
  let next: number;
  if (step === 0) next = current;
  else if (current % step === 0) next = current + minutes;
  else next = minutes > 0 ? Math.ceil(current / step) * step : Math.floor(current / step) * step;
  const day = 24 * 60;
  next = ((next % day) + day) % day;
  return `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}
