"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { X, Lightbulb, Settings, PlayCircle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useRouter } from "@/i18n/navigation";
import { useTour } from "@/components/tour/tour-provider";
import { useSettingsStore } from "@/stores/settings-store";
import { useDeviceDetection } from "@/hooks/use-media-query";

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
  // A phone has no keyboard shortcuts and keeps the apps in the bottom bar.
  const { isMobile } = useDeviceDetection();

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

  // No Escape handler: Escape closes whatever has the focus (a message, a
  // dialog, a selection) and must not hide these tips for good (R8). The X
  // and "Got it" dismiss them.

  if (!visible) return null;

  return (
    <div
      role="complementary"
      aria-label={t("title")}
      className={`border-b border-border bg-accent/30 transition-all duration-300 ease-out ${
        dismissed ? "opacity-0 scale-y-0 max-h-0 pointer-events-none" : "opacity-100 scale-y-100 max-h-[min(24rem,40dvh)] [@media(max-height:480px)]:max-h-[30dvh] overflow-y-auto"
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
                <li>{isMobile ? t("tip_compose_touch") : t("tip_compose")}</li>
                {!isMobile && <li>{t("tip_shortcuts")}</li>}
                <li>{isMobile ? t("tip_sidebar_touch") : t("tip_sidebar")}</li>
                <li>{t("tip_settings")}</li>
              </ul>
            </div>
          </div>
          <IconButton label={t("dismiss")} onClick={dismiss} className="flex-shrink-0 text-muted-foreground">
            <X />
          </IconButton>
        </div>
        <div className="mt-2.5 flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() => { dismiss(); startTour(); }}
            className="text-xs"
          >
            <PlayCircle className="w-3.5 h-3.5 me-1" />
            {t("start_tour")}
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => { dismiss(); router.push('/settings'); }}
            className="text-xs"
          >
            <Settings className="w-3.5 h-3.5 me-1" />
            {t("settings")}
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={dismiss}
            className="text-xs"
          >
            {t("got_it")}
          </Button>
        </div>
      </div>
    </div>
  );
}
