"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useShallow } from "zustand/react/shallow";
import { useCalendarStore } from "@/stores/calendar-store";
import { useWebDAVStore } from "@/stores/webdav-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePolicyStore } from "@/stores/policy-store";
import { getTourSteps, isTourStepOnPage, proTabOfTourStep, type TourStep } from "./tour-steps";
import { useProInterfaceActive } from "@/components/pro/pro-interface-redirect";
import { useProTabStore } from "@/stores/pro-tab-store";
import { useIsMobile, useMediaQuery } from "@/hooks/use-media-query";
import { requestAppCommand } from "@/lib/app-commands";
import { TourOverlay } from "./tour-overlay";

const TOUR_COMPLETED_KEY = "tour_completed";
const TOUR_CURRENT_STEP_KEY = "tour_current_step";

interface TourContextValue {
  isActive: boolean;
  currentStep: number;
  totalSteps: number;
  steps: TourStep[];
  startTour: () => void;
  stopTour: () => void;
  nextStep: () => void;
  prevStep: () => void;
  /**
   * Drops the current step, which has nothing to point at, from this run of
   * the tour, so the counter only ever counts steps that show. `direction`
   * is the way the user was going.
   */
  skipStep: (direction: 1 | -1) => void;
  hasCompletedTour: boolean;
  resetTourCompletion: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used within TourProvider");
  return ctx;
}

function rememberStep(step: TourStep | undefined) {
  try {
    if (step) localStorage.setItem(TOUR_CURRENT_STEP_KEY, step.id);
  } catch { /* */ }
}

export function TourProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const proActive = useProInterfaceActive();
  const { isDemoMode } = useAuthStore(useShallow((state) => ({ isDemoMode: state.isDemoMode })));
  const { supportsCalendar } = useCalendarStore(useShallow((state) => ({ supportsCalendar: state.supportsCalendar })));
  const calendarEnabled = usePolicyStore((s) => s.isFeatureEnabled('calendarEnabled'));
  const { supportsWebDAV } = useWebDAVStore(useShallow((state) => ({ supportsWebDAV: state.supportsWebDAV })));
  const tourCompleted = useSettingsStore((s) => s.tourCompleted);
  const showOnboardingOnNewDevices = useSettingsStore((s) => s.showOnboardingOnNewDevices);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const [isActive, setIsActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [hasCompletedTour, setHasCompletedTour] = useState(false);

  const client = useAuthStore((s) => s.client);
  const contactsEnabled = usePolicyStore((s) => s.isFeatureEnabled('contactsEnabled'));
  const touch = useMediaQuery("(pointer: coarse)");
  const phone = useIsMobile();
  // Steps found to have nothing to point at during this run of the tour.
  const [skipped, setSkipped] = useState<string[]>([]);

  const allSteps = getTourSteps({
    isDemoMode,
    supportsCalendar: supportsCalendar && calendarEnabled,
    supportsWebDAV: supportsWebDAV !== false,
    supportsContacts: (client?.supportsContacts?.() ?? false) && contactsEnabled,
    touch,
    phone,
  });
  const steps = skipped.length ? allSteps.filter((s) => !skipped.includes(s.id)) : allSteps;
  const step = isActive ? steps[currentStep] : undefined;

  // Take the user to the app the step is about. On a phone the open message
  // covers the list and the tab bar, so every Mail step but the reader's own
  // closes it first.
  useEffect(() => {
    if (!step) return;
    // Under Pro every app is a tab of the one route. Asking for another route
    // only comes back here, which went round for as long as the tour ran. The
    // path says nothing here: it may show the address the focused tab wrote.
    if (proActive) {
      const tab = proTabOfTourStep(step);
      if (tab) useProTabStore.getState().openTab(tab);
      return;
    }
    if (!isTourStepOnPage(step, pathname)) {
      router.push(step.page ?? "/");
    } else if (phone && !step.page && step.view !== "reader") {
      requestAppCommand("show-list");
    }
  }, [step, pathname, phone, router, proActive]);

  useEffect(() => {
    // One-time migration: if the legacy per-device flag is set but the synced
    // setting isn't yet, mirror it into synced state.
    try {
      const legacy = localStorage.getItem(TOUR_COMPLETED_KEY) === "true";
      if (legacy && !tourCompleted) {
        updateSetting("tourCompleted", true);
      }
    } catch { /* */ }
  }, [tourCompleted, updateSetting]);

  useEffect(() => {
    if (!tourCompleted) {
      setHasCompletedTour(false);
      return;
    }
    if (showOnboardingOnNewDevices) {
      try {
        setHasCompletedTour(localStorage.getItem(TOUR_COMPLETED_KEY) === "true");
        return;
      } catch { /* */ }
    }
    setHasCompletedTour(true);
  }, [tourCompleted, showOnboardingOnNewDevices]);

  // A fresh run gives every step its chance again; the effect above takes the
  // user to the first step's app.
  const startTour = useCallback(() => {
    let resumeStep = 0;
    try {
      const stored = localStorage.getItem(TOUR_CURRENT_STEP_KEY);
      const index = stored ? allSteps.findIndex((s) => s.id === stored) : -1;
      if (index >= 0) resumeStep = index;
    } catch { /* */ }

    setSkipped([]);
    setCurrentStep(resumeStep);
    setIsActive(true);
  }, [allSteps]);

  // Finished or skipped at any step, Mail closes the reader and the composer
  // the tour opened and is back at its list. Not on Mail, it shows the list
  // the next time it opens.
  const stopTour = useCallback(() => {
    setIsActive(false);
    requestAppCommand("tour-end");
    try {
      localStorage.removeItem(TOUR_CURRENT_STEP_KEY);
    } catch { /* */ }
  }, []);

  const completeTour = useCallback(() => {
    setIsActive(false);
    requestAppCommand("tour-end");
    setHasCompletedTour(true);
    updateSetting("tourCompleted", true);
    try {
      localStorage.setItem(TOUR_COMPLETED_KEY, "true");
      localStorage.removeItem(TOUR_CURRENT_STEP_KEY);
    } catch { /* */ }
  }, [updateSetting]);

  const nextStep = useCallback(() => {
    if (currentStep >= steps.length - 1) {
      completeTour();
      return;
    }
    setCurrentStep(currentStep + 1);
    rememberStep(steps[currentStep + 1]);
  }, [currentStep, steps, completeTour]);

  const prevStep = useCallback(() => {
    if (currentStep <= 0) return;
    setCurrentStep(currentStep - 1);
    rememberStep(steps[currentStep - 1]);
  }, [currentStep, steps]);

  const skipStep = useCallback((direction: 1 | -1) => {
    const current = steps[currentStep];
    if (!current) return;
    const rest = steps.filter((s) => s !== current);
    // Going on, the next step moves up into this index; going back, the
    // previous one is a place lower (at the start, the next one shows).
    const index = direction === -1 && currentStep > 0 ? currentStep - 1 : currentStep;
    if (index >= rest.length) {
      completeTour();
      return;
    }
    setSkipped((ids) => [...ids, current.id]);
    setCurrentStep(index);
    rememberStep(rest[index]);
  }, [currentStep, steps, completeTour]);

  const resetTourCompletion = useCallback(() => {
    setHasCompletedTour(false);
    updateSetting("tourCompleted", false);
    try {
      localStorage.removeItem(TOUR_COMPLETED_KEY);
      localStorage.removeItem(TOUR_CURRENT_STEP_KEY);
    } catch { /* */ }
  }, [updateSetting]);

  const value: TourContextValue = {
    isActive,
    currentStep,
    totalSteps: steps.length,
    steps,
    startTour,
    stopTour,
    nextStep,
    prevStep,
    skipStep,
    hasCompletedTour,
    resetTourCompletion,
  };

  return (
    <TourContext.Provider value={value}>
      {children}
      {isActive && <TourOverlay />}
    </TourContext.Provider>
  );
}
