"use client";

import { isStandaloneDisplayMode } from "@/lib/standalone-display";
import { useEffect } from "react";
import { MailSkeleton } from "@/components/boot-skeleton/mail-skeleton";
import type { RailLabels } from "@/components/boot-skeleton/shell";
import { parseMailto } from "@/lib/protocol-handlers/mailto";
import { requestOpenMailtoInExistingClient, savePendingMailto } from "@/lib/protocol-handlers/session";
import { useSettingsStore } from "@/stores/settings-store";


function getProtocolPathPrefix(): string {
  const marker = "/protocol/mailto";
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
  const url = `${getProtocolPathPrefix()}/protocol/mailto?url=${encodeURIComponent(raw)}&fallback=1`;
  const opened = window.open(url, "_blank");
  if (!opened) return false;
  opened.opener = null;
  return true;
}

function shouldOpenFallbackAppTab(): boolean {
  return !isStandaloneDisplayMode() && window.history.length > 1;
}

async function focusExistingClient() {
  if (!("serviceWorker" in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.ready;
    const worker = navigator.serviceWorker.controller ?? registration.active;
    worker?.postMessage({ type: "focus-existing-mailto-client" });
  } catch {
    // Focusing is a progressive enhancement; the composer handoff still works.
  }
}

interface MailtoProtocolClientProps {
  openingText: string;
  /** The phone bottom bar's labels for the skeleton. */
  labels?: RailLabels;
}

export function MailtoProtocolClient({ openingText, labels }: MailtoProtocolClientProps) {
  useEffect(() => {
    let cancelled = false;

    async function handleMailto() {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("url");
      const isFallbackAppTab = params.get("fallback") === "1";
      const openMode = useSettingsStore.getState().protocolOpenMode;
      const parsed = raw ? parseMailto(raw) : null;

      if (parsed) {
        if (!isFallbackAppTab && openMode === "new-tab") {
          if (raw && shouldOpenFallbackAppTab() && openFallbackAppTab(raw)) {
            returnToSourcePage();
            return;
          }
        } else if (!isFallbackAppTab) {
          const delivered = await requestOpenMailtoInExistingClient(parsed);
          if (cancelled) return;

          if (delivered) {
            void focusExistingClient();
            returnToSourcePage();
            return;
          }

          if (raw && shouldOpenFallbackAppTab() && openFallbackAppTab(raw)) {
            returnToSourcePage();
            return;
          }
        }

        savePendingMailto(parsed);
      }

      window.location.replace(`${getProtocolPathPrefix()}/`);
    }

    void handleMailto();

    return () => {
      cancelled = true;
    };
  }, []);

  // The mail page this hands over to, where the composer opens: its skeleton,
  // with the opening text as the status message.
  return <MailSkeleton label={openingText} labels={labels} />;
}
