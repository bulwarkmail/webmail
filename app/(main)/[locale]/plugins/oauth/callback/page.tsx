"use client";

/**
 * Generic OAuth callback landing page for plugins.
 *
 * Plugins that connect to third-party OAuth providers (Google, Nextcloud, …)
 * cannot register their own routes. They send the user to the provider's
 * authorize URL with a redirect_uri pointing here; this page parks the
 * authorization code + state and notifies the plugin that initiated the flow.
 * No tokens ever pass through this page - the plugin exchanges the code
 * itself (via api.http.fetch, through its origin allowlist).
 *
 * Delivery chain:
 *   1. The payload `{ code, state, receivedAt }` is written to sessionStorage
 *      (`plugin-oauth-callback`) and mirrored into localStorage under the same
 *      key, plus a same-tab CustomEvent `plugin-oauth-callback`.
 *   2. The host listens via `PluginOAuthCallbackListener` (mounted in the
 *      [locale] layout): the localStorage write raises a `storage` event in
 *      every OTHER tab of this origin, including the tab that started the
 *      flow. The listener forwards the payload to plugins through the
 *      `authHooks.onOAuthCallback` hook bus.
 *   3. Each plugin validates `state` against the verifier it stashed before
 *      redirecting and ignores payloads that are not its own.
 *
 * The page then shows a status screen - the user closes the tab (or switches
 * back) while the original tab completes the token exchange.
 */

import { OAuthStatusCard } from "@/components/auth/oauth-status-card";
import {
  PLUGIN_OAUTH_EVENT,
  PLUGIN_OAUTH_STORAGE_KEY,
  type OAuthCallbackPayload,
} from "@/lib/plugin-oauth";
import { CheckCircle2, XCircle } from "@/components/icons";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

function PluginOAuthCallbackInner() {
  const searchParams = useSearchParams();
  const t = useTranslations("plugins");
  const [status, setStatus] = useState<"waiting" | "ok" | "error">("waiting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const errorParam = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");

    // Build the payload to hand off. Error/denial responses still carry
    // `state`, so the initiating plugin can match and terminate its pending
    // flow instead of waiting forever.
    let payload: OAuthCallbackPayload;
    let errorMessageText: string;
    if (errorParam) {
      payload = {
        state: state ?? undefined,
        error: errorParam,
        error_description: errorDescription ?? undefined,
        receivedAt: Date.now(),
      };
      errorMessageText =
        errorParam === "access_denied"
          ? t("oauth_callback.denied")
          : t("oauth_callback.failed_detail", { error: errorParam });
    } else if (!code || !state) {
      payload = { state: state ?? undefined, error: "invalid_request", receivedAt: Date.now() };
      errorMessageText = t("oauth_callback.missing_params");
    } else {
      payload = { code, state, receivedAt: Date.now() };
      errorMessageText = "";
    }


    let delivered = false;
    try {
      sessionStorage.setItem(PLUGIN_OAUTH_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // sessionStorage unavailable - the event still fires for same-tab flows
    }
    try {
      // localStorage (unlike sessionStorage) raises a `storage` event in the
      // OTHER tabs of this origin - that is what carries the payload across
      // to the tab where the plugin's background instance is running.
      localStorage.setItem(PLUGIN_OAUTH_STORAGE_KEY, JSON.stringify(payload));
      delivered = true;
    } catch {
      // localStorage unavailable - fall through to the same-tab CustomEvent
    }
    // Same-tab consumers can react immediately without waiting for storage.
    window.dispatchEvent(
      new CustomEvent(PLUGIN_OAUTH_EVENT, { detail: payload }),
    );

    if (errorMessageText) {
      setErrorMessage(errorMessageText);
      setStatus("error");
    } else if (delivered) {
      setStatus("ok");
    } else {
      // Storage write failed: the payload cannot reach the tab that started
      // the flow (the listener is disabled on this route, so the same-tab
      // event alone is not enough). Report failure instead of a false "ok".
      setStatus("error");
      setErrorMessage(t("oauth_callback.delivery_failed"));
    }
  }, [searchParams, t]);

  return (
    <OAuthStatusCard
      icon={
        status === "ok"
          ? CheckCircle2
          : status === "error"
            ? XCircle
            : undefined
      }
      iconClassName={
        status === "ok"
          ? "bg-green-500/10 text-green-600 dark:text-green-400"
          : status === "error"
            ? "bg-destructive/10 text-destructive"
            : undefined
      }
      title={
        status === "waiting"
          ? t("oauth_callback.completing")
          : status === "ok"
            ? t("oauth_callback.received_title")
            : t("oauth_callback.failed_title")
      }
      message={
        status === "waiting"
          ? t("oauth_callback.completing_message")
          : status === "ok"
            ? t("oauth_callback.received_message")
            : (errorMessage ?? undefined)
      }
    />
  );
}

function PluginOAuthCallbackContent() {
  return (
    <Suspense fallback={<OAuthStatusCard title="" />}>
      <PluginOAuthCallbackInner />
    </Suspense>
  );
}

// useSearchParams() needs a Suspense boundary for prerendering (static Lite build).
export default function PluginOAuthCallbackPage() {
  return (
    <Suspense fallback={null}>
      <PluginOAuthCallbackContent />
    </Suspense>
  );
}
