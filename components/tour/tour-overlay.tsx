"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { useTour } from "./tour-provider";
import { cn } from "@/lib/utils";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { Button } from "@/components/ui/button";
import { isEditableEventTarget } from "@/lib/keyboard";
import { isDocumentRTL } from "@/i18n/direction";
import { findTourTarget, isTourStepOnPage } from "./tour-steps";
import { usePathname } from "@/i18n/navigation";
import { useIsMobile } from "@/hooks/use-media-query";
import { prefersReducedMotion, scrollBehavior } from "@/lib/reduced-motion";

export { findTourTarget };

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
  const el = findTourTarget(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** Polls (100 ms apart) before a step whose target is in the DOM but has no size is skipped. */
const HIDDEN_TARGET_ATTEMPTS = 10;
/** Polls before a step whose target never appeared (another page loading) is skipped. */
const MISSING_TARGET_ATTEMPTS = 50;
/** Polls while the step's app is still loading (a first visit compiles it in development). */
const PAGE_LOAD_ATTEMPTS = 300;

export function computeTooltipPosition(
  target: Rect,
  placement: "top" | "bottom" | "left" | "right",
  tooltipSize: { width: number; height: number }
): { top: number; left: number; actualPlacement: string } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // minimum fallback width; never wider than the screen, measured off screen it can be
  const tw = Math.min(Math.max(tooltipSize.width, 200), vw - 16);
  const th = Math.max(tooltipSize.height, 100); // minimum fallback height

  // Along the side it sits on, the card slides to stay on screen: above a
  // tab at the end of the phone's tab bar it can't be centred on the tab.
  const alongX = (left: number) => Math.max(8, Math.min(left, vw - tw - 8));
  const alongY = (top: number) => Math.max(8, Math.min(top, vh - th - 8));
  const positions = {
    bottom: {
      top: target.top + target.height + PADDING + TOOLTIP_GAP,
      left: alongX(target.left + target.width / 2 - tw / 2),
    },
    top: {
      top: target.top - PADDING - TOOLTIP_GAP - th,
      left: alongX(target.left + target.width / 2 - tw / 2),
    },
    right: {
      top: alongY(target.top + target.height / 2 - th / 2),
      left: target.left + target.width + PADDING + TOOLTIP_GAP,
    },
    left: {
      top: alongY(target.top + target.height / 2 - th / 2),
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
  const { currentStep, totalSteps, steps, nextStep, prevStep, skipStep, stopTour } = useTour();
  const step = steps[currentStep];
  const phone = useIsMobile();
  // The same anchor can be in the app being left (the tab bar in Settings
  // while Files loads): look for the target only once the step's app is up.
  const pathname = usePathname();
  const onPageRef = useRef(true);
  onPageRef.current = !step || isTourStepOnPage(step, pathname);

  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use refs for callbacks to avoid stale closures in timers/intervals
  const updatePositionRef = useRef<() => void>(() => {});
  const skipStepRef = useRef<(direction: 1 | -1) => void>(() => {});
  // A step with nothing to point at is skipped in the direction the user went.
  const directionRef = useRef<1 | -1>(1);
  const goNext = useCallback(() => { directionRef.current = 1; nextStep(); }, [nextStep]);
  const goPrev = useCallback(() => { directionRef.current = -1; prevStep(); }, [prevStep]);
  skipStepRef.current = skipStep;

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
    let cancelled = false;

    const tryFind = () => {
      if (cancelled) return true;
      if (!onPageRef.current) return false;
      const el = findTourTarget(step.target);
      if (el) {
        el.scrollIntoView({ behavior: scrollBehavior(), block: "nearest" });
        // Delay after scroll for layout to settle
        pendingTimerRef.current = setTimeout(() => {
          if (cancelled) return;
          updatePositionRef.current();
          setVisible(true);
          // Second position update after tooltip renders with final dimensions
          requestAnimationFrame(() => {
            if (!cancelled) updatePositionRef.current();
          });
        }, 200);
        return true;
      }
      return false;
    };

    if (tryFind()) return () => { cancelled = true; };

    // Poll for the element to appear (another page loading). One that is in
    // the DOM but not rendered in this layout (the rail on a phone) is given
    // up on sooner.
    let loading = 0;
    const interval = setInterval(() => {
      if (!onPageRef.current && ++loading < PAGE_LOAD_ATTEMPTS) return;
      attempts++;
      if (tryFind()) {
        clearInterval(interval);
        return;
      }
      const limit = document.querySelector(step.target) ? HIDDEN_TARGET_ATTEMPTS : MISSING_TARGET_ATTEMPTS;
      if (attempts >= limit) {
        clearInterval(interval);
        if (cancelled) return;
        // Dropped from this run, so the counter never counts it.
        skipStepRef.current(directionRef.current);
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
  }, [step, currentStep]);

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

  // Keyboard navigation. Enter on a focused button (Skip, Back) and keys
  // typed into a field (the search step) are theirs, not the tour's.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const onControl = e.target instanceof HTMLElement && !!e.target.closest("button, a[href]");
      const typing = isEditableEventTarget(e);
      // The arrow pointing the way you read goes on: → in LTR, ← in RTL.
      const forward = isDocumentRTL() ? "ArrowLeft" : "ArrowRight";
      const back = isDocumentRTL() ? "ArrowRight" : "ArrowLeft";
      if ((e.key === forward && !typing) || (e.key === "Enter" && !onControl && !typing)) {
        e.preventDefault();
        e.stopPropagation();
        goNext();
      } else if (e.key === back && !typing) {
        e.preventDefault();
        e.stopPropagation();
        goPrev();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        stopTour();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [goNext, goPrev, stopTour]);

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

  const reducedMotion = typeof window !== "undefined" && prefersReducedMotion();

  const transitionStyle = reducedMotion ? "none" : "all 300ms ease";

  return createPortal(
    <>
      {/* SVG overlay with cutout */}
      <svg
        data-tour-layer=""
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
          data-tour-layer=""
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
          data-tour-layer=""
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
        data-tour-layer=""
        role="dialog"
        aria-modal="true"
        aria-label={t(step.titleKey)}
        aria-hidden={!visible || undefined}
        className={cn(
          "fixed z-[9999] transition-all",
          // While the next target is looked for, the card is not there at
          // all: an invisible card would still catch taps.
          visible ? "opacity-100 translate-y-0" : "invisible opacity-0 translate-y-2"
        )}
        style={{
          top: tooltipPos?.top ?? -9999,
          left: tooltipPos?.left ?? -9999,
          // A margin of 8 on both sides, like the placement keeps.
          maxWidth: `min(${TOOLTIP_MAX_W}px, calc(100vw - 16px))`,
          transition: reducedMotion ? "none" : "opacity 200ms ease, transform 200ms ease, top 300ms ease, left 300ms ease",
          pointerEvents: visible ? "auto" : "none",
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
          <p className="text-sm text-muted-foreground mt-1">{t(phone && step.phoneDescriptionKey ? step.phoneDescriptionKey : step.descriptionKey)}</p>

          {/* Navigation buttons */}
          <div className="flex items-center justify-between mt-3">
            <Button variant="ghost" size="xs" onClick={stopTour} className="text-xs text-muted-foreground -ms-2">
              {t("tour.skip")}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="xs" onClick={goPrev} disabled={isFirst} className="text-xs">
                {t("tour.back")}
              </Button>
              <Button size="xs" onClick={goNext} className="text-xs">
                {isLast ? t("tour.finish") : t("tour.next")}
              </Button>
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
