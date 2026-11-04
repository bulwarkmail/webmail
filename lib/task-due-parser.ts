import { addDays, format, isValid } from "date-fns";

/**
 * Reads a due date from the end of a quick task title: "Call the plumber
 * tomorrow" is "Call the plumber", due tomorrow. Takes the words for today,
 * tomorrow and the day after, the weekdays and numeric dates (12.11.,
 * 11/12, 2026-11-12) in the app's language, from Intl so every language the
 * app has works, and in English. Only the end of the title counts, and a
 * title that is nothing but the date stays as it is.
 */
export interface ParsedTaskDue {
  /** The title without the date words. */
  title: string;
  /** yyyy-MM-dd */
  due: string;
  /** The words taken from the title, as typed. */
  matched: string;
}

// Languages written without spaces between words: the date may follow the
// title directly.
const NO_SPACE_LANGUAGES = new Set(["ja", "zh", "th"]);

// Short words before the date that belong to it ("on Friday", "am Freitag").
const LEAD_WORDS: Record<string, string[]> = {
  en: ["on", "by", "due", "until"],
  de: ["am", "bis", "bis zum", "zum"],
};

function baseLanguage(locale: string): string {
  return locale.toLowerCase().split(/[-_]/)[0];
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().normalize("NFC").replace(/[’']/g, "'");
}

function relativeDayWords(locale: string): Array<{ word: string; offset: number }> {
  const out: Array<{ word: string; offset: number }> = [];
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    for (const offset of [0, 1, 2]) {
      const word = rtf.format(offset, "day");
      // "in 2 days" is not a word for the day after tomorrow.
      if (!/\d/.test(word)) out.push({ word: normalize(word), offset });
    }
  } catch {
    // An unknown locale has no words of its own.
  }
  return out;
}

function weekdayWords(locale: string): Array<{ word: string; weekday: number }> {
  const out: Array<{ word: string; weekday: number }> = [];
  try {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "long" });
    // 2026-11-01 is a Sunday.
    for (let weekday = 0; weekday < 7; weekday++) {
      out.push({ word: normalize(fmt.format(new Date(2026, 10, 1 + weekday))), weekday });
    }
  } catch {
    // As above.
  }
  return out;
}

/** True when the locale writes the month before the day (en-US 11/12). */
function monthFirst(locale: string): boolean {
  try {
    const types = new Intl.DateTimeFormat(locale).formatToParts(new Date(2026, 10, 12)).map((p) => p.type);
    return types.indexOf("month") < types.indexOf("day");
  } catch {
    return false;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The date `day.month[.year]` names, the next one from `today` when it has no year. */
function dateFrom(day: number, month: number, year: number | null, today: Date): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const fullYear = year === null ? today.getFullYear() : year < 100 ? 2000 + year : year;
  let date = new Date(fullYear, month - 1, day);
  if (!isValid(date) || date.getDate() !== day) return null;
  if (year === null) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (date < start) date = new Date(fullYear + 1, month - 1, day);
    if (date.getDate() !== day) return null;
  }
  return date;
}

export function parseTaskDue(input: string, locale: string, today: Date = new Date()): ParsedTaskDue | null {
  const text = input.trim();
  if (!text) return null;
  const lang = baseLanguage(locale);
  const locales = lang === "en" ? [locale] : [locale, "en"];
  const lower = normalize(text);
  const spaceless = NO_SPACE_LANGUAGES.has(lang);

  // The candidates, longest first so "day after tomorrow" wins over "tomorrow".
  const candidates: Array<{ pattern: RegExp; resolve: (m: RegExpMatchArray) => Date | null }> = [];
  const wordEnd = (word: string) => new RegExp(`${spaceless ? "" : "(?:^|\\s)"}(${escapeRegExp(word)})[.!]?$`, "u");

  const words: Array<{ word: string; resolve: () => Date }> = [];
  for (const loc of locales) {
    for (const { word, offset } of relativeDayWords(loc)) {
      words.push({ word, resolve: () => addDays(today, offset) });
    }
    for (const { word, weekday } of weekdayWords(loc)) {
      words.push({ word, resolve: () => addDays(today, (weekday - today.getDay() + 7) % 7) });
    }
  }
  words.sort((a, b) => b.word.length - a.word.length);
  for (const { word, resolve } of words) {
    candidates.push({ pattern: wordEnd(word), resolve });
  }

  // 2026-11-12
  candidates.push({
    pattern: /(?:^|\s)((\d{4})-(\d{1,2})-(\d{1,2}))$/u,
    resolve: (m) => dateFrom(Number(m[4]), Number(m[3]), Number(m[2]), today),
  });
  // 12.11. / 12.11.2026 / 11/12 / 11/12/26: the order the locale writes.
  const mFirst = monthFirst(locale);
  candidates.push({
    pattern: /(?:^|\s)((\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?\.?)$/u,
    resolve: (m) => {
      const a = Number(m[2]);
      const b = Number(m[3]);
      const year = m[4] ? Number(m[4]) : null;
      return mFirst ? dateFrom(b, a, year, today) : dateFrom(a, b, year, today);
    },
  });

  for (const { pattern, resolve } of candidates) {
    const match = lower.match(pattern);
    if (!match || match.index === undefined) continue;
    const date = resolve(match);
    if (!date) continue;
    // Where the date words start in the typed text (same length: only case changed).
    let start = match.index + match[0].indexOf(match[1]);
    let rest = text.slice(0, start).trimEnd();
    // "on Friday": the lead word goes with the date.
    for (const lead of LEAD_WORDS[lang] ?? LEAD_WORDS.en) {
      const leadMatch = normalize(rest).match(new RegExp(`(?:^|\\s)${escapeRegExp(lead)}$`, "u"));
      if (leadMatch && leadMatch.index !== undefined && rest.length > lead.length) {
        const leadStart = leadMatch.index + leadMatch[0].length - lead.length;
        rest = rest.slice(0, leadStart).trimEnd();
        start = leadStart;
        break;
      }
    }
    if (!rest) return null;
    return { title: rest, due: format(date, "yyyy-MM-dd"), matched: text.slice(start).trim() };
  }
  return null;
}
