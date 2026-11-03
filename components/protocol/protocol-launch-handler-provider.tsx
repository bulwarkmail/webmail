"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useConfig } from "@/hooks/use-config";
import { getPathPrefix } from "@/lib/browser-navigation";
import { matchSurface, type AppSurface } from "@/lib/deep-links";
import {
  adoptStoredHandoff,
  handOffDraft,
  handOffLaunchFiles,
  handOffNewMessage,
  parseLaunchLanding,
  pendingHandoffs,
  restoreStoredHandoffs,
  shortcutFromTargetUrl,
  stripLandingParams,
  subscribeHandoff,
  type HandoffKind,
} from "@/lib/launch-handoff";
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
import { toast } from "@/stores/toast-store";
import { LaunchFileHost } from "./launch-file-host";

type LaunchParams = {
  targetURL?: string;
  files?: ReadonlyArray<{ kind?: string; getFile?: () => Promise<File> }>;
};
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

/** The page a handoff waits for. A .eml has none: it opens over any page. */
const HANDOFF_TARGET: Partial<Record<HandoffKind, { surface: AppSurface; path: string }>> = {
  compose: { surface: "mail", path: "/" },
  calendar: { surface: "calendar", path: "/calendar" },
  contacts: { surface: "contacts", path: "/contacts" },
};

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
  const tLaunch = useTranslations("pwaLaunch");
  const sentToTarget = useRef(new Set<string>());

  // What the page's own address asks for: a shortcut's new message, or what
  // was shared. Once: it leaves the address before anything else happens.
  useEffect(() => {
    const landing = parseLaunchLanding(window.location.search);
    if (landing) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + stripLandingParams(window.location.search) + window.location.hash,
      );
    }
    if (landing?.type === "new-message") {
      handOffNewMessage();
    } else if (landing?.type === "inline") {
      if (landing.subject || landing.body) handOffDraft({ subject: landing.subject, body: landing.body });
      if (landing.filesLost) toast.error(tLaunch("share_files_lost"));
    } else if (landing?.type === "stored") {
      void adoptStoredHandoff(landing.id).then((found) => {
        if (!found) toast.error(tLaunch("share_gone"));
      });
    }
    void restoreStoredHandoffs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Takes a handoff to the page that handles it, once each: on arrival, or
  // when the sign-in it had to wait for is done.
  useEffect(() => {
    const goToTarget = () => {
      if (pathname === "/login" || pathname.startsWith("/login/") || pathname.startsWith("/auth/")) return;
      for (const handoff of pendingHandoffs()) {
        const target = HANDOFF_TARGET[handoff.kind];
        if (!target || sentToTarget.current.has(handoff.id)) continue;
        sentToTarget.current.add(handoff.id);
        if (matchSurface(pathname)?.surface !== target.surface) router.push(target.path);
        return;
      }
    };
    goToTarget();
    return subscribeHandoff("any", goToTarget);
  }, [pathname, router]);

  useEffect(() => {
    if (pathname.startsWith("/protocol/")) return;

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
    if (typeof window === "undefined" || !window.launchQueue) return;

    window.launchQueue.setConsumer((launchParams) => {
      if (launchParams.files && launchParams.files.length > 0) {
        void handOffLaunchFiles(launchParams.files).then(({ unsupported, failed }) => {
          for (const name of unsupported) toast.error(tLaunch("unsupported_file", { name }));
          if (failed > 0) toast.error(tLaunch("open_failed"));
        });
        return;
      }

      if (!launchParams.targetURL) return;

      const launch = getProtocolLaunch(launchParams.targetURL);
      if (!launch) {
        const shortcut = shortcutFromTargetUrl(launchParams.targetURL, window.location.origin);
        if (shortcut === "new-message") handOffNewMessage();
        else if (shortcut && matchSurface(pathname)?.surface !== shortcut) router.push(`/${shortcut}`);
        return;
      }

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
  }, [pathname, router, tLaunch]);

  return (
    <>
      {children}
      <LaunchFileHost />
    </>
  );
}
