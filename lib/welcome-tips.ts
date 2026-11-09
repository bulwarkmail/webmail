import { useSettingsStore } from "@/stores/settings-store";

/** The device's own "seen the welcome tips" flag (components/ui/welcome-banner.tsx). */
export const ONBOARDING_KEY = "onboarding_completed";

/** The tips won't show again on this device, nor for this account. */
export function markWelcomeTipsSeen(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, "true");
  } catch { /* localStorage unavailable */ }
  try {
    useSettingsStore.getState().updateSetting("onboardingCompleted", true);
  } catch { /* settings not loaded */ }
}
