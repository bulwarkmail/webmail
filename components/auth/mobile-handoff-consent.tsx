"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface MobileHandoffConsentProps {
  /** The app link the browser will open, with the credential material in its fragment. */
  url: string | null;
  /**
   * For the code hand-off (bulwarkmail.org/docs/development/mobile-handoff): makes the code live on
   * confirmation and returns the link to open, or null when that failed.
   * Shows the dialog on its own, without `url`.
   */
  resolveUrl?: (() => Promise<string | null>) | null;
  /** The account being handed over, for the explanation. */
  username: string;
  /** The user stays in the webmail instead (also runs after the link opened). */
  onCancel: () => void;
  /** `resolveUrl` returned null: nothing was handed over. */
  onError?: () => void;
  /** The desktop app, not the phone's: the port its listener asked from. */
  desktopPort?: string;
}

/**
 * The step between a sign-in that was started with `mobile_redirect_uri` and
 * the navigation that hands its password or tokens to the mobile app. The
 * page otherwise reads exactly like the ordinary sign-in page, and a link
 * carrying that parameter is all it takes to open it; whoever owns the
 * `bulwarkmobile` scheme on the device receives whatever is handed over
 * (lib/auth/mobile-handoff.ts). Nothing leaves without this confirmation.
 */
export function MobileHandoffConsent({ url, resolveUrl, username, onCancel, onError, desktopPort }: MobileHandoffConsentProps) {
  const desktop = Boolean(desktopPort);
  const t = useTranslations("login");
  const tDesktop = useTranslations("desktop_browser_sign_in");
  // The dialog closes itself right after confirming; while the code is being
  // made live, that close must not count as declining.
  const resolving = useRef(false);
  return (
    <ConfirmDialog
      isOpen={!!url || !!resolveUrl}
      onClose={() => {
        if (!resolving.current) onCancel();
      }}
      onConfirm={() => {
        if (resolveUrl) {
          if (resolving.current) return;
          resolving.current = true;
          void resolveUrl().catch(() => null).then((resolved) => {
            resolving.current = false;
            if (!resolved) {
              onError?.();
              return;
            }
            window.location.replace(resolved);
            // A custom scheme leaves this page where it is. The desktop app's listener is
            // a page of its own, and going anywhere now could overtake it.
            if (!desktop) onCancel();
          });
          return;
        }
        if (url) window.location.replace(url);
      }}
      title={desktop ? tDesktop("consent_title") : t("mobile_handoff.title")}
      message={desktop ? tDesktop("consent_description", { username, port: desktopPort ?? "" }) : t("mobile_handoff.description", { username })}
      confirmText={desktop ? tDesktop("consent_confirm") : t("mobile_handoff.confirm")}
      cancelText={desktop ? tDesktop("consent_cancel") : t("mobile_handoff.cancel")}
    />
  );
}
