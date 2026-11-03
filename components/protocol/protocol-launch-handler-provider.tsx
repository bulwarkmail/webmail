"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfig } from "@/hooks/use-config";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { flushComposers } from "@/lib/compose-flush-registry";
import { getPathPrefix } from "@/lib/browser-navigation";
import { matchSurface, type AppSurface } from "@/lib/deep-links";
import {
  adoptStoredHandoff,
  discardStoredHandoff,
  handOffDraft,
  handOffLaunchFiles,
  handOffNewMessage,
  parseLaunchLanding,
  peekStoredHandoff,
  pendingHandoffs,
  restoreStoredHandoffs,
  shortcutFromTargetUrl,
  stripLandingParams,
  subscribeHandoff,
  subscribeHandoffLost,
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

/** How long a launch waits for an open composer to save before it leaves the page. */
const FLUSH_BEFORE_LEAVING_MS = 5000;
/** How much of a share the question shows. */
const OFFER_TEXT_LENGTH = 200;
const OFFER_FILE_COUNT = 5;

type ShareOffer = { subject: string; body: string; files: string[] };

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
  const { dialogProps, confirm } = useConfirmDialog();
  const [offer, setOffer] = useState<ShareOffer | null>(null);

  // Anyone can POST to the share target or link to a landing address, and
  // Chromium's link capturing can bring a cross-site form POST into an
  // installed app's window, so nothing tells a real share from a planted one.
  // Nothing goes into an account until the user says yes.
  const askAboutShare = useCallback(async (shared: ShareOffer) => {
    setOffer(shared);
    const agreed = await confirm({
      title: tLaunch("share_confirm_title"),
      message: tLaunch("share_confirm_message"),
      confirmText: tLaunch("share_confirm_accept"),
      cancelText: tLaunch("share_confirm_decline"),
    });
    setOffer(null);
    return agreed;
  }, [confirm, tLaunch]);

  // What the page's own address asks for: a shortcut's new message, or what
  // was shared. Once: it leaves the address before anything else happens.
  useEffect(() => {
    const stopLossNotes = subscribeHandoffLost((loss) => {
      toast.error(tLaunch(loss === "missing" ? "share_files_lost" : "handoff_expired"));
    });
    const { search, hash, pathname: path } = window.location;
    const landing = parseLaunchLanding(search, hash);
    if (landing) {
      const left = stripLandingParams(search, hash);
      window.history.replaceState(window.history.state, "", path + left.search + left.hash);
    }
    if (landing?.type === "new-message") {
      handOffNewMessage();
    } else if (landing?.type === "inline") {
      void (async () => {
        const { subject, body } = landing;
        if ((subject || body) && !(await askAboutShare({ subject, body, files: [] }))) return;
        if (subject || body) handOffDraft({ subject, body });
        if (landing.filesLost) toast.error(tLaunch("share_files_lost"));
        if (landing.cut) toast.info(tLaunch("share_cut"));
      })();
    } else if (landing?.type === "stored") {
      void (async () => {
        const shared = await peekStoredHandoff(landing.id, landing.key);
        if (!shared) {
          await discardStoredHandoff(landing.id);
          toast.error(tLaunch("share_gone"));
          return;
        }
        if (!(await askAboutShare(shared))) {
          await discardStoredHandoff(landing.id);
          return;
        }
        if (!(await adoptStoredHandoff(landing.id, landing.key))) toast.error(tLaunch("share_gone"));
      })();
    }
    void restoreStoredHandoffs();
    return stopLossNotes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the mail page ends an open composer, and its autosave waits 2
  // seconds: what was just typed is saved first. If it can't be, stay. A file
  // keeps waiting and opens once the user goes to that page.
  const leaveFor = useCallback(async (path: "/" | "/calendar" | "/contacts") => {
    const result = await flushComposers(FLUSH_BEFORE_LEAVING_MS);
    if (result.failed > 0 || result.timedOut) {
      toast.error(tLaunch("save_first_failed"));
      return;
    }
    router.push(path);
  }, [router, tLaunch]);

  // Takes a handoff to the page that handles it, once each: on arrival, or
  // when the sign-in it had to wait for is done.
  useEffect(() => {
    const goToTarget = () => {
      if (pathname === "/login" || pathname.startsWith("/login/") || pathname.startsWith("/auth/")) return;
      for (const handoff of pendingHandoffs()) {
        const target = HANDOFF_TARGET[handoff.kind];
        if (!target || sentToTarget.current.has(handoff.id)) continue;
        sentToTarget.current.add(handoff.id);
        if (matchSurface(pathname)?.surface !== target.surface) void leaveFor(target.path as "/" | "/calendar" | "/contacts");
        return;
      }
    };
    goToTarget();
    return subscribeHandoff("any", goToTarget);
  }, [pathname, leaveFor]);

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
        else if (shortcut && matchSurface(pathname)?.surface !== shortcut) void leaveFor(`/${shortcut}`);
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
  }, [pathname, router, tLaunch, leaveFor]);

  const offeredFiles = offer?.files ?? [];
  return (
    <>
      {children}
      <LaunchFileHost />
      <ConfirmDialog
        {...dialogProps}
        details={offer && (
          <dl className="space-y-1 break-words text-sm" data-testid="share-confirm-details">
            {offer.subject && <div><dt className="inline font-medium">{tLaunch("share_confirm_subject")} </dt><dd className="inline">{offer.subject}</dd></div>}
            {offer.body && <div><dt className="inline font-medium">{tLaunch("share_confirm_text")} </dt><dd className="inline">{offer.body.slice(0, OFFER_TEXT_LENGTH)}</dd></div>}
            {offeredFiles.length > 0 && <div><dt className="inline font-medium">{tLaunch("share_confirm_files", { count: offeredFiles.length })} </dt><dd className="inline">{offeredFiles.slice(0, OFFER_FILE_COUNT).join(", ")}{offeredFiles.length > OFFER_FILE_COUNT ? ", …" : ""}</dd></div>}
          </dl>
        )}
      />
    </>
  );
}
