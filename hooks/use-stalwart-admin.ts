"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/browser-navigation";
import { IS_LITE } from "@/lib/lite";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Whether one of the signed-in accounts may open the Stalwart admin console.
 * In "auto" mode the admin session is minted here as well, so /admin works
 * even after a full page navigation; in "password" mode the console asks for
 * it (#870).
 *
 * Every connected login is asked, each once it has connected. Asking only the
 * open account, once at mount, hid the console whenever the admin login was
 * not the open one: after a restart the other logins are restored in the
 * background, after the shell has rendered (#1532).
 */
export function useStalwartAdmin(): boolean {
  const [isStalwartAdmin, setIsStalwartAdmin] = useState(false);
  // The cookie slots of the connected logins, as a string the effect can key on.
  const connectedSlots = useAccountStore((s) => s.accounts
    .filter((a) => a.isConnected && typeof a.cookieSlot === 'number')
    .map((a) => a.cookieSlot)
    .sort((a, b) => a - b)
    .join(','));
  // Bumped when the background restore is done. A login asked before its
  // sign-in context was written answers "no", so every login is asked again.
  const revision = useAuthStore((s) => s.connectedAccountsRevision);
  const asked = useRef(new Set<number>());
  const askedAtRevision = useRef(revision);
  const found = useRef(false);

  useEffect(() => {
    // No admin console in the static Lite build.
    if (IS_LITE || found.current || !connectedSlots) return;
    if (askedAtRevision.current !== revision) {
      askedAtRevision.current = revision;
      asked.current.clear();
    }
    for (const slot of connectedSlots.split(',').map(Number)) {
      if (asked.current.has(slot)) continue;
      asked.current.add(slot);
      const headers = { 'X-JMAP-Cookie-Slot': String(slot) };
      apiFetch('/api/admin/auth', { headers })
        .then(res => res.json())
        .then(data => {
          if (!data.stalwartAdmin || found.current) return;
          found.current = true;
          setIsStalwartAdmin(true);
          if (!data.authenticated && data.stalwartAutoLogin === true) {
            apiFetch('/api/admin/auth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...headers },
              body: JSON.stringify({ stalwartAuth: true }),
            }).catch(() => {});
          }
        })
        // Unanswered: ask this login again the next time the set changes.
        .catch(() => { asked.current.delete(slot); });
    }
  }, [connectedSlots, revision]);

  return isStalwartAdmin;
}
