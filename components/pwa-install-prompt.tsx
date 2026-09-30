"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { X, Download } from "@/components/icons";
import { useConfig } from "@/hooks/use-config";
import { withBasePath } from "@/lib/browser-navigation";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "pwa-install-dismissed";
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

  useEffect(() => {
    if (localStorage.getItem(DISMISSED_KEY)) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  useEffect(() => {
    promptVisible = showPrompt;
    window.dispatchEvent(
      new CustomEvent(PWA_INSTALL_PROMPT_VISIBILITY_EVENT, {
        detail: { visible: showPrompt },
      }),
    );
    return () => {
      if (showPrompt) promptVisible = false;
    };
  }, [showPrompt]);

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
    setShowPrompt(false);
  };

  const handleDismissForever = () => {
    localStorage.setItem(DISMISSED_KEY, "1");
    setShowPrompt(false);
  };

  if (!showPrompt || !deferredPrompt) {
    return null;
  }

  const logoSrc = withBasePath(appLogoLightUrl || faviconUrl);
  const darkLogoSrc = withBasePath(appLogoDarkUrl || faviconUrl);

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-white dark:bg-neutral-900 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-800 p-4 max-w-sm animate-in slide-in-from-bottom-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          {logoSrc ? (
            <img
              src={logoSrc}
              alt={appName}
              className="w-8 h-8 shrink-0 object-contain dark:hidden"
            />
          ) : (
            <Download className="w-5 h-5 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0" />
          )}
          {logoSrc && (
            <img
              src={darkLogoSrc}
              alt={appName}
              className="w-8 h-8 shrink-0 object-contain hidden dark:block"
            />
          )}
          <div>
            <h3 className="font-semibold text-sm text-neutral-900 dark:text-white">
              {t("title", { appName })}
            </h3>
            <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
              {t("description")}
            </p>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
          aria-label={t("dismiss_aria")}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            onClick={handleDismiss}
            className="flex-1 px-3 py-2 text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
          >
            {t("not_now")}
          </button>
          <button
            onClick={handleInstall}
            className="flex-1 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors"
          >
            {t("install")}
          </button>
        </div>
        <button
          onClick={handleDismissForever}
          className="w-full text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors text-center"
        >
          {t("dont_remind")}
        </button>
      </div>
    </div>
  );
}
