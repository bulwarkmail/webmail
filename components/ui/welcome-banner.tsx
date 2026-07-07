"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { X, Lightbulb, Settings, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { useTour } from "@/components/tour/tour-provider";
import { useSettingsStore } from "@/stores/settings-store";

const ONBOARDING_KEY = "onboarding_completed";

export function WelcomeBanner() {
  const t = useTranslations("welcome");
  const router = useRouter();
  const { startTour } = useTour();
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
  const showOnboardingOnNewDevices = useSettingsStore((s) => s.showOnboardingOnNewDevices);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // One-time migration: if the legacy per-device flag is set but the synced
    // setting isn't yet, mirror it into synced state so the user isn't shown
    // the banner again on this device after the upgrade.
    try {
      const legacy = localStorage.getItem(ONBOARDING_KEY) === "true";
      if (legacy && !onboardingCompleted) {
        updateSetting("onboardingCompleted", true);
      }
    } catch { /* localStorage unavailable */ }
  }, [onboardingCompleted, updateSetting]);

  useEffect(() => {
    if (!onboardingCompleted) {
      setVisible(true);
      return;
    }
    if (showOnboardingOnNewDevices) {
      try {
        if (localStorage.getItem(ONBOARDING_KEY) !== "true") {
          setVisible(true);
          return;
        }
      } catch { /* localStorage unavailable */ }
    }
    setVisible(false);
  }, [onboardingCompleted, showOnboardingOnNewDevices]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    updateSetting("onboardingCompleted", true);
    try {
      localStorage.setItem(ONBOARDING_KEY, "true");
    } catch { /* localStorage unavailable */ }
  }, [updateSetting]);

  useEffect(() => {
    if (!visible) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [visible, dismiss]);

  if (!visible) return null;

  return (
    <div
      role="complementary"
      aria-label={t("title")}
      className={`border-b border-border bg-accent/30 transition-all duration-300 ease-out ${
        dismissed ? "opacity-0 scale-y-0 max-h-0 pointer-events-none" : "opacity-100 scale-y-100 max-h-96"
      }`}
      onTransitionEnd={() => {
        if (dismissed) setVisible(false);
      }}
    >
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5 p-1.5 rounded-md bg-primary/10">
              <Lightbulb className="w-4 h-4 text-primary" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-sm font-medium text-foreground">
                {t("title")}
              </h3>
              <ul className="space-y-1 text-sm text-muted-foreground">
                <li>{t("tip_compose")}</li>
                <li>{t("tip_shortcuts")}</li>
                <li>{t("tip_sidebar")}</li>
                <li>{t("tip_settings")}</li>
              </ul>
            </div>
          </div>
          <button
            onClick={dismiss}
            className="flex-shrink-0 p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground"
            aria-label={t("dismiss")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-2.5 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { dismiss(); startTour(); }}
            className="text-xs h-7"
          >
            <PlayCircle className="w-3.5 h-3.5 me-1" />
            {t("start_tour")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { dismiss(); router.push('/settings'); }}
            className="text-xs h-7"
          >
            <Settings className="w-3.5 h-3.5 me-1" />
            {t("settings")}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={dismiss}
            className="text-xs h-7"
          >
            {t("got_it")}
          </Button>
        </div>
      </div>
    </div>
  );
}
