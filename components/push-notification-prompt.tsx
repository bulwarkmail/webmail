"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell, Loader2, X } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  enableWebPush,
  isWebPushEnabled,
  isWebPushSupported,
} from "@/lib/web-push";
import { resolveActiveRelayUrl } from "@/lib/push-relays";
import {
  isPWAInstallPromptVisible,
  PWA_INSTALL_PROMPT_VISIBILITY_EVENT,
} from "@/components/pwa-install-prompt";

const DISMISSED_KEY_PREFIX = "bulwark.push.onboarding.dismissed.v1.";
export const PUSH_NOTIFICATION_PROMPT_DELAY_MS = 1_000;

function dismissedKey(accountId: string): string {
  return `${DISMISSED_KEY_PREFIX}${accountId}`;
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

  const client = useAuthStore((state) => state.client);
  const username = useAuthStore((state) => state.username);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isDemoMode = useAuthStore((state) => state.isDemoMode);
  const emailNotificationsEnabled = useSettingsStore(
    (state) => state.emailNotificationsEnabled,
  );
  const policyLoaded = usePolicyStore((state) => state.loaded);
  const policy = usePolicyStore((state) => state.policy);
  const userPushRelayUrl = useSettingsStore((state) => state.pushRelayUrl);

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
    ) {
      return;
    }

    timer = setTimeout(() => {
      void isWebPushEnabled(accountId)
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
      });
      setShowPrompt(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable push");
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

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-white dark:bg-neutral-900 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-800 p-4 max-w-sm animate-in slide-in-from-bottom-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <Bell className="w-5 h-5 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0" />
          <div>
            <h3 className="font-semibold text-sm text-neutral-900 dark:text-white">
              {tPush("title")}
            </h3>
            <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
              {tPush("description")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={isEnabling}
          className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors disabled:opacity-50"
          aria-label={tPush("dismiss_aria")}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {error ? (
          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleDismiss}
            disabled={isEnabling}
            className="flex-1 px-3 py-2 text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors disabled:opacity-50"
          >
            {tInstall("not_now")}
          </button>
          <button
            type="button"
            onClick={() => void handleEnable()}
            disabled={isEnabling}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {isEnabling ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {tPush("enable")}
          </button>
        </div>
        <button
          type="button"
          onClick={handleDismissForever}
          disabled={isEnabling}
          className="w-full text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors text-center disabled:opacity-50"
        >
          {tInstall("dont_remind")}
        </button>
      </div>
    </div>
  );
}
