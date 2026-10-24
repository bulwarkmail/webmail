// xenaxio: the web client runs behind the platform BFF. Mail, calendar and
// contacts go through /api/jmap with the httpOnly session cookie; the browser
// never holds mail server credentials (spec A1, A4, W2).
import { getLocaleFromPath, withBasePath } from "@/lib/browser-navigation";

/** Build flag: `NEXT_PUBLIC_XENAXIO_BFF=1` (set by the xenaxio image). */
export const XENAXIO_BFF = process.env.NEXT_PUBLIC_XENAXIO_BFF === "1";

/**
 * The product speaks German and English only (spec W6). The static build also
 * exports only these (LITE_LOCALES=en,de), so any other locale in the URL is a 404.
 */
export const XENAXIO_LOCALES: readonly string[] = ["de", "en"];

/** Step 29: accounts in one browser, the active one included (the platform's limit). */
export const BFF_MAX_ACCOUNTS = 5;

/** JMAP base URL for the cookie-mode client: discovery is `<this>/.well-known/jmap`. */
export function bffJmapUrl(): string {
  return `${window.location.origin}${withBasePath("/api/jmap")}`;
}

/** Sends the browser to a xenaxio page in the current language, e.g. "login". */
export function goToPage(page: string): void {
  const target = withBasePath(`/${getLocaleFromPath()}/${page}/`);
  if (window.location.pathname === target) return;
  window.location.assign(target);
}

export function redirectToLogin(): void {
  if (window.location.pathname.includes("/login")) return;
  goToPage("login");
}
