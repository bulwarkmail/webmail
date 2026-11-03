"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useConfig } from "@/hooks/use-config";
import { isPopoutPath } from "@/lib/popout/window-role";
import { getPathPrefix } from "@/lib/browser-navigation";
import { productName } from "@/lib/product-name";
import { parseMailto } from "@/lib/protocol-handlers/mailto";
import { parseWebcal } from "@/lib/protocol-handlers/webcal";
import {
  listenForMailtoRequests,
  notifyPendingMailto,
  notifyPendingWebcal,
  requestOpenMailtoInExistingClient,
  savePendingMailto,
  savePendingWebcal,
} from "@/lib/protocol-handlers/session";
import { useSettingsStore } from "@/stores/settings-store";

type LaunchParams = { targetURL?: string };
type StandaloneNavigator = Navigator & { standalone?: boolean };

declare global {
  interface Window {
    launchQueue?: {
      setConsumer: (consumer: (launchParams: LaunchParams) => void) => void;
    };
  }
}

function getProtocolLaunch(targetURL: string):
  | { kind: "mailto"; raw: string }
  | { kind: "webcal"; raw: string }
  | null {
  let url: URL;
  try {
    url = new URL(targetURL, window.location.origin);
  } catch {
    return null;
  }

  if (url.origin !== window.location.origin) return null;

  const raw = url.searchParams.get("url");
  if (!raw) return null;

  if (url.pathname.includes("/protocol/mailto")) return { kind: "mailto", raw };
  if (url.pathname.includes("/protocol/webcal")) return { kind: "webcal", raw };
  return null;
}

function isStandaloneDisplayMode() {
  return window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as StandaloneNavigator).standalone === true;
}

function openProtocolInNewTab(protocol: "mailto" | "webcal", raw: string): boolean {
  const url = `${getPathPrefix()}/protocol/${protocol}?url=${encodeURIComponent(raw)}&fallback=1`;
  const opened = window.open(url, "_blank");
  if (!opened) return false;
  opened.opener = null;
  return true;
}

interface ProtocolLaunchHandlerProviderProps {
  children: ReactNode;
}

export function ProtocolLaunchHandlerProvider({ children }: ProtocolLaunchHandlerProviderProps) {
  const t = useTranslations("protocol_handlers");
  const appName = productName(useConfig().appName);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname.startsWith("/protocol/") || isPopoutPath(pathname)) return;

    return listenForMailtoRequests((pending) => {
      savePendingMailto(pending);
      notifyPendingMailto();
      if (pathname !== "/") router.push("/");
    }, () => ({
      path: pathname,
      standalone: isStandaloneDisplayMode(),
      focusNotificationTitle: t("focus_notification_title", { appName }),
      focusNotificationBody: t("focus_notification_body", { appName }),
    }));
  }, [pathname, router, t, appName]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.launchQueue || isPopoutPath(pathname)) return;

    window.launchQueue.setConsumer((launchParams) => {
      if (!launchParams.targetURL) return;

      const launch = getProtocolLaunch(launchParams.targetURL);
      if (!launch) return;

      if (launch.kind === "mailto") {
        const parsed = parseMailto(launch.raw);
        if (!parsed) return;

        if (useSettingsStore.getState().protocolOpenMode === "new-tab") {
          if (openProtocolInNewTab("mailto", launch.raw)) return;
          savePendingMailto(parsed);
          notifyPendingMailto();
          if (pathname !== "/") router.push("/");
          return;
        }

        void requestOpenMailtoInExistingClient(parsed).then((delivered) => {
          if (delivered) return;
          savePendingMailto(parsed);
          notifyPendingMailto();
          if (pathname !== "/") router.push("/");
        });
        return;
      }

      const parsed = parseWebcal(launch.raw);
      if (!parsed) return;

      if (useSettingsStore.getState().protocolOpenMode === "new-tab") {
        if (openProtocolInNewTab("webcal", launch.raw)) return;
      }

      savePendingWebcal(parsed);
      notifyPendingWebcal();
      if (pathname !== "/calendar") router.push("/calendar");
    });
  }, [pathname, router]);

  return children;
}
