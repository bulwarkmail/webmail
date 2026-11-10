import type { TimeFormat } from "@/stores/settings-store";

/**
 * The digits and separators someone typed, in ASCII: full-width digits and
 * colon (NFKC) and Arabic-Indic and Extended Arabic-Indic digits.
 */
function asciiTimeText(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKC")) {
    const code = ch.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else out += ch;
  }
  return out;
}

interface TypedTime {
  /** "HH:mm", 24-hour. */
  value: string;
  /** No more typing would turn it into another time: see isFinishedTimeOfDay. */
  finished: boolean;
}

function readTimeOfDay(text: string): TypedTime | null {
  const s = asciiTimeText(text).trim().toLowerCase();
  if (!s) return null;
  // "14:30", "14.30", "14h30", "14,30", "14 30", "14h", "14"; then "1430", "930".
  const separated = /^(\d{1,2})(?:\s*[:.h,]\s*(\d{1,2})?|\s+(\d{1,2}))?\s*(?:([ap])\.?\s*(?:m\.?)?)?$/.exec(s);
  const bare = separated ? null : /^(\d{1,2})(\d{2})\s*(?:([ap])\.?\s*(?:m\.?)?)?$/.exec(s);
  let hourText: string;
  let minuteText: string | undefined;
  let meridiem: string | undefined;
  let finished: boolean;
  if (separated) {
    hourText = separated[1];
    minuteText = separated[2] ?? separated[3];
    meridiem = separated[4];
    finished = minuteText?.length === 2;
  } else if (bare) {
    hourText = bare[1];
    minuteText = bare[2];
    meridiem = bare[3];
    finished = hourText.length === 2;
  } else {
    return null;
  }
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return {
    value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    finished: finished || !!meridiem,
  };
}

/**
 * A time of day as the editors keep it ("HH:mm", 24-hour), read from what
 * someone typed: "14:30", "1430", "14h30", "14,30", "14 30", "2:30 pm",
 * "2.30p", "9", "930am", in any digits. Without "am" or "pm" the hour
 * counts as 24-hour. Null when it isn't a time.
 */
export function parseTimeOfDay(text: string): string | null {
  return readTimeOfDay(text)?.value ?? null;
}

/**
 * Whether typed text is a whole time that more typing wouldn't change into
 * another: a two-digit minute after a separator ("15:30", "9.05", "14h30"),
 * four bare digits ("1530") or an am/pm ("2pm", "2:30 pm"). "1", "15",
 * "153" and "15:3" are on their way to "15:30" and aren't.
 */
export function isFinishedTimeOfDay(text: string): boolean {
  return readTimeOfDay(text)?.finished ?? false;
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
