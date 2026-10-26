// Step 29: several accounts in one browser. The platform keeps their sessions
// in httpOnly cookies; the mail app's account menu lists them. One account is
// active at a time: switching reloads the page with the other one, or opens it
// on its company's portal, and the other tabs of this address reload too.
import { getLocaleFromPath, withBasePath } from "@/lib/browser-navigation";
import { generateAccountId } from "@/lib/account-utils";
import { type BrowserAccount, xenaxio, XenaxioApiError } from "@/lib/xenaxio/api";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useAccountStore } from "@/stores/account-store";

const SWITCHED_SIGNAL = "xenaxio:account-switched";

/** The platform's user id of each account in the menu, by the mail app's account id. */
const userIds = new Map<string, string>();

/** JMAP address of an account as the mail app keys it: its portal's /api/jmap. */
export function accountServerUrl(portalUrl: string): string {
  return `${new URL(portalUrl).origin}${withBasePath("/api/jmap")}`;
}

/** Where the mail app starts, in the current language. */
export function startPath(): string {
  return `/${getLocaleFromPath()}/`;
}

/**
 * Brings the account menu in line with the platform's list. The active
 * account is already registered (as `activeId`); it stays first and is the
 * default, the others follow without a mail connection.
 */
export function applyBrowserAccounts(list: BrowserAccount[], activeId: string): void {
  const store = useAccountStore.getState();
  const others = list
    .filter((account) => !account.active)
    .map((account) => ({ account, serverUrl: accountServerUrl(account.portalUrl) }))
    .map((o) => ({ ...o, id: generateAccountId(o.account.email, o.serverUrl) }));
  const active = list.find((account) => account.active);
  if (active) userIds.set(activeId, active.userId);
  // Gone first (signed out elsewhere, or left from another browser session), so the new ones fit.
  const keep = new Set([activeId, ...others.map((o) => o.id)]);
  for (const entry of store.accounts) if (!keep.has(entry.id)) store.removeAccount(entry.id);
  for (const { account, serverUrl, id } of others) {
    userIds.set(id, account.userId);
    if (useAccountStore.getState().getAccountById(id)) {
      store.updateAccount(id, { displayName: account.displayName, isConnected: false, hasError: false });
      continue;
    }
    store.addAccount({
      label: account.email,
      serverUrl,
      username: account.email,
      authMode: "basic",
      rememberMe: false,
      displayName: account.displayName,
      email: account.email,
      lastLoginAt: Date.now(),
      isConnected: false,
      hasError: false,
      isDefault: false,
    });
  }
  store.setDefaultAccount(activeId);
}

/** The platform's user id behind an account of the menu. */
export function userIdOf(accountId: string): string | undefined {
  return userIds.get(accountId);
}

/** Opens `url`: a path here (the page reloads with the account now active) or another portal. */
export function openAccount(url: string): void {
  try {
    // Other tabs see the write as a `storage` event; the key need not stay.
    window.localStorage.setItem(SWITCHED_SIGNAL, String(Date.now()));
    window.localStorage.removeItem(SWITCHED_SIGNAL);
  } catch {
    /* storage unavailable */
  }
  window.location.assign(url.startsWith("/") ? withBasePath(url) : url);
}

/** Another tab switched accounts: this one reloads with the account now active. */
export function reloadOnSwitchElsewhere(): void {
  if (!XENAXIO_BFF || typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (event.key === SWITCHED_SIGNAL && event.newValue !== null) window.location.reload();
  });
}

/** Where the account continues after switching to it. */
export async function switchTo(accountId: string): Promise<string | null> {
  const userId = userIds.get(accountId);
  if (!userId) return null;
  return (await xenaxio.switchAccount(userId, startPath())).url;
}

/** Removes an inactive account from this browser. */
export async function forget(accountId: string): Promise<void> {
  const userId = userIds.get(accountId);
  if (userId) await xenaxio.forgetAccount(userId);
  userIds.delete(accountId);
}

/** Signs out of the active account (or of all); where the next one continues, null when nobody is left. */
export async function signOut(all: boolean): Promise<string | null> {
  try {
    return (await xenaxio.logout({ all, next: startPath() })).url;
  } catch {
    return null;
  }
}

/**
 * Step 39: one company per browser (and per installed app). Adding another
 * company's account is refused with the address of its portal; null for any
 * other error. Only an https address, nothing else is linked.
 */
export function otherCompanyPortal(err: unknown): string | null {
  if (!(err instanceof XenaxioApiError) || err.code !== "account_other_company") return null;
  const url = err.details?.portalUrl;
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
