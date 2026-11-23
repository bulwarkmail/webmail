import type { ContactCard } from "@/lib/jmap/types";

type Keywords = ContactCard["keywords"];

const isBlank = (name: string) => name.trim() === "";

/**
 * Names of the categories set on a card. Blank names are left out: iOS sends
 * an empty `CATEGORIES:` line, which the server keeps as `"": true`.
 */
export function contactKeywordNames(keywords: Keywords): string[] {
  if (!keywords) return [];
  return Object.keys(keywords).filter((name) => keywords[name] && !isBlank(name));
}

/**
 * The blank entries of a card's keywords. A save that rebuilds the keyword map
 * from the form adds these back, so editing a card doesn't change what the
 * other device wrote.
 */
export function blankContactKeywords(keywords: Keywords): Record<string, boolean> {
  const blank: Record<string, boolean> = {};
  for (const [name, on] of Object.entries(keywords ?? {})) {
    if (isBlank(name)) blank[name] = on;
  }
  return blank;
}
