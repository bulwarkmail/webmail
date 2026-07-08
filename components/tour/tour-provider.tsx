"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useWebDAVStore } from "@/stores/webdav-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePolicyStore } from "@/stores/policy-store";
import { getTourSteps, type TourStep } from "./tour-steps";
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
  hasCompletedTour: boolean;
  resetTourCompletion: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used within TourProvider");
  return ctx;
}

export function TourProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isDemoMode } = useAuthStore();
  const { supportsCalendar } = useCalendarStore();
  const calendarEnabled = usePolicyStore((s) => s.isFeatureEnabled('calendarEnabled'));
  const { supportsWebDAV } = useWebDAVStore();
  const tourCompleted = useSettingsStore((s) => s.tourCompleted);
  const showOnboardingOnNewDevices = useSettingsStore((s) => s.showOnboardingOnNewDevices);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const [isActive, setIsActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [hasCompletedTour, setHasCompletedTour] = useState(false);

  const steps = getTourSteps({ isDemoMode, supportsCalendar: supportsCalendar && calendarEnabled, supportsWebDAV: supportsWebDAV !== false });

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

  const startTour = useCallback(() => {
    let resumeStep = 0;
    try {
      const stored = localStorage.getItem(TOUR_CURRENT_STEP_KEY);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed) && parsed >= 0) resumeStep = parsed;
      }
    } catch { /* */ }

    // If the resume step is beyond the current steps, start from 0
    if (resumeStep >= steps.length) resumeStep = 0;

    // Most steps live on the mailbox - navigate there (or to the step's specific page)
    // so we don't start the tour on a page where the targets don't exist.
    const targetPage = steps[resumeStep]?.page ?? "/";
    if (pathname !== targetPage) {
      router.push(targetPage);
    }

    setCurrentStep(resumeStep);
    setIsActive(true);
  }, [steps, pathname, router]);

  const stopTour = useCallback(() => {
    setIsActive(false);
    try {
      localStorage.removeItem(TOUR_CURRENT_STEP_KEY);
    } catch { /* */ }
  }, []);

  const completeTour = useCallback(() => {
    setIsActive(false);
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
    const next = currentStep + 1;
    const nextStepDef = steps[next];
    const currentStepDef = steps[currentStep];
    setCurrentStep(next);
    try {
      localStorage.setItem(TOUR_CURRENT_STEP_KEY, String(next));
    } catch { /* */ }

    // Navigate when the next step is on a different page (treat "no page" as the mailbox)
    const nextPage = nextStepDef?.page ?? "/";
    const currentPage = currentStepDef?.page ?? "/";
    if (nextPage !== currentPage) {
      router.push(nextPage);
    }
  }, [currentStep, steps, completeTour, router]);

  const prevStep = useCallback(() => {
    if (currentStep <= 0) return;
    const prev = currentStep - 1;
    const prevStepDef = steps[prev];
    setCurrentStep(prev);
    try {
      localStorage.setItem(TOUR_CURRENT_STEP_KEY, String(prev));
    } catch { /* */ }

    if (prevStepDef?.page) {
      router.push(prevStepDef.page);
    } else if (steps[currentStep]?.page) {
      // Going back from a page-specific step to a non-page step => go to mail
      router.push("/");
    }
  }, [currentStep, steps, router]);

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
