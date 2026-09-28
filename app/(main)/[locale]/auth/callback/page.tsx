"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/stores/auth-store";
import { apiFetch, getPathPrefix, toRouterPath } from "@/lib/browser-navigation";
import { buildSettingsPath } from "@/lib/deep-links";
import { LITE_OAUTH_AVAILABLE, getLiteOAuthRedirectUri } from "@/lib/auth/lite-oauth";
import { Loader2, AlertCircle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useParams } from "next/navigation";

function OAuthCallbackInner() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const t = useTranslations("login");
  const { loginWithOAuth, loginWithServerSso } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  // The authorization code is single-use. React's development double effect
  // ran this twice: the second pass no longer saw the pairing re-auth flag
  // (the first had removed it) and spent the code on the login flow instead.
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const errorParam = searchParams.get("error");

    if (errorParam) {
      setError(errorParam === "access_denied" ? "access_denied" : "token_exchange_failed");
      return;
    }

    if (!code) {
      setError("missing_params");
      return;
    }

    // Step-up re-auth for device pairing: the QR generator sent the user here
    // via prompt=login. Don't create a login session — just confirm the fresh
    // auth (sets the short-lived pairing proof cookie) and bounce back to the
    // Security settings, where the QR generation auto-resumes.
    // The flag holds the state the step-up started with; one left behind by an
    // abandoned round trip is dropped here instead of capturing this login.
    let pairReauthResume = false;
    try {
      const resumeState = sessionStorage.getItem("pair_reauth_resume");
      pairReauthResume = !!state && resumeState === state;
      if (resumeState !== null && !pairReauthResume) sessionStorage.removeItem("pair_reauth_resume");
    } catch { /* sessionStorage unavailable */ }
    if (pairReauthResume && state) {
      try { sessionStorage.removeItem("pair_reauth_resume"); } catch { /* ignore */ }
      (async () => {
        try {
          const res = await apiFetch("/api/auth/reauth/sso/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ code, state }),
          });
          if (!res.ok) {
            setError("token_exchange_failed");
            return;
          }
          try {
            sessionStorage.setItem("pair_reauth_done", "1");
          } catch { /* ignore */ }
          // Land back on the Security tab. The tab is part of the URL now
          // (#733), so the redirect target says where it is going.
          const prefix = getPathPrefix(params.locale as string);
          router.push(toRouterPath(
            `${prefix}/${params.locale}${buildSettingsPath("security")}`,
          ));
        } catch {
          setError("token_exchange_failed");
        }
      })();
      return;
    }

    const savedState = sessionStorage.getItem("oauth_state");

    if (savedState) {
      // Classic flow - sessionStorage has the PKCE state (same-tab OAuth)
      if (!state || state !== savedState) {
        setError("invalid_state");
        return;
      }

      const codeVerifier = sessionStorage.getItem("oauth_code_verifier");
      const serverUrl = sessionStorage.getItem("oauth_server_url");
      const serverId = sessionStorage.getItem("oauth_server_id") || undefined;

      if (!codeVerifier || !serverUrl) {
        setError("missing_params");
        return;
      }

      const prefix = getPathPrefix(params.locale as string);
      // Lite on Stalwart registers one locale-free URI (lib/auth/lite-oauth.ts);
      // the entry document brought us here from it.
      const redirectUri = LITE_OAUTH_AVAILABLE
        ? getLiteOAuthRedirectUri()
        : `${window.location.origin}${prefix}/${params.locale}/auth/callback`;

      loginWithOAuth(serverUrl, code, codeVerifier, redirectUri, serverId)
        .then((success) => {
          if (success) {
            sessionStorage.removeItem("oauth_state");
            sessionStorage.removeItem("oauth_code_verifier");
            sessionStorage.removeItem("oauth_server_url");
            sessionStorage.removeItem("oauth_server_id");
            sessionStorage.removeItem("oauth_add_account_mode");
            let redirectTo = `${prefix}/${params.locale}`;
            try {
              const saved = sessionStorage.getItem('redirect_after_login');
              if (saved) {
                sessionStorage.removeItem('redirect_after_login');
                redirectTo = saved;
              }
            } catch { /* sessionStorage may be unavailable */ }
            router.push(toRouterPath(redirectTo));
          } else {
            setError("token_exchange_failed");
          }
        })
        .catch(() => {
          setError("token_exchange_failed");
        });
    } else if (state) {
      // Server-side SSO flow - state was stored in encrypted httpOnly cookie.
      // Branch on mobile handoff first: the login page left a marker in
      // sessionStorage if it kicked this OAuth dance off for the mobile app.
      let mobileRedirectUri: string | null = null;
      let mobileState: string | null = null;
      try {
        mobileRedirectUri = sessionStorage.getItem("mobile_redirect_uri");
        mobileState = sessionStorage.getItem("mobile_state");
      } catch { /* sessionStorage may be unavailable */ }

      if (mobileRedirectUri && mobileRedirectUri.startsWith("bulwarkmobile://")) {
        // Drive /api/auth/sso/complete directly so we can read the tokens
        // out of the response - loginWithServerSso would consume them and
        // wire up the webmail auth store, which isn't useful here. The
        // server's mobile-flow branch (keyed on the pending cookie) skips
        // the refresh-token cookie write for the same reason.
        (async () => {
          try {
            const res = await apiFetch("/api/auth/sso/complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ code, state }),
            });
            if (!res.ok) {
              setError("token_exchange_failed");
              return;
            }
            const data = await res.json();
            const serverUrl = data.server_url as string | undefined;
            const accessToken = data.access_token as string | undefined;
            const tokenEndpoint = data.token_endpoint as string | undefined;
            const clientId = data.client_id as string | undefined;
            if (!serverUrl || !accessToken || !tokenEndpoint || !clientId) {
              setError("token_exchange_failed");
              return;
            }
            const fragment = new URLSearchParams({
              flow: "oauth",
              server_url: serverUrl,
              access_token: accessToken,
              token_endpoint: tokenEndpoint,
              client_id: clientId,
              state: mobileState ?? "",
            });
            if (typeof data.refresh_token === "string") {
              fragment.set("refresh_token", data.refresh_token);
            }
            if (typeof data.expires_in === "number") {
              fragment.set("expires_in", String(data.expires_in));
            }
            try {
              sessionStorage.removeItem("mobile_redirect_uri");
              sessionStorage.removeItem("mobile_state");
            } catch { /* ignore */ }
            window.location.replace(`${mobileRedirectUri}#${fragment.toString()}`);
          } catch {
            setError("token_exchange_failed");
          }
        })();
        return;
      }

      const ssoPrefix = getPathPrefix(params.locale as string);
      loginWithServerSso(code, state)
        .then((success) => {
          if (success) {
            let redirectTo = `${ssoPrefix}/${params.locale}`;
            try {
              const saved = sessionStorage.getItem('redirect_after_login');
              if (saved) {
                sessionStorage.removeItem('redirect_after_login');
                redirectTo = saved;
              }
            } catch { /* sessionStorage may be unavailable */ }
            router.push(toRouterPath(redirectTo));
          } else {
            setError("token_exchange_failed");
          }
        })
        .catch(() => {
          setError("token_exchange_failed");
        });
    } else {
      setError("invalid_state");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20">
        <div className="w-full max-w-sm mx-auto px-4 text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-red-500/10 mb-6">
            <AlertCircle className="w-10 h-10 text-red-500" />
          </div>
          <h1 className="text-xl font-medium text-foreground mb-2">
            {t("oauth_error.title")}
          </h1>
          <p className="text-muted-foreground text-sm mb-6">
            {t(`oauth_error.${error}`)}
          </p>
          <Button
            variant="outline"
            onClick={() => router.push(toRouterPath(`${getPathPrefix(params.locale as string)}/${params.locale}/login`))}
          >
            {t("oauth_error.back_to_login")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20">
      <div className="w-full max-w-sm mx-auto px-4 text-center" role="status">
        <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
        <p className="text-muted-foreground text-sm">{t("oauth_completing")}</p>
      </div>
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20">
          <div className="w-full max-w-sm mx-auto px-4 text-center" role="status">
            <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
          </div>
        </div>
      }
    >
      <OAuthCallbackInner />
    </Suspense>
  );
}
