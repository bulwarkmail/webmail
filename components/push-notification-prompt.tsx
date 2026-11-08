"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import {
  enableWebPush,
  isWebPushEnabled,
  isWebPushSupported,
  resyncWebPush,
  waitForWebPushResync,
} from "@/lib/web-push";
import { webPushErrorKey } from "@/lib/web-push-errors";
import { useConfig } from "@/hooks/use-config";
import { resolveActiveRelayUrl } from "@/lib/push-relays";
import {
  isPWAInstallPromptVisible,
  PWA_INSTALL_PROMPT_VISIBILITY_EVENT,
} from "@/components/pwa-install-prompt";

const DISMISSED_KEY_PREFIX = "bulwark.push.onboarding.dismissed.v1.";
export const PUSH_NOTIFICATION_PROMPT_DELAY_MS = 1_000;
export const MUTES_RESYNC_DELAY_MS = 1_000;

function dismissedKey(accountId: string): string {
  return `${DISMISSED_KEY_PREFIX}${accountId}`;
}

interface ResyncTarget {
  client: NonNullable<ReturnType<typeof useAuthStore.getState>["client"]>;
  accountLabel?: string;
}

/**
 * Every login whose push registration this tab should keep alive: the active
 * one first, then each other connected login. Push can be enabled for a login
 * that is not on screen (the all-accounts panel in settings), and Stalwart
 * expires a PushSubscription after 7 days, so renewing only the active login
 * would let the others lapse. The other clients are the ones the auth store
 * already keeps for the account switcher, so this opens no new connection;
 * resyncWebPush itself skips logins without push in a local check.
 */
function resyncTargets(
  activeClient: ResyncTarget["client"],
  activeLabel: string | undefined,
): ResyncTarget[] {
  const targets: ResyncTarget[] = [{ client: activeClient, accountLabel: activeLabel }];
  const auth = useAuthStore.getState();
  const others = auth.getAllConnectedClients?.() ?? new Map();
  if (others.size === 0) return targets;
  const accounts = useAccountStore.getState().accounts;
  for (const [loginId, other] of others) {
    if (!other || other === activeClient) continue;
    const account = accounts.find((a) => a.id === loginId);
    targets.push({ client: other, accountLabel: account?.username });
  }
  return targets;
}

function isExcludedPath(pathname: string): boolean {
  return /(^|\/)settings(?:\/|$)/.test(pathname)
    || /(^|\/)setup(?:\/|$)/.test(pathname)
    || /(^|\/)login(?:\/|$)/.test(pathname);
}

function wasDismissed(accountId: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(accountId)) === "1";
  } catch {
    return false;
  }
}

function dismissPermanently(accountId: string): void {
  try {
    localStorage.setItem(dismissedKey(accountId), "1");
  } catch {
    // Storage may be unavailable in hardened/private browser contexts. The
    // prompt still closes for the current session.
  }
}

export function PushNotificationPrompt() {
  const pathname = usePathname();
  const tPush = useTranslations("settings.notifications.push");
  const tInstall = useTranslations("pwa_install");
  const { appName } = useConfig();

  const client = useAuthStore((state) => state.client);
  const username = useAuthStore((state) => state.username);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isDemoMode = useAuthStore((state) => state.isDemoMode);
  // Bumped when the background logins finish connecting: the renewal below
  // re-runs then so it reaches them too.
  const connectedAccountsRevision = useAuthStore(
    (state) => state.connectedAccountsRevision,
  );
  const emailNotificationsEnabled = useSettingsStore(
    (state) => state.emailNotificationsEnabled,
  );
  const pushNotifyInboxOnly = useSettingsStore(
    (state) => state.pushNotifyInboxOnly,
  );
  const policyLoaded = usePolicyStore((state) => state.loaded);
  const policy = usePolicyStore((state) => state.policy);
  const userPushRelayUrl = useSettingsStore((state) => state.pushRelayUrl);
  // Sits where the install card does: keep off an open composer's Send button.
  const composing = useUIStore((state) => state.composingCount > 0);

  const [showPrompt, setShowPrompt] = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Session-only dismissal is per account: dismissing on one account must not
  // re-offer the prompt on an account dismissed earlier in the same session.
  const [sessionDismissedAccountIds, setSessionDismissedAccountIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [pwaPromptVisible, setPwaPromptVisible] = useState(
    isPWAInstallPromptVisible,
  );

  const accountId = client?.getAccountId() ?? null;
  // Empty when no relay may be used (third-party traffic off, no own relay).
  const relayBaseUrl = resolveActiveRelayUrl(policy, userPushRelayUrl);

  const dismissForSession = useCallback((id: string) => {
    setSessionDismissedAccountIds((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  }, []);

  // A layout effect subscribes before the browser can paint, so a visibility
  // event dispatched by the PWA prompt during the same commit is not missed.
  useLayoutEffect(() => {
    const handlePwaPromptVisibility = (event: Event) => {
      const visible = (event as CustomEvent<{ visible?: boolean }>).detail?.visible;
      setPwaPromptVisible(visible === true);
    };

    window.addEventListener(
      PWA_INSTALL_PROMPT_VISIBILITY_EVENT,
      handlePwaPromptVisibility,
    );
    setPwaPromptVisible(isPWAInstallPromptVisible());
    return () => {
      window.removeEventListener(
        PWA_INSTALL_PROMPT_VISIBILITY_EVENT,
        handlePwaPromptVisibility,
      );
    };
  }, []);

  // Accounts that already have push on get their registration touched up in
  // the background once per page load: expiry refreshed and the server-side
  // delivery filter installed or repaired (older registrations predate it and
  // would keep waking the device for spam). Deliberately independent of the
  // prompt gating below - dismissing the onboarding prompt must not leave a
  // live registration stale. The prompt in turn waits for this pass, since
  // push reads as "off" while a dropped browser subscription is recreated.
  useEffect(() => {
    if (!policyLoaded || !isAuthenticated || !client || !accountId || isDemoMode) return;
    let cancelled = false;
    const resync = async (force = false) => {
      // One login at a time: they share the browser's single
      // PushSubscription, and a parallel re-create would race on it.
      for (const target of resyncTargets(client, username ?? undefined)) {
        if (cancelled) return;
        await resyncWebPush({
          client: target.client,
          relayBaseUrl,
          accountLabel: target.accountLabel,
          inboxOnly: pushNotifyInboxOnly,
          mutes: useSettingsStore.getState().notificationMutes,
          force,
        });
      }
    };
    void resync();
    // A long-open tab comes back to the foreground: renew the subscription
    // before the server's 7-day expiry (resyncWebPush runs at most daily) and
    // recreate one the browser dropped in the meantime.
    const onVisible = () => { if (document.visibilityState === 'visible') void resync(); };
    document.addEventListener('visibilitychange', onVisible);
    // The service worker saw the push service drop or replace the browser
    // subscription (pushsubscriptionchange in public/sw.js): the relay has to
    // learn the new endpoint now, not at the next daily pass.
    const onSwMessage = (event: MessageEvent) => {
      const kind = (event.data as { kind?: unknown } | null)?.kind;
      if (kind === 'pushsubscriptionchange') void resync(true);
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, [accountId, client, connectedAccountsRevision, isAuthenticated, isDemoMode, policyLoaded, pushNotifyInboxOnly, relayBaseUrl, username]);

  // Muting a folder or account changes the server-side push filter, which the
  // daily renewal above would only send tomorrow. Send it to every login with
  // push on now, after a short pause so a few clicks in a row make one update.
  // Compared by content: a settings sync hands back an equal but new object.
  const notificationMutes = useSettingsStore((state) => state.notificationMutes);
  const mutesKey = JSON.stringify(notificationMutes);
  const lastMutesKey = useRef(mutesKey);
  useEffect(() => {
    if (lastMutesKey.current === mutesKey) return;
    lastMutesKey.current = mutesKey;
    if (!policyLoaded || !isAuthenticated || !client || isDemoMode) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const target of resyncTargets(client, username ?? undefined)) {
        if (cancelled) return;
        await resyncWebPush({
          client: target.client,
          relayBaseUrl,
          accountLabel: target.accountLabel,
          inboxOnly: useSettingsStore.getState().pushNotifyInboxOnly,
          mutes: useSettingsStore.getState().notificationMutes,
          force: true,
        });
      }
    }, MUTES_RESYNC_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Only a change of the mutes should send an update; the rest is read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutesKey]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    setShowPrompt(false);
    setError(null);

    if (
      !policyLoaded
      || !isAuthenticated
      || !client
      || !accountId
      || isDemoMode
      || !emailNotificationsEnabled
      || isExcludedPath(pathname)
      || sessionDismissedAccountIds.has(accountId)
      || pwaPromptVisible
      || wasDismissed(accountId)
      || !isWebPushSupported()
      || Notification.permission === "denied"
      || !relayBaseUrl
    ) {
      return;
    }

    timer = setTimeout(() => {
      // Push can read as "off" only because the background pass above is
      // still recreating a browser subscription Safari dropped (#1321): wait
      // for it, and offer onboarding only if push is still off afterwards.
      void waitForWebPushResync(accountId)
        .then(() => isWebPushEnabled(accountId))
        .then((enabled) => {
          if (!cancelled && !enabled) setShowPrompt(true);
        })
        .catch(() => {
          // Failure to inspect the browser subscription should not trigger an
          // onboarding prompt whose current state we cannot determine.
        });
    }, PUSH_NOTIFICATION_PROMPT_DELAY_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    accountId,
    client,
    emailNotificationsEnabled,
    isAuthenticated,
    isDemoMode,
    pathname,
    policyLoaded,
    pwaPromptVisible,
    relayBaseUrl,
    sessionDismissedAccountIds,
  ]);

  const handleEnable = async () => {
    if (!client) return;
    setIsEnabling(true);
    setError(null);
    try {
      await enableWebPush({
        client,
        relayBaseUrl,
        accountLabel: username ?? undefined,
        inboxOnly: pushNotifyInboxOnly,
        mutes: useSettingsStore.getState().notificationMutes,
      });
      setShowPrompt(false);
    } catch (err) {
      // Readable text for what a user can act on.
      const key = webPushErrorKey(err);
      setError(key ? tPush(key) : err instanceof Error ? err.message : "Failed to enable push");
    } finally {
      setIsEnabling(false);
    }
  };

  const handleDismiss = () => {
    if (accountId) dismissForSession(accountId);
    setShowPrompt(false);
  };

  const handleDismissForever = () => {
    if (accountId) {
      dismissPermanently(accountId);
      dismissForSession(accountId);
    }
    setShowPrompt(false);
  };

  if (!showPrompt || composing) return null;

  return (
    <div className="fixed bottom-4 end-4 z-50 max-w-sm rounded-lg border border-border bg-popover text-popover-foreground shadow-lg p-4 animate-in slide-in-from-bottom-4 max-sm:inset-x-3 max-sm:max-w-none max-sm:bottom-[calc(var(--bottom-controls-height,3.75rem)+0.75rem)]">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <Bell className="w-5 h-5 mt-0.5 text-primary shrink-0" />
          <div>
            <h3 className="font-semibold text-sm text-foreground">
              {tPush("title", { appName })}
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              {tPush("description")}
            </p>
          </div>
        </div>
        <IconButton label={tPush("dismiss_aria")} onClick={handleDismiss} disabled={isEnabling} className="-me-2 -mt-2 text-muted-foreground">
          <X />
        </IconButton>
      </div>
      <div className="flex flex-col gap-2">
        {error ? (
          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" className="flex-1" onClick={handleDismiss} disabled={isEnabling}>
            {tInstall("not_now")}
          </Button>
          <Button type="button" size="sm" className="flex-1 gap-2" onClick={() => void handleEnable()} disabled={isEnabling}>
            {isEnabling ? <Spinner size="sm" className="text-current" /> : null}
            {tPush("enable")}
          </Button>
        </div>
        <Button type="button" variant="ghost" size="xs" className="w-full text-xs text-muted-foreground" onClick={handleDismissForever} disabled={isEnabling}>
          {tInstall("dont_remind")}
        </Button>
      </div>
    </div>
  );
}
