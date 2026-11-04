"use client";

import { isStandaloneDisplayMode } from "@/lib/standalone-display";
import { useEffect } from "react";
import { parseWebcal } from "@/lib/protocol-handlers/webcal";
import { savePendingWebcal } from "@/lib/protocol-handlers/session";
import { useSettingsStore } from "@/stores/settings-store";
import { CalendarSkeleton, type CalendarSkeletonText } from "@/components/boot-skeleton/calendar-skeleton";
import type { RailLabels } from "@/components/boot-skeleton/shell";


function getProtocolPathPrefix(): string {
  const marker = "/protocol/webcal";
  const index = window.location.pathname.indexOf(marker);
  return index > 0 ? window.location.pathname.slice(0, index) : "";
}

function returnToSourcePage() {
  window.close();

  window.setTimeout(() => {
    if (window.history.length > 1) {
      window.history.back();
    }
  }, 150);
}

function openFallbackAppTab(raw: string): boolean {
  const url = `${getProtocolPathPrefix()}/protocol/webcal?url=${encodeURIComponent(raw)}&fallback=1`;
  const opened = window.open(url, "_blank");
  if (!opened) return false;
  opened.opener = null;
  return true;
}

function shouldOpenFallbackAppTab(): boolean {
  return !isStandaloneDisplayMode() && window.history.length > 1;
}

interface WebcalProtocolClientProps {
  openingText: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
  /** The calendar skeleton's words (calendar.*). */
  text?: CalendarSkeletonText;
}

export function WebcalProtocolClient({ openingText, labels, text }: WebcalProtocolClientProps) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("url");
    const isFallbackAppTab = params.get("fallback") === "1";

    if (raw) {
      const parsed = parseWebcal(raw);
      if (parsed) {
        if (!isFallbackAppTab
          && useSettingsStore.getState().protocolOpenMode === "new-tab"
          && shouldOpenFallbackAppTab()
          && openFallbackAppTab(raw)) {
          returnToSourcePage();
          return;
        }

        savePendingWebcal(parsed);
      }
    }

    window.location.replace(`${getProtocolPathPrefix()}/calendar`);
  }, []);

  // The calendar is where this goes next: its skeleton, with "Opening…" as
  // the page's status.
  return <CalendarSkeleton label={openingText} labels={labels} text={text} />;
}
