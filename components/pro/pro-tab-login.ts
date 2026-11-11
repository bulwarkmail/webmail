"use client";

import { useEffect, useState } from "react";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useProTabStore } from "@/stores/pro-tab-store";

// A Pro tab belongs to one login: its message and folder ids name other
// things in every other one. Tabs name their login when they are opened. A
// tab kept from a version that wrote none can only be given one where a
// single login is signed in; with several it belongs to none of them, and
// its body says so instead of following whichever login is active.

/**
 * The login a tab without one belongs to: the only login there is, else
 * none. Signed-out entries of the account list count too: the tab may be
 * one of theirs.
 */
export function soleLogin(): string | undefined {
  const active = useAuthStore.getState().activeAccountId ?? undefined;
  return useAccountStore.getState().accounts.length <= 1 ? active : undefined;
}

/** The login of a tab's data: the one it names, else soleLogin(). */
export function tabLogin(named: string | null | undefined): string | undefined {
  return named || soleLogin();
}

/**
 * tabLogin for a tab body, decided when the body mounts and kept for as long
 * as it lives: a login that becomes the active one later never takes the tab
 * over. A login found for a tab that named none is written into the tab, so
 * it is still that login's after a second one signs in.
 */
export function useTabLogin(tabId: string, named: string | null | undefined): string | undefined {
  const [found] = useState(() => (named ? undefined : soleLogin()));
  useEffect(() => {
    if (!named && found) useProTabStore.getState().nameTabLogin(tabId, found);
  }, [tabId, named, found]);
  return named || found;
}

/**
 * The client of `login`, never another login's. The auth store's `client`
 * counts for the active login while the login table has no entry for it.
 */
export function tabLoginClient(login: string | undefined) {
  if (!login) return null;
  const auth = useAuthStore.getState();
  return auth.getClientForAccount(login) ?? (login === auth.activeAccountId ? auth.client : null);
}
