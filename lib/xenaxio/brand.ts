// xenaxio: the product name in Bulwark's own strings. Applied at runtime on
// top of the locale catalogs, so upstream locale files stay untouched and new
// upstream strings are covered automatically.
type Messages = Record<string, unknown>;

export const PRODUCT_NAME = "xenaxio";

const BRAND = /Bulwark(?: Webmail| Mail(?: App)?)?/g;

export function rebrandMessages(messages: Messages): Messages {
  const out: Messages = {};
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === "string") out[key] = value.includes("Bulwark") ? value.replace(BRAND, PRODUCT_NAME) : value;
    else if (value && typeof value === "object" && !Array.isArray(value)) out[key] = rebrandMessages(value as Messages);
    else out[key] = value;
  }
  return out;
}

/** Only absolute http(s) links from config.json, so a typo cannot become a javascript: URL. */
export function safeHttpUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}
