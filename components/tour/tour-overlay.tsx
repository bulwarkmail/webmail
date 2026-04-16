"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { useTour } from "./tour-provider";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/hooks/use-focus-trap";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PADDING = 8;
const TOOLTIP_GAP = 12;
const TOOLTIP_MAX_W = 360;

function getTargetRect(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Element might exist but be hidden (zero dimensions)
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function computeTooltipPosition(
  target: Rect,
  placement: "top" | "bottom" | "left" | "right",
  tooltipSize: { width: number; height: number }
): { top: number; left: number; actualPlacement: string } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tw = Math.max(tooltipSize.width, 200); // minimum fallback width
  const th = Math.max(tooltipSize.height, 100); // minimum fallback height

  const positions = {
    bottom: {
      top: target.top + target.height + PADDING + TOOLTIP_GAP,
      left: target.left + target.width / 2 - tw / 2,
    },
    top: {
      top: target.top - PADDING - TOOLTIP_GAP - th,
      left: target.left + target.width / 2 - tw / 2,
    },
    right: {
      top: target.top + target.height / 2 - th / 2,
      left: target.left + target.width + PADDING + TOOLTIP_GAP,
    },
    left: {
      top: target.top + target.height / 2 - th / 2,
      left: target.left - PADDING - TOOLTIP_GAP - tw,
    },
  };

  const fits = (p: { top: number; left: number }) =>
    p.top >= 8 && p.left >= 8 && p.top + th <= vh - 8 && p.left + tw <= vw - 8;

  // Try preferred placement first, then fallback order
  const order: Array<"top" | "bottom" | "left" | "right"> = [placement, "bottom", "right", "left", "top"];
  for (const dir of order) {
    const pos = positions[dir];
    if (fits(pos)) return { ...pos, actualPlacement: dir };
  }

  // If nothing fits perfectly, use preferred but clamped
  const pos = positions[placement];
  return {
    top: Math.max(8, Math.min(pos.top, vh - th - 8)),
    left: Math.max(8, Math.min(pos.left, vw - tw - 8)),
    actualPlacement: placement,
  };
}

export function TourOverlay() {
  const t = useTranslations();
  const { currentStep, totalSteps, steps, nextStep, prevStep, stopTour } = useTour();
  const step = steps[currentStep];

  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use refs for callbacks to avoid stale closures in timers/intervals
  const updatePositionRef = useRef<() => void>(() => {});
  const nextStepRef = useRef<() => void>(() => {});
  nextStepRef.current = nextStep;

  const focusTrapRef = useFocusTrap({
    isActive: visible,
    onEscape: stopTour,
    restoreFocus: true,
  });

  // Set mounted for portal
  useEffect(() => { setMounted(true); }, []);

  const updatePosition = useCallback(() => {
    if (!step) return;
    const rect = getTargetRect(step.target);

    if (rect) {
      setTargetRect(rect);
      if (tooltipRef.current) {
        const { width, height } = tooltipRef.current.getBoundingClientRect();
        const pos = computeTooltipPosition(rect, step.placement, { width, height });
        setTooltipPos({ top: pos.top, left: pos.left });
      }
    }
    // If rect is null, keep previous targetRect (element temporarily hidden during scroll/resize)
    // Only the step-change effect should null out targetRect
  }, [step]);

  // Keep ref in sync
  updatePositionRef.current = updatePosition;

  // Wait for target element to appear, then show
  useEffect(() => {
    if (!step) return;
    console.log(`[Tour] Step ${currentStep + 1}/${totalSteps}: "${step.id}" - target: ${step.target}, placement: ${step.placement}, interactive: ${!!step.interactive}`);
    setVisible(false);
    // Keep old targetRect and tooltipPos so the cutout/tooltip animate to the new position
    // instead of disappearing and reappearing

    // Clear any pending timer from a previous step
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }

    // Run beforeAction if defined (e.g. click an email to open the viewer)
    if (step.beforeAction) {
      step.beforeAction();
    }

    let attempts = 0;
    const maxAttempts = 50; // 5 seconds
    let cancelled = false;

    const tryFind = () => {
      if (cancelled) return true;
      const el = document.querySelector(step.target);
      if (el) {
        const rect = el.getBoundingClientRect();
        console.log(`[Tour] Step ${currentStep + 1} "${step.id}": element FOUND (${rect.width}x${rect.height} at ${Math.round(rect.left)},${Math.round(rect.top)})`);
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        // Delay after scroll for layout to settle
        pendingTimerRef.current = setTimeout(() => {
          if (cancelled) return;
          console.log(`[Tour] Step ${currentStep + 1} "${step.id}": showing tooltip`);
          updatePositionRef.current();
          setVisible(true);
          // Second position update after tooltip renders with final dimensions
          requestAnimationFrame(() => {
            if (!cancelled) updatePositionRef.current();
          });
        }, 200);
        return true;
      }
      if (attempts % 10 === 0) {
        console.log(`[Tour] Step ${currentStep + 1} "${step.id}": element NOT found (attempt ${attempts + 1}/${maxAttempts})`);
      }
      return false;
    };

    if (tryFind()) return () => { cancelled = true; };

    // Poll for element appearance (for page navigation)
    const interval = setInterval(() => {
      attempts++;
      if (tryFind() || attempts >= maxAttempts) {
        clearInterval(interval);
        if (attempts >= maxAttempts && !cancelled) {
          // Skip this step if element never appears
          console.warn(`[Tour] Step ${currentStep + 1} "${step.id}": SKIPPED - element never appeared after ${maxAttempts} attempts`);
          nextStepRef.current();
        }
      }
    }, 100);

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, [step, currentStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recalculate on resize/scroll (debounced)
  useEffect(() => {
    if (!visible) return;
    let rafId: number | null = null;
    const handler = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        updatePosition();
      });
    };
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [visible, updatePosition]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        nextStep();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        prevStep();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        stopTour();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [nextStep, prevStep, stopTour]);

  // Re-position after tooltip content renders with new dimensions
  useEffect(() => {
    if (!visible || !tooltipRef.current) return;
    // Use rAF to wait for the browser to lay out the tooltip content
    const id = requestAnimationFrame(() => {
      updatePosition();
    });
    return () => cancelAnimationFrame(id);
  }, [visible, updatePosition, currentStep]);

  if (!mounted || !step) return null;

  const cutout = targetRect
    ? {
        x: targetRect.left - PADDING,
        y: targetRect.top - PADDING,
        w: targetRect.width + PADDING * 2,
        h: targetRect.height + PADDING * 2,
      }
    : null;

  const isLast = currentStep >= totalSteps - 1;
  const isFirst = currentStep === 0;
  const isInteractive = step.interactive;

  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const transitionStyle = reducedMotion ? "none" : "all 300ms ease";

  return createPortal(
    <>
      {/* SVG overlay with cutout */}
      <svg
        className="fixed inset-0 z-[9998]"
        width="100%"
        height="100%"
        style={{ pointerEvents: isInteractive ? "none" : "auto" }}
        onClick={stopTour}
      >
        <defs>
          <mask id="tour-mask">
            <rect fill="white" width="100%" height="100%" />
            {cutout && (
              <rect
                fill="black"
                x={cutout.x}
                y={cutout.y}
                width={cutout.w}
                height={cutout.h}
                rx="8"
                style={{ transition: transitionStyle }}
              />
            )}
          </mask>
        </defs>
        <rect
          fill="black"
          opacity="0.5"
          mask="url(#tour-mask)"
          width="100%"
          height="100%"
        />
      </svg>

      {/* Click-through cutout zone for interactive steps */}
      {isInteractive && cutout && (
        <div
          className="fixed z-[9998]"
          style={{
            top: cutout.y,
            left: cutout.x,
            width: cutout.w,
            height: cutout.h,
            pointerEvents: "none",
            transition: transitionStyle,
          }}
        />
      )}

      {/* Non-interactive overlay click blocker around cutout */}
      {!isInteractive && cutout && (
        <div
          className="fixed z-[9998]"
          style={{
            top: cutout.y,
            left: cutout.x,
            width: cutout.w,
            height: cutout.h,
            pointerEvents: "none",
          }}
        />
      )}

      {/* Tooltip */}
      <div
        ref={(node) => {
          (tooltipRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
          (focusTrapRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t(step.titleKey)}
        className={cn(
          "fixed z-[9999] transition-all",
          visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
        )}
        style={{
          top: tooltipPos?.top ?? -9999,
          left: tooltipPos?.left ?? -9999,
          maxWidth: TOOLTIP_MAX_W,
          transition: reducedMotion ? "none" : "opacity 200ms ease, transform 200ms ease, top 300ms ease, left 300ms ease",
          pointerEvents: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-background border border-border rounded-xl shadow-2xl p-4">
          {/* Step counter */}
          <p className="text-xs text-muted-foreground mb-1" aria-live="polite">
            {t("tour.step_counter", { current: currentStep + 1, total: totalSteps })}
          </p>

          {/* Title */}
          <h3 className="font-semibold text-sm text-foreground">{t(step.titleKey)}</h3>

          {/* Description */}
          <p className="text-sm text-muted-foreground mt-1">{t(step.descriptionKey)}</p>

          {/* Navigation buttons */}
          <div className="flex items-center justify-between mt-3">
            <button
              onClick={stopTour}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
            >
              {t("tour.skip")}
            </button>
            <div className="flex gap-2">
              <button
                onClick={prevStep}
                disabled={isFirst}
                className={cn(
                  "text-xs px-3 py-1.5 rounded-md border border-border transition-colors",
                  isFirst
                    ? "opacity-40 cursor-not-allowed"
                    : "hover:bg-muted"
                )}
              >
                {t("tour.back")}
              </button>
              <button
                onClick={nextStep}
                className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {isLast ? t("tour.finish") : t("tour.next")}
              </button>
            </div>
          </div>

          {/* Progress dots */}
          <div className="flex justify-center gap-1 mt-2">
            {steps.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "w-1.5 h-1.5 rounded-full transition-colors",
                  i === currentStep ? "bg-primary" : "bg-muted-foreground/30"
                )}
              />
            ))}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
