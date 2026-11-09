"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { X, Download } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useConfig } from "@/hooks/use-config";
import { withBasePath } from "@/lib/browser-navigation";
import { useUIStore } from "@/stores/ui-store";
import { useStrictestDevices } from "@/hooks/use-device-policy";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "pwa-install-dismissed";
// "Not now" holds the card back for a week, in every account on this browser.
const SNOOZED_UNTIL_KEY = "pwa-install-snoozed-until";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function isDismissed(): boolean {
  try {
    if (localStorage.getItem(DISMISSED_KEY)) return true;
    const snoozedUntil = Number(localStorage.getItem(SNOOZED_UNTIL_KEY));
    return snoozedUntil > Date.now();
  } catch {
    return false;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* localStorage may be unavailable */ }
}

export const PWA_INSTALL_PROMPT_VISIBILITY_EVENT =
  "bulwark:pwa-install-prompt-visibility";

// Mirrors the last dispatched visibility so a listener that mounts after the
// event was fired can still read the current state instead of assuming hidden.
let promptVisible = false;

export function isPWAInstallPromptVisible(): boolean {
  return promptVisible;
}

export function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const { appName, faviconUrl, appLogoLightUrl, appLogoDarkUrl } = useConfig();
  const t = useTranslations("pwa_install");
  // Stays "visible" for the push prompt's sake while a composer is open, so
  // that card doesn't take its place over the Send button either.
  const composing = useUIStore((state) => state.composingCount > 0);
  // Organisation > Devices > No install prompt, if any account signed in
  // here has it: no card, and the browser's own install banner is held back
  // too. The browser's menu can still install Bulwark.
  const noInstallPrompt = useStrictestDevices().noInstallPrompt;

  useEffect(() => {
    if (noInstallPrompt) {
      const suppress = (e: Event) => e.preventDefault();
      window.addEventListener("beforeinstallprompt", suppress);
      return () => window.removeEventListener("beforeinstallprompt", suppress);
    }
    if (isDismissed()) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, [noInstallPrompt]);

  const visible = showPrompt && !noInstallPrompt;
  useEffect(() => {
    promptVisible = visible;
    window.dispatchEvent(
      new CustomEvent(PWA_INSTALL_PROMPT_VISIBILITY_EVENT, {
        detail: { visible },
      }),
    );
    return () => {
      if (visible) promptVisible = false;
    };
  }, [visible]);

  const handleInstall = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    await deferredPrompt.userChoice;

    // A beforeinstallprompt event can only be consumed once. Close the card
    // whether the browser prompt was accepted or dismissed so the next
    // onboarding step can continue in the same session.
    setDeferredPrompt(null);
    setShowPrompt(false);
  };

  const handleDismiss = () => {
    remember(SNOOZED_UNTIL_KEY, String(Date.now() + SNOOZE_MS));
    setShowPrompt(false);
  };

  const handleDismissForever = () => {
    remember(DISMISSED_KEY, "1");
    setShowPrompt(false);
  };

  if (!visible || !deferredPrompt || composing) {
    return null;
  }

  const logoSrc = withBasePath(appLogoLightUrl || faviconUrl);
  const darkLogoSrc = withBasePath(appLogoDarkUrl || faviconUrl);

  return (
    <div className="fixed bottom-4 end-4 z-50 max-w-sm rounded-lg border border-border bg-popover text-popover-foreground shadow-lg p-4 animate-in slide-in-from-bottom-4 max-sm:inset-x-3 max-sm:max-w-none max-sm:bottom-[calc(var(--bottom-controls-height,3.75rem)+0.75rem)]">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          {logoSrc ? (
            <img
              src={logoSrc}
              alt={appName}
              className="w-8 h-8 shrink-0 object-contain dark:hidden"
            />
          ) : (
            <Download className="w-5 h-5 mt-0.5 text-primary shrink-0" />
          )}
          {logoSrc && (
            <img
              src={darkLogoSrc}
              alt={appName}
              className="w-8 h-8 shrink-0 object-contain hidden dark:block"
            />
          )}
          <div>
            <h3 className="font-semibold text-sm text-foreground">
              {t("title", { appName })}
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              {t("description")}
            </p>
          </div>
        </div>
        <IconButton label={t("dismiss_aria")} onClick={handleDismiss} className="-me-2 -mt-2 text-muted-foreground">
          <X />
        </IconButton>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" className="flex-1" onClick={handleDismiss}>
            {t("not_now")}
          </Button>
          <Button type="button" size="sm" className="flex-1" onClick={handleInstall}>
            {t("install")}
          </Button>
        </div>
        <Button type="button" variant="ghost" size="xs" className="w-full text-xs text-muted-foreground" onClick={handleDismissForever}>
          {t("dont_remind")}
        </Button>
      </div>
    </div>
  );
}
