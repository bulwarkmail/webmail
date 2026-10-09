"use client";

import { useEffect, useState } from "react";
import { getActiveAccountSlotHeaders } from "@/lib/auth/active-account-slot";
import { apiFetch } from "@/lib/browser-navigation";
import { IS_LITE } from "@/lib/lite";

/**
 * Whether the signed-in user may open the Stalwart admin console. In "auto"
 * mode the admin session is minted here as well, so /admin works even after a
 * full page navigation; in "password" mode the console asks for it (#870).
 */
export function useStalwartAdmin(): boolean {
  const [isStalwartAdmin, setIsStalwartAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const headers = getActiveAccountSlotHeaders();
    // No admin console in the static Lite build.
    if (IS_LITE || !headers['X-JMAP-Cookie-Slot']) return;
    apiFetch('/api/admin/auth', { headers })
      .then(res => res.json())
      .then(data => {
        if (cancelled || !data.stalwartAdmin) return;
        setIsStalwartAdmin(true);
        if (!data.authenticated && data.stalwartAutoLogin === true) {
          apiFetch('/api/admin/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ stalwartAuth: true }),
          }).catch(() => {});
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return isStalwartAdmin;
}
