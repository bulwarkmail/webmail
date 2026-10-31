"use client";

import { Suspense, useState, useEffect, useRef, useCallback, useId } from "react";
import { useRouter } from "@/i18n/navigation";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { useAuthStore, consumeSignedOut, SESSION_EXPIRED_DRAFTS_UNSAVED_KEY } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { useThemeStore } from "@/stores/theme-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useShallow } from "zustand/react/shallow";
import { useConfig } from "@/hooks/use-config";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { apiFetch, getPathPrefix, toRouterPath, withBasePath } from "@/lib/browser-navigation";
import { cn } from "@/lib/utils";
import { AlertCircle, Loader2, X, Info, Eye, EyeOff, LogIn, Sun, Moon, Monitor, Check, Shield, Play, Copy, KeyRound } from "@/components/icons";
import { type OAuthMetadata } from "@/lib/oauth/discovery";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "@/lib/oauth/pkce";
import { DEFAULT_OAUTH_SCOPES, withProviderDataScopes } from "@/lib/oauth/scopes";
import { useUpdateStore, selectBanner } from "@/stores/update-store";
import { offersOwnOAuth, type PublicJmapServerEntry } from "@/lib/admin/jmap-servers";
import { IS_LITE, getLiteInjectedClientId } from "@/lib/lite";
import { getLiteClientId, probeLiteTokenLogin } from "@/lib/auth/lite-tokens";
import {
  LITE_OAUTH_AVAILABLE,
  getLiteOAuthRedirectUri,
  liteDiscoverOAuth,
  saveLiteOAuthFlow,
  type LiteOAuthDiscovery,
} from "@/lib/auth/lite-oauth";
import { toAsciiDomain } from "@/lib/idn";
import { usePrefetchMailView } from "@/hooks/use-prefetch-mail-view";
import { buildMobileHandoffUrl, mobileCodeChallenge, mobileHandoffTarget, signedInLoginAction } from "@/lib/auth/mobile-handoff";
import { requestMobileHandoffCodeUrl } from "@/lib/auth/mobile-handoff-client";
import { MobileHandoffConsent } from "@/components/auth/mobile-handoff-consent";
import { HelpLinks } from "@/components/layout/help-links";
import { consumeSessionEnd, type SessionEndReason } from "@/lib/session-policy/sign-out-reason";

/** The domain of a complete address (`user@example.com`), or '' while it is still being typed. */
function completeAddressDomain(username: string): string {
  const match = /^[^@\s]+@([^@\s]+\.[^@\s.]+)$/.exec(username.trim());
  return match ? match[1].toLowerCase() : "";
}

/** Compare domains in ASCII form, so `bücher.de` matches a configured `xn--bcher-kva.de` and back. */
function domainKey(domain: string): string {
  return toAsciiDomain(domain) ?? domain.trim().toLowerCase();
}

function findServerByDomain(servers: PublicJmapServerEntry[], email: string | undefined): PublicJmapServerEntry | undefined {
  if (!email || !email.includes("@")) return undefined;
  const domain = email.split("@")[1]?.trim();
  if (!domain) return undefined;
  const key = domainKey(domain);
  return servers.find((s) => (s.domains ?? []).some((d) => domainKey(d) === key));
}

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";
const GIT_COMMIT = process.env.NEXT_PUBLIC_GIT_COMMIT || "unknown";

/** Labels are keys under settings.appearance.theme. */
const THEME_OPTIONS = [
  { value: "light" as const, icon: Sun, label: "light" },
  { value: "dark" as const, icon: Moon, label: "dark" },
  { value: "system" as const, icon: Monitor, label: "system" },
];

function VersionBadge() {
  const t = useTranslations("login.version");
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();
  const banner = useUpdateStore(useShallow(selectBanner));
  const startPolling = useUpdateStore((s) => s.startPolling);

  useEffect(() => { startPolling(); }, [startPolling]);

  // Opened by click or keyboard (hover alone left keyboard and touch users
  // without it): closed again by Escape or a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Stays English: it is pasted into bug reports.
  const versionInfo = `Version: ${APP_VERSION}\nBuild: ${GIT_COMMIT}${banner?.latest ? `\nLatest: ${banner.latest}` : ""}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(versionInfo).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const isRed = banner?.variant === "red";
  const triggerText = !banner
    ? `v${APP_VERSION}`
    : banner.severity === "security"
      ? t("security_update")
      : banner.severity === "deprecated"
        ? t("unsupported")
        : t("new_version");

  const triggerColor = !banner
    ? "text-muted-foreground/40"
    : isRed
      ? "text-red-600/80 dark:text-red-400/80 hover:text-red-600 dark:hover:text-red-400"
      : "text-amber-600/80 dark:text-amber-400/80 hover:text-amber-600 dark:hover:text-amber-400";

  const triggerClass = cn(
    "peer text-center text-xs transition-colors rounded-sm underline-offset-2 hover:underline",
    "focus-visible:outline-hidden",
    triggerColor,
  );

  return (
    <div ref={rootRef} className="relative inline-flex justify-center">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={detailsId}
      >
        {triggerText}
      </button>
      <div
        id={detailsId}
        role="group"
        aria-label={t("details")}
        className={cn(
          "absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-3 py-2 rounded-md bg-popover text-popover-foreground text-xs shadow-md border border-border transition-opacity whitespace-nowrap z-10",
          // Hover still previews it; only an opened one takes the focus.
          open ? "visible opacity-100" : "invisible opacity-0 peer-hover:visible peer-hover:opacity-100 hover:visible hover:opacity-100",
        )}
      >
        <div className="flex items-center gap-2">
          <div className="space-y-0.5">
            <p>{t("version_line", { value: APP_VERSION })}</p>
            <p>{t("build_line", { value: GIT_COMMIT })}</p>
            {banner?.latest && (
              <p>{t("latest_line", { value: banner.latest })}</p>
            )}
            {banner?.advisory && (
              <p className="text-red-600 dark:text-red-400">{banner.advisory}</p>
            )}
            {banner?.url && (
              <a href={banner.url} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                {t("release_notes")}
              </a>
            )}
          </div>
          <IconButton label={t("copy")} onClick={handleCopy}>
            {copied ? <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function LoginPageContent() {
  const router = useRouter();
  const t = useTranslations("login");
  const tSessionLimits = useTranslations("session_limits");
  const tTheme = useTranslations("settings.appearance.theme");
  const params = useParams();
  const searchParams = useSearchParams();
  const isAddAccountMode = searchParams.get("mode") === "add-account";

  // When the mobile app launches the webmail in a browser tab it tacks on
  // these params. We grab them once at mount and stash them in a ref so any
  // login path that completes (password or OAuth) can hand control back to
  // the app instead of routing into /mail.
  // Only the app's own callback link is a handoff target, and nothing is
  // handed over before the user confirms it (lib/auth/mobile-handoff.ts).
  const rawMobileState = searchParams.get("mobile_state") ?? "";
  // App builds that send a PKCE challenge get a one-time code in the link
  // instead of the sign-in (bulwarkmail.org/docs/development/mobile-handoff). A malformed challenge
  // makes this no hand-off at all: falling back to the fragment would put
  // the password in the link the app asked to keep it out of. Lite has no
  // server to park the sign-in on and keeps handing over in the fragment.
  const rawMobileCodeChallenge = IS_LITE ? "" : searchParams.get("mobile_code_challenge") ?? "";
  const mobileChallenge = mobileCodeChallenge(rawMobileCodeChallenge);
  const mobileRedirectUri = rawMobileCodeChallenge && !mobileChallenge
    ? ""
    : mobileHandoffTarget(searchParams.get("mobile_redirect_uri"));
  const mobileState = mobileRedirectUri ? rawMobileState : "";
  const isMobileHandoff = Boolean(mobileRedirectUri);
  const [pendingHandoff, setPendingHandoff] = useState<{
    url: string | null;
    resolveUrl?: () => Promise<string | null>;
    username: string;
  } | null>(null);
  // Parking the sign-in for the app failed (code hand-off only).
  const [handoffError, setHandoffError] = useState<string | null>(null);
  usePrefetchMailView(!isMobileHandoff);
  const { login, loginWithToken, loginDemo, isLoading, error, clearError, isAuthenticated } = useAuthStore();
  const { theme, setTheme, initializeTheme } = useThemeStore(useShallow((s) => ({ theme: s.theme, setTheme: s.setTheme, initializeTheme: s.initializeTheme })));
  const { appName, jmapServerUrl: configuredServerUrl, oauthEnabled, oauthOnly, oauthClientId: globalOauthClientId, oauthIssuerUrl: globalOauthIssuerUrl, oauthScopes, rememberMeEnabled, devMode, demoMode, loginLogoLightUrl, loginLogoDarkUrl, loginCompanyName, loginImprintUrl, loginPrivacyPolicyUrl, loginWebsiteUrl, loginUsernamePlaceholder, loginLogoMaxHeight, loginLogoMaxWidth, loginShowHeading, loginShowSubtitle, loginShowTotp, loginShowTokenLogin, loginShowRememberMe, loginShowVersion, isLoading: configLoading, error: configError, autoSsoEnabled, embeddedMode: _embeddedMode, allowCustomJmapEndpoint, jmapServers, jmapServerAutoPickByDomain } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const colorModeLocked = usePolicyStore((s) => s.getColorModePolicy().locked);

  // Login logo sizing: when a max height/width is configured, drop the fixed
  // 64×64 box so the logo (e.g. a wide wordmark) can render at its true size.
  const hasLogoSize = Boolean(loginLogoMaxHeight || loginLogoMaxWidth);
  const loginLogoStyle = hasLogoSize
    ? { maxHeight: loginLogoMaxHeight || undefined, maxWidth: loginLogoMaxWidth || undefined }
    : undefined;

  const [formData, setFormData] = useState({
    // An account restored from the list backup opens this form with its address.
    username: isAddAccountMode ? searchParams.get("username") ?? "" : "",
    password: "",
  });
  const [jmapEndpoint, setJmapEndpoint] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [domainAutoLocked, setDomainAutoLocked] = useState(false);

  const hasServerList = jmapServers.length > 0;
  const selectedServer = hasServerList
    ? jmapServers.find((s) => s.id === selectedServerId) ?? jmapServers[0]
    : undefined;

  // Effective values: per-server overrides win, then global config.
  const serverUrl = selectedServer?.url || configuredServerUrl;
  const effectiveOauthClientId = selectedServer?.oauth?.clientId || globalOauthClientId;
  // A selected server discovers against itself unless it has its own issuer;
  // the global issuer only applies without a server list (#952).
  const effectiveOauthIssuerUrl = selectedServer
    ? selectedServer.oauth?.issuerUrl || selectedServer.url
    : globalOauthIssuerUrl;
  // A server entry that names its own OAuth client and button label signs in
  // with OAuth even while OAuth is off globally: a Gmail bridge next to a
  // password server.
  const serverOauthEnabled = oauthEnabled || offersOwnOAuth(selectedServer);
  const [totpCode, setTotpCode] = useState("");
  const [showTotpField, setShowTotpField] = useState(false);
  // Access-token sign-in (Bearer auth) in place of username and password.
  // The mobile hand-off passes a password on to the app, so it has none.
  const [tokenMode, setTokenMode] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const signInWithToken = tokenMode && loginShowTokenLogin && !isMobileHandoff;
  const [rememberMe, setRememberMe] = useState(false);
  // Lite (no server session): "remember me" needs Stalwart's token login on the
  // target server. Probe it once per URL and hide the box when it is missing;
  // those sessions then only last as long as the tab (lib/auth/lite-tokens.ts).
  const [liteTokenLoginSupported, setLiteTokenLoginSupported] = useState<boolean | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Signed out by the organisation's idle timeout or maximum session length.
  const [sessionEnd, setSessionEnd] = useState<SessionEndReason | null>(null);
  const [expiredDraftsUnsaved, setExpiredDraftsUnsaved] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [shakeError, setShakeError] = useState(false);
  const [showThemeMenu, setShowThemeMenu] = useState(false);

  const [savedUsernames, setSavedUsernames] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [filteredSuggestions, setFilteredSuggestions] = useState<string[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const [oauthMetadata, setOauthMetadata] = useState<OAuthMetadata | null>(null);
  const [oauthDiscoveryDone, setOauthDiscoveryDone] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  // The auth store's error, else a failed hand-off to the app.
  const shownError = error || handoffError;
  // The error box and the recent-accounts list, tied to the fields they
  // belong to so a screen reader reads them with the field.
  const formId = useId();
  const errorId = `${formId}-error`;
  const suggestionsId = `${formId}-suggestions`;
  const suggestionsHintId = `${formId}-suggestions-hint`;
  const suggestionId = (index: number) => `${formId}-suggestion-${index}`;
  // Which field the error is about. A wrong code with a code typed blames
  // the code; the server and network errors blame no field.
  const totpBlamed = error === "totp_required" || (error === "invalid_credentials" && showTotpField && !!totpCode);
  const credentialsBlamed = error === "invalid_credentials" && !totpBlamed;
  const tokenBlamed = error === "invalid_token";
  const errorProps = (blamed: boolean) =>
    blamed ? { "aria-invalid": true as const, "aria-describedby": errorId } : {};
  const suggestionsOpen = showSuggestions && filteredSuggestions.length > 0;
  const suggestionsRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const justSelectedSuggestion = useRef(false);
  // A removal updated the list itself; the filter effect leaves it open.
  const justRemovedSuggestion = useRef(false);
  const totpInputRef = useRef<HTMLInputElement>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const prevError = useRef<string | null>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const themeButtonRef = useRef<HTMLButtonElement>(null);
  const closeThemeMenu = useCallback(() => setShowThemeMenu(false), []);
  const { menuRef: themeListRef, onKeyDown: onThemeMenuKeyDown } = useMenuNavigation<HTMLDivElement>({
    open: showThemeMenu,
    onClose: closeThemeMenu,
    triggerRef: themeButtonRef,
  });
  // Captured by handleSubmit when in mobile handoff mode; consumed by the
  // isAuthenticated effect to build the deep-link fragment.
  const mobileHandoffPayloadRef = useRef<{ server_url: string; username: string; password: string } | null>(null);

  useEffect(() => {
    initializeTheme();
  }, [initializeTheme]);

  const probeTarget = hasServerList
    ? selectedServer?.url ?? ""
    : (allowCustomJmapEndpoint ? jmapEndpoint : serverUrl) || "";
  useEffect(() => {
    if (!IS_LITE || !probeTarget) return;
    let cancelled = false;
    // Debounced: the custom endpoint field fires per keystroke.
    const timer = setTimeout(() => {
      probeLiteTokenLogin(probeTarget).then((supported) => {
        if (!cancelled) setLiteTokenLoginSupported(supported);
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [probeTarget]);
  const canRememberSession = rememberMeEnabled && (!IS_LITE || liteTokenLoginSupported !== false);
  // Sign-ins are remembered without asking unless the admin offers the box
  // (LOGIN_SHOW_REMEMBER_ME).
  const showRememberMe = canRememberSession && loginShowRememberMe;
  const persistSession = canRememberSession && (!loginShowRememberMe || rememberMe);
  // A provider sign-in follows the box whenever it is shown, the automatic
  // one included (it starts unticked), and is remembered otherwise. Lite
  // keeps the provider's tokens in the browser like any other sign-in.
  const persistProviderSession = IS_LITE ? persistSession : !showRememberMe || rememberMe;

  // Lite on Stalwart: which provider signs the typed account in
  // (lib/auth/lite-oauth.ts). A domain Stalwart delegates to an external
  // OpenID provider has no password to check, so the form turns into the SSO
  // button for it. The answer depends on the domain, so it is kept while the
  // local part is edited, and only asked for once the address is complete
  // (the endpoint is rate limited).
  const [liteOAuthByDomain, setLiteOAuthByDomain] = useState<{ domain: string; discovery: LiteOAuthDiscovery | null } | null>(null);
  const [liteOAuthFailed, setLiteOAuthFailed] = useState(false);
  const liteDomain = LITE_OAUTH_AVAILABLE && !signInWithToken ? completeAddressDomain(formData.username) : "";
  const liteAccount = liteDomain ? formData.username.trim() : "";
  useEffect(() => {
    if (!liteAccount || !probeTarget) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      liteDiscoverOAuth(probeTarget, liteAccount, controller.signal).then((discovery) => {
        if (!controller.signal.aborted) setLiteOAuthByDomain({ domain: completeAddressDomain(liteAccount), discovery });
      });
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [probeTarget, liteAccount]);
  const liteSsoRequired = liteDomain !== "" && liteOAuthByDomain?.domain === liteDomain && liteOAuthByDomain.discovery?.external === true;
  // The admin gave the Application an OAuth client: offer SSO next to the form.
  const liteSsoOffered = LITE_OAUTH_AVAILABLE && !liteSsoRequired && getLiteInjectedClientId() !== "";

  // The tab says what the page is for, not only whose it is (WCAG 2.4.2).
  const pageTitle = `${isAddAccountMode ? t("add_account_title") : t("sign_in")} - ${appName}`;
  useEffect(() => {
    if (serverUrl) {
      document.title = pageTitle;
    }
  }, [pageTitle, serverUrl]);

  useEffect(() => {
    if (serverUrl && !jmapEndpoint) {
      setJmapEndpoint(serverUrl);
    }
  }, [serverUrl, jmapEndpoint]);

  // Initialize selected server when the server list arrives. Picks the first
  // entry; the auto-pick effect below may override based on the email domain.
  useEffect(() => {
    if (!hasServerList) return;
    if (selectedServerId && jmapServers.some((s) => s.id === selectedServerId)) return;
    setSelectedServerId(jmapServers[0].id);
  }, [hasServerList, jmapServers, selectedServerId]);

  // Auto-pick by email domain. Locks the dropdown to the matched server until
  // the user clears the email or types a domain we don't recognize.
  useEffect(() => {
    if (!jmapServerAutoPickByDomain || !hasServerList) return;
    const match = findServerByDomain(jmapServers, formData.username);
    if (match) {
      if (selectedServerId !== match.id) setSelectedServerId(match.id);
      setDomainAutoLocked(true);
    } else {
      setDomainAutoLocked(false);
    }
  }, [jmapServerAutoPickByDomain, hasServerList, jmapServers, formData.username, selectedServerId]);

  useEffect(() => {
    try {
      if (sessionStorage.getItem('session_expired') === 'true') {
        setSessionExpired(true);
        sessionStorage.removeItem('session_expired');
      }
      // The expired session tried to save the open messages first (auth store).
      if (sessionStorage.getItem(SESSION_EXPIRED_DRAFTS_UNSAVED_KEY) === 'true') {
        setExpiredDraftsUnsaved(true);
        sessionStorage.removeItem(SESSION_EXPIRED_DRAFTS_UNSAVED_KEY);
      }
    } catch { /* sessionStorage unavailable */ }
    const ended = consumeSessionEnd();
    if (ended) {
      setSessionEnd(ended);
      setSessionExpired(true);
    }
  }, []);

  useEffect(() => {
    if (error && error !== 'totp_required' && error !== prevError.current) {
      setShakeError(true);
      const timer = setTimeout(() => setShakeError(false), 400);
      return () => clearTimeout(timer);
    }
    prevError.current = error;
  }, [error]);

  // Auto-show and focus TOTP field when server requires it
  useEffect(() => {
    if (error === 'totp_required') {
      setShowTotpField(true);
      setTimeout(() => totpInputRef.current?.focus(), 100);
    }
  }, [error]);

  useEffect(() => {
    if (!serverUrl) return;
    const saved = localStorage.getItem("webmail_usernames");
    if (saved) {
      try {
        const usernames = JSON.parse(saved);
        setSavedUsernames(usernames);
      } catch {
        console.error("Failed to parse saved usernames");
      }
    }
  }, [serverUrl]);

  // Mobile handoff: hand the verified credentials back to the mobile app
  // instead of opening the mailbox. handleSubmit captured the values needed
  // for the fragment. Runs once per sign-in: whichever of the effect below
  // and handleSubmit gets here first takes the payload.
  const offerMobileHandoff = useCallback(() => {
    const payload = mobileHandoffPayloadRef.current;
    if (!payload) return;
    mobileHandoffPayloadRef.current = null;
    setHandoffError(null);
    if (mobileChallenge) {
      // The app gets a one-time code: on confirmation the sign-in is parked
      // on the server, and its 60 seconds start then.
      setPendingHandoff({
        url: null,
        resolveUrl: () => requestMobileHandoffCodeUrl({
          target: mobileRedirectUri,
          challenge: mobileChallenge,
          state: mobileState,
          payload,
        }),
        username: payload.username,
      });
      return;
    }
    // Shown to the user first; the navigation happens on their confirmation.
    setPendingHandoff({
      url: buildMobileHandoffUrl(mobileRedirectUri, { flow: "password", ...payload, state: mobileState }),
      username: payload.username,
    });
  }, [mobileRedirectUri, mobileState, mobileChallenge]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const action = signedInLoginAction({
      isMobileHandoff,
      isAddAccountMode,
      hasHandoffPayload: mobileHandoffPayloadRef.current !== null,
    });
    if (action === "handoff") {
      // The password path completes here once the auth store flips
      // isAuthenticated.
      offerMobileHandoff();
      return;
    }
    // A browser that was already signed in keeps the form: the app needs a
    // sign-in of its own, and the mailbox would strand the user in the app's
    // sign-in sheet. handleSubmit offers the hand-off after they sign in
    // (isAuthenticated stays true, so this effect doesn't run again).
    if (action === "mailbox") {
      let redirectTo = '/';
      try {
        const saved = sessionStorage.getItem('redirect_after_login');
        if (saved) {
          sessionStorage.removeItem('redirect_after_login');
          redirectTo = saved;
        }
      } catch { /* ignore */ }
      router.push(toRouterPath(redirectTo));
    }
  }, [isAuthenticated, router, isAddAccountMode, isMobileHandoff, offerMobileHandoff]);

  useEffect(() => {
    clearError();
    setHandoffError(null);
  }, [formData, clearError]);

  useEffect(() => {
    if (!serverUrl) return;
    if (justSelectedSuggestion.current) {
      justSelectedSuggestion.current = false;
      return;
    }
    if (justRemovedSuggestion.current) {
      justRemovedSuggestion.current = false;
      return;
    }

    if (formData.username && savedUsernames.length > 0) {
      const filtered = savedUsernames.filter(username =>
        username.toLowerCase().includes(formData.username.toLowerCase())
      );
      setFilteredSuggestions(filtered);
      setShowSuggestions(filtered.length > 0);
    } else if (formData.username === "" && savedUsernames.length > 0) {
      setFilteredSuggestions(savedUsernames);
      setShowSuggestions(false);
    } else {
      setShowSuggestions(false);
    }
    setSelectedSuggestionIndex(-1);
  }, [formData.username, savedUsernames, serverUrl]);

  useEffect(() => {
    if (!serverUrl) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node) &&
          inputRef.current && !inputRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
      if (themeMenuRef.current && !themeMenuRef.current.contains(event.target as Node)) {
        setShowThemeMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [serverUrl]);

  useEffect(() => {
    if (!serverOauthEnabled || !serverUrl) return;
    setOauthDiscoveryDone(false);
    setOauthMetadata(null);
    const controller = new AbortController();
    // Discover via our own origin rather than fetching the IdP's /.well-known/*
    // documents directly from the browser. A direct cross-origin discovery
    // fetch is subject to CORS, and providers like Authentik serve those
    // documents without Access-Control-Allow-Origin, so the browser blocks the
    // response and login breaks (issue #382). The proxy runs discovery server
    // side where CORS does not apply.
    const query = selectedServer?.id ? `?server_id=${encodeURIComponent(selectedServer.id)}` : "";
    apiFetch(`/api/auth/oauth/metadata${query}`, { signal: controller.signal })
      .then(async (res) => (res.ok ? ((await res.json()) as OAuthMetadata) : null))
      .then((metadata) => {
        setOauthMetadata(metadata);
        setOauthDiscoveryDone(true);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setOauthMetadata(null);
        setOauthDiscoveryDone(true);
      });
    return () => controller.abort();
  }, [serverOauthEnabled, serverUrl, effectiveOauthIssuerUrl, selectedServer?.id]);

  // Auto-SSO: when enabled with OAUTH_ONLY, skip the login page entirely
  const ssoError = searchParams.get("sso_error");
  const autoSsoTriggered = useRef(false);
  // Read once per mount: a ref survives the effect re-runs, the flag does not.
  const signedOutOnPurpose = useRef<boolean | null>(null);

  const startServerSideSso = useCallback(async () => {
    setOauthLoading(true);
    try {
      const prefix = getPathPrefix(params.locale as string);
      const redirectUri = `${window.location.origin}${prefix}/${params.locale}/auth/callback`;
      // In mobile-handoff mode the callback page needs to know it should
      // redirect into the app rather than into /mail. Stash the params in
      // sessionStorage so the same-tab callback can read them - the SSO
      // pending cookie carries the authoritative copy server-side too.
      if (isMobileHandoff) {
        try {
          sessionStorage.setItem("mobile_redirect_uri", mobileRedirectUri);
          sessionStorage.setItem("mobile_state", mobileState);
        } catch { /* sessionStorage unavailable */ }
      }
      const res = await apiFetch('/api/auth/sso/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          redirect_uri: redirectUri,
          locale: params.locale,
          server_id: selectedServer?.id,
          remember: persistProviderSession,
          ...(isMobileHandoff
            ? {
                mobile_redirect_uri: mobileRedirectUri,
                mobile_state: mobileState,
                ...(mobileChallenge ? { mobile_code_challenge: mobileChallenge } : {}),
              }
            : {}),
        }),
      });

      if (!res.ok) {
        setOauthLoading(false);
        return;
      }

      const { authorize_url } = await res.json();

      // Navigate to the authorize URL
      const isIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
      if (isIframe) {
        // In an iframe, try top-level navigation
        try {
          window.top!.location.href = authorize_url;
        } catch {
          // Cross-origin restriction - fall back to current frame
          window.location.href = authorize_url;
        }
      } else {
        window.location.href = authorize_url;
      }
    } catch {
      setOauthLoading(false);
    }
  }, [params.locale, selectedServer?.id, persistProviderSession, isMobileHandoff, mobileRedirectUri, mobileState, mobileChallenge]);

  useEffect(() => {
    // After signing out, show the login page rather than signing straight
    // back in through a provider session that outlived the sign-out (#905).
    if (signedOutOnPurpose.current === null) signedOutOnPurpose.current = consumeSignedOut();
    if (signedOutOnPurpose.current) return;
    if (!autoSsoEnabled || !oauthOnly || !oauthDiscoveryDone || !oauthMetadata) return;
    if (ssoError || isAddAccountMode || isAuthenticated) return;
    if (autoSsoTriggered.current) return;
    // With a multi-server list the target isn't implied - auto-redirecting
    // would silently pin every user to the first entry and make the picker
    // unreachable. Let them choose and press the button instead (issue #799).
    if (jmapServers.length > 1) return;

    // Guard against redirect loops
    try {
      if (sessionStorage.getItem("sso_attempted")) return;
      sessionStorage.setItem("sso_attempted", "1");
      // Clear the flag after 30 seconds so retries are possible
      setTimeout(() => { try { sessionStorage.removeItem("sso_attempted"); } catch { /* ignore */ } }, 30000);
    } catch { /* sessionStorage unavailable */ }

    autoSsoTriggered.current = true;
    startServerSideSso();
  }, [autoSsoEnabled, oauthOnly, oauthDiscoveryDone, oauthMetadata, ssoError, isAddAccountMode, isAuthenticated, jmapServers.length, startServerSideSso]);

  const handleThemeSelect = useCallback((newTheme: "light" | "dark" | "system") => {
    setTheme(newTheme);
    setShowThemeMenu(false);
  }, [setTheme]);

  if (configLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30">
        <div className="w-full max-w-sm mx-auto px-4 text-center" role="status">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
          <span className="sr-only">{t("loading")}</span>
        </div>
      </div>
    );
  }

  if (configError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30">
        <div className="w-full max-w-md mx-auto px-4 text-center">
          <div className="rounded-2xl border border-border/60 bg-background/80 backdrop-blur-sm shadow-xl p-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 mb-5">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h1 className="text-xl font-semibold text-foreground mb-2">{t("config_error.title")}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("config_error.fetch_failed")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!serverUrl && !demoMode && !allowCustomJmapEndpoint) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/30">
        <div className="w-full max-w-md mx-auto px-4 text-center">
          <div className="rounded-2xl border border-border/60 bg-background/80 backdrop-blur-sm shadow-xl p-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 mb-5">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <h1 className="text-xl font-semibold text-foreground mb-2">{t("config_error.title")}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("config_error.server_not_configured")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const saveUsername = (username: string) => {
    const saved = localStorage.getItem("webmail_usernames");
    let usernames: string[] = [];

    if (saved) {
      try {
        usernames = JSON.parse(saved);
      } catch {
        console.error("Failed to parse saved usernames");
      }
    }

    if (!usernames.includes(username)) {
      usernames = [username, ...usernames].slice(0, 5);
      localStorage.setItem("webmail_usernames", JSON.stringify(usernames));
      setSavedUsernames(usernames);
    }
  };

  const removeUsername = (username: string, e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    justRemovedSuggestion.current = true;
    const updated = savedUsernames.filter(u => u !== username);
    localStorage.setItem("webmail_usernames", JSON.stringify(updated));
    setSavedUsernames(updated);
    const remaining = updated.filter(u =>
      u.toLowerCase().includes(formData.username.toLowerCase())
    );
    setFilteredSuggestions(remaining);
    if (remaining.length === 0) setShowSuggestions(false);
    setSelectedSuggestionIndex(prev => Math.min(prev, remaining.length - 1));
  };

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, username: e.target.value });
  };

  const handleUsernameFocus = () => {
    if (savedUsernames.length > 0 && formData.username === "") {
      setFilteredSuggestions(savedUsernames);
      setShowSuggestions(true);
    } else if (filteredSuggestions.length > 0) {
      setShowSuggestions(true);
    }
  };

  const selectSuggestion = (username: string) => {
    justSelectedSuggestion.current = true;
    setFormData({ ...formData, username });
    setShowSuggestions(false);
    document.getElementById("password")?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Down arrow opens the recent accounts, as in any combobox.
    if (!showSuggestions && e.key === "ArrowDown") {
      const candidates = formData.username === ""
        ? savedUsernames
        : savedUsernames.filter(u => u.toLowerCase().includes(formData.username.toLowerCase()));
      if (candidates.length > 0) {
        e.preventDefault();
        setFilteredSuggestions(candidates);
        setShowSuggestions(true);
        setSelectedSuggestionIndex(0);
      }
      return;
    }
    if (!showSuggestions || filteredSuggestions.length === 0) return;

    // Delete on a highlighted account takes it off the list, like the
    // browser's own autofill. Without a highlight it edits the text.
    if ((e.key === "Delete" || (e.key === "Backspace" && e.shiftKey)) && selectedSuggestionIndex >= 0) {
      e.preventDefault();
      removeUsername(filteredSuggestions[selectedSuggestionIndex]);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestionIndex(prev =>
        prev < filteredSuggestions.length - 1 ? prev + 1 : prev
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestionIndex(prev => prev > 0 ? prev - 1 : -1);
    } else if (e.key === "Enter" && selectedSuggestionIndex >= 0) {
      e.preventDefault();
      selectSuggestion(filteredSuggestions[selectedSuggestionIndex]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
      setSelectedSuggestionIndex(-1);
    }
  };

  // Lite on Stalwart: the redirect flow without a server (lib/auth/lite-oauth.ts).
  // Discovery needs the account, which decides the provider.
  const startLiteOAuth = async (liteServerUrl: string) => {
    const account = formData.username.trim();
    if (!account) {
      inputRef.current?.focus();
      inputRef.current?.reportValidity();
      return;
    }
    setOauthLoading(true);
    setLiteOAuthFailed(false);
    const discovery = await liteDiscoverOAuth(liteServerUrl, account);
    if (!discovery) {
      setLiteOAuthFailed(true);
      setOauthLoading(false);
      return;
    }

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();
    const redirectUri = getLiteOAuthRedirectUri();
    const clientId = getLiteClientId();

    sessionStorage.setItem("oauth_code_verifier", verifier);
    sessionStorage.setItem("oauth_state", state);
    sessionStorage.setItem("oauth_server_url", liteServerUrl);
    sessionStorage.removeItem("oauth_server_id");
    if (isAddAccountMode) {
      sessionStorage.setItem("oauth_add_account_mode", "true");
    }
    sessionStorage.setItem("oauth_cookie_slot", useAccountStore.getState().getNextCookieSlot().toString());
    saveLiteOAuthFlow({
      tokenEndpoint: discovery.metadata.token_endpoint,
      clientId,
      redirectUri,
      persistent: persistSession,
      revocationEndpoint: discovery.metadata.revocation_endpoint,
    });

    const authUrl = new URL(discovery.metadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    if (discovery.scope) authUrl.searchParams.set("scope", discovery.scope);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("login_hint", account);
    if (isAddAccountMode) {
      authUrl.searchParams.set("prompt", "select_account");
    }

    window.location.href = authUrl.toString();
  };

  /**
   * Starts OAuth for the selected server, or for `target`: a server in the
   * list with its own OAuth client (a Gmail bridge, say), offered on the page
   * whichever server is selected so that "Sign in with Google" is one tap.
   */
  const handleOAuthLogin = async (target?: PublicJmapServerEntry) => {
    if (LITE_OAUTH_AVAILABLE && !target) {
      await startLiteOAuth(probeTarget);
      return;
    }
    const server = target ?? selectedServer;
    const clientId = target ? target.oauth?.clientId : effectiveOauthClientId;
    let metadata = target ? null : oauthMetadata;
    if (target) {
      setOauthLoading(true);
      setSelectedServerId(target.id);
      try {
        const res = await apiFetch(`/api/auth/oauth/metadata?server_id=${encodeURIComponent(target.id)}`);
        metadata = res.ok ? ((await res.json()) as OAuthMetadata) : null;
      } catch {
        metadata = null;
      }
      if (!metadata) {
        // The target is now the selected server: its discovery runs again and
        // the page shows the usual "discovery failed" notice.
        setOauthLoading(false);
        return;
      }
    }
    if (!metadata || !clientId) return;
    // In mobile-handoff mode the client-side PKCE flow doesn't help us:
    // tokens would land in sessionStorage on the webmail origin and the
    // mobile app couldn't read them. Route through the server-side SSO
    // path instead, which has the mobile-aware /api/auth/sso/complete
    // branch.
    if (isMobileHandoff) {
      await startServerSideSso();
      return;
    }
    setOauthLoading(true);

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();
    const prefix = getPathPrefix(params.locale as string);
    const redirectUri = `${window.location.origin}${prefix}/${params.locale}/auth/callback`;

    // Resolve the JMAP URL to send to the callback. Server-list entries win
    // over the custom-endpoint input, which wins over the global server URL.
    const oauthServerUrl = server?.url
      || (allowCustomJmapEndpoint ? jmapEndpoint : configuredServerUrl);

    sessionStorage.setItem("oauth_code_verifier", verifier);
    sessionStorage.setItem("oauth_state", state);
    sessionStorage.setItem("oauth_server_url", oauthServerUrl!);
    if (server?.id) {
      sessionStorage.setItem("oauth_server_id", server.id);
    } else {
      sessionStorage.removeItem("oauth_server_id");
    }
    if (isAddAccountMode) {
      sessionStorage.setItem("oauth_add_account_mode", "true");
    }
    // Read back by loginWithOAuth (stores/auth-store.ts) for the code exchange.
    sessionStorage.setItem("oauth_remember", String(persistProviderSession));

    // Persist the next-free cookie slot so loginWithOAuth (in stores/auth-store.ts)
    // writes the refresh token to the correct per-account jmap_rt_<slot> cookie.
    // loginWithOAuth reads this key but it was previously never written, so every
    // OAuth account collapsed onto slot 0 and clobbered earlier accounts' refresh
    // tokens. getNextCookieSlot() returns 0 when no accounts exist (correct for
    // first sign-in) and the lowest unused slot otherwise (correct for "+ Add
    // Account").
    const nextSlot = useAccountStore.getState().getNextCookieSlot();
    sessionStorage.setItem("oauth_cookie_slot", nextSlot.toString());

    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", withProviderDataScopes(oauthScopes || DEFAULT_OAUTH_SCOPES, metadata.scopes_supported));
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    if (isAddAccountMode) {
      authUrl.searchParams.set("prompt", "select_account");
    }

    window.location.href = authUrl.toString();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Server-list entries always win - `allowCustomJmapEndpoint` is only honored
    // when the admin hasn't configured a server list.
    const effectiveServerUrl = selectedServer?.url
      || (allowCustomJmapEndpoint ? jmapEndpoint : serverUrl);
    if (signInWithToken) {
      if (await loginWithToken(effectiveServerUrl, accessToken, persistSession)) {
        router.push('/');
      }
      return;
    }
    // Lite on Stalwart: an account whose domain signs in at an external
    // provider has no password Stalwart could check. Asked again here (cached)
    // because Enter can beat the debounced lookup; a name without a domain is
    // always Stalwart's own.
    if (LITE_OAUTH_AVAILABLE && formData.username.includes("@")) {
      const discovery = await liteDiscoverOAuth(effectiveServerUrl, formData.username);
      if (discovery?.external) {
        await startLiteOAuth(effectiveServerUrl);
        return;
      }
    }
    // Capture before login() so the isAuthenticated effect can build the
    // deep-link fragment with values the user actually typed (formData may
    // be cleared by the auth store on success).
    if (isMobileHandoff) {
      mobileHandoffPayloadRef.current = {
        server_url: effectiveServerUrl,
        username: formData.username,
        password: formData.password,
      };
    }
    const success = await login(
      effectiveServerUrl,
      formData.username,
      formData.password,
      totpCode || undefined,
      // Only persist credentials when the server actually supports it
      // (a SESSION_SECRET is configured). Prevents a broken cookie write
      // when the remember-me feature is disabled server-side.
      persistSession
    );

    if (success) {
      // Suggested again on this browser only when the user did not decline
      // being remembered: on a shared computer the next person sees the list.
      if (!rememberMeEnabled || persistSession) saveUsername(formData.username);
      if (isMobileHandoff) {
        // Usually the isAuthenticated effect has offered the hand-off by
        // now. A browser that was already signed in doesn't flip
        // isAuthenticated, so offer it here (a no-op once taken). Don't push
        // to / - that would race the deep link.
        offerMobileHandoff();
        return;
      }
      router.push('/');
    } else if (isMobileHandoff) {
      // Stale payload should never feed into a later retry's redirect.
      mobileHandoffPayloadRef.current = null;
    }
  };

  const handleDevLogin = async () => {
    // Remember the session when the server supports it so dev reloads restore
    // through the same cookie path production remember-me/OAuth users take,
    // instead of bouncing to the login page.
    const success = await login(serverUrl, "dev@localhost", "dev", undefined, rememberMeEnabled);
    if (success) {
      let redirectTo = '/';
      try {
        const saved = sessionStorage.getItem('redirect_after_login');
        if (saved) {
          sessionStorage.removeItem('redirect_after_login');
          redirectTo = saved;
        }
      } catch { /* ignore */ }
      router.push(toRouterPath(redirectTo));
    }
  };

  const handleDemoLogin = async () => {
    setDemoLoading(true);
    const success = await loginDemo();
    if (success) {
      router.push('/');
    }
    setDemoLoading(false);
  };

  const currentThemeOption = THEME_OPTIONS.find(o => o.value === theme) || THEME_OPTIONS[2];
  const CurrentThemeIcon = currentThemeOption.icon;

  // Server picker (when admin has configured a server list). Rendered by both
  // the password form and the OAuth-only branch - with several servers the user
  // has to pick which one SSO targets before the button starts the flow, since
  // the selection drives OAuth discovery and the server_id sent to the callback
  // (issue #799).
  const serverPicker = hasServerList && jmapServers.length > 1 ? (
    <div className="space-y-1.5">
      <label htmlFor="jmap-server-select" className="block text-sm font-medium text-foreground">
        {t("jmap_server_label")}
      </label>
      <select
        id="jmap-server-select"
        value={selectedServer?.id ?? ""}
        onChange={(e) => setSelectedServerId(e.target.value)}
        disabled={domainAutoLocked || oauthLoading}
        className="h-11 w-full px-3.5 bg-muted/40 border border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200 text-sm text-foreground disabled:opacity-70 disabled:cursor-not-allowed"
      >
        {jmapServers.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>
      {domainAutoLocked && (
        <p className="text-[0.6875rem] text-muted-foreground leading-snug">
          {t("jmap_server_auto_picked")}
        </p>
      )}
    </div>
  ) : null;

  // Other servers in the list that sign in with their own OAuth client get a
  // button of their own, so signing in with Google does not first mean finding
  // the bridge in the server menu. Not in mobile handoff, which signs in
  // server-side against the selected server.
  const otherOauthServers = isMobileHandoff
    ? []
    : jmapServers.filter((s) => offersOwnOAuth(s) && s.id !== selectedServer?.id);
  const otherOauthButtons = otherOauthServers.map((s) => (
    <Button
      key={s.id}
      type="button"
      variant="outline"
      className="w-full h-11 font-medium text-[0.9375rem] rounded-xl border-border/60 hover:bg-muted/50"
      onClick={() => handleOAuthLogin(s)}
      disabled={oauthLoading || isLoading}
    >
      <LogIn className="w-4 h-4 me-2" />
      {s.oauth?.buttonLabel}
    </Button>
  ));

  const rememberMeBox = (
    <label className="flex items-center gap-2.5 cursor-pointer group select-none pt-1">
      <span className="relative flex items-center justify-center">
        <input
          type="checkbox"
          checked={rememberMe}
          onChange={(e) => setRememberMe(e.target.checked)}
          className="peer sr-only"
        />
        <span className="flex items-center justify-center w-[18px] h-[18px] rounded-[5px] border border-border/80 bg-muted/40 peer-checked:bg-primary peer-checked:border-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus-ring-color)] transition-all duration-200">
          {rememberMe && (
            <Check className="w-3 h-3 text-primary-foreground" stroke={3} aria-hidden="true" />
          )}
        </span>
      </span>
      <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
        {t("remember_me")}
      </span>
    </label>
  );

  // Demo-only mode: show only a large demo login button
  if (demoMode && !isAddAccountMode) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background via-muted/10 to-muted/30 relative px-4">
        {/* Theme toggle, hidden while the theme policy locks the mode (#1280) */}
        <div className="absolute top-5 end-5" ref={themeMenuRef} hidden={colorModeLocked} suppressHydrationWarning>
          <button
            type="button"
            ref={themeButtonRef}
            onClick={() => setShowThemeMenu(!showThemeMenu)}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all duration-200",
              showThemeMenu
                ? "bg-secondary border-border text-foreground shadow-md"
                : "bg-background/60 backdrop-blur-sm border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary/80 hover:border-border"
            )}
            aria-label={`${tTheme("label")}: ${tTheme(currentThemeOption.label)}`}
            aria-expanded={showThemeMenu}
            aria-haspopup="menu"
          >
            <CurrentThemeIcon className="w-4 h-4" />
            <span className="hidden sm:inline" suppressHydrationWarning>{tTheme(currentThemeOption.label)}</span>
          </button>

          {showThemeMenu && (
            <div
              ref={themeListRef}
              onKeyDown={onThemeMenuKeyDown}
              className="absolute end-0 top-full mt-2 w-40 rounded-xl border border-border bg-background shadow-lg overflow-hidden animate-fade-in z-50"
              role="menu"
              aria-label={tTheme("label")}
            >
              {THEME_OPTIONS.map((option) => {
                const Icon = option.icon;
                const isActive = theme === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => handleThemeSelect(option.value)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors",
                      isActive
                        ? "bg-primary/10 text-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="flex-1 text-start">{tTheme(option.label)}</span>
                    {isActive && <Check className="w-3.5 h-3.5 text-primary" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="w-full max-w-[440px] mx-auto">
          <div className="rounded-2xl border border-border/60 bg-background/80 backdrop-blur-sm shadow-xl shadow-black/5 dark:shadow-black/20 overflow-hidden">
            {/* Header with logo */}
            <div className="px-8 pt-12 pb-4 text-center">
              <div className="inline-flex items-center justify-center w-20 h-20 mb-6">
                <img
                  src={withBasePath(resolvedTheme === 'dark' ? loginLogoDarkUrl : loginLogoLightUrl)}
                  alt={appName}
                  className="max-w-20 max-h-20 object-contain"
                />
              </div>
              <h1 className="text-3xl font-bold text-foreground tracking-tight">
                {appName}
              </h1>
              <p className="text-base text-muted-foreground mt-2 max-w-xs mx-auto leading-relaxed">
                {t("demo_tagline")}
              </p>
            </div>

            {/* Large demo button */}
            <div className="px-8 pb-10 pt-4">
              {error && (
                <div role="alert" className={cn(
                  "mb-5 p-3 rounded-xl border border-destructive/20 bg-destructive/5 flex items-start gap-3",
                  shakeError && "animate-shake"
                )}>
                  <div className="w-10 h-10 rounded-full bg-destructive/15 text-destructive flex items-center justify-center flex-shrink-0 shadow-sm">
                    <AlertCircle className="w-5 h-5" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0 self-center">
                    <p className="text-sm text-destructive leading-relaxed">
                      {t(`error.${error}`) || t("error.generic")}
                    </p>
                  </div>
                </div>
              )}

              <Button
                type="button"
                className="w-full h-14 font-semibold text-lg bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:scale-[1.02] active:scale-[0.98]"
                onClick={handleDemoLogin}
                disabled={demoLoading || isLoading}
              >
                {demoLoading ? (
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {t("demo_launching")}
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <Play className="w-5 h-5" />
                    {t("demo_login_button")}
                  </div>
                )}
              </Button>

              <p className="text-center text-sm text-muted-foreground mt-4 leading-relaxed">
                {t("demo_no_signup")}
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-6 flex flex-col items-center gap-2">
            {loginCompanyName && (
              <p className="text-center text-xs text-muted-foreground font-medium">
                {loginCompanyName}
              </p>
            )}
            {(loginImprintUrl || loginPrivacyPolicyUrl || loginWebsiteUrl) && (
              <div className="flex items-center gap-3 flex-wrap justify-center">
                {loginWebsiteUrl && (
                  <a href={loginWebsiteUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors">
                    {t("website")}
                  </a>
                )}
                {loginImprintUrl && (
                  <a href={loginImprintUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors">
                    {t("imprint")}
                  </a>
                )}
                {loginPrivacyPolicyUrl && (
                  <a href={loginPrivacyPolicyUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors">
                    {t("privacy_policy")}
                  </a>
                )}
              </div>
            )}
            <HelpLinks listClassName="justify-center" />
            {loginShowVersion && <VersionBadge />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background via-muted/10 to-muted/30 relative px-4">
      <MobileHandoffConsent
        url={pendingHandoff?.url ?? null}
        resolveUrl={pendingHandoff?.resolveUrl ?? null}
        username={pendingHandoff?.username ?? ""}
        onCancel={() => {
          setPendingHandoff(null);
          router.push('/');
        }}
        onError={() => {
          setPendingHandoff(null);
          setHandoffError("server_error");
        }}
      />
      {/* Theme toggle - top right, dropdown style; hidden while the theme policy locks the mode (#1280) */}
      <div className="absolute top-5 end-5" ref={themeMenuRef} hidden={colorModeLocked} suppressHydrationWarning>
        <button
          type="button"
          ref={themeButtonRef}
          onClick={() => setShowThemeMenu(!showThemeMenu)}
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all duration-200",
            showThemeMenu
              ? "bg-secondary border-border text-foreground shadow-md"
              : "bg-background/60 backdrop-blur-sm border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary/80 hover:border-border"
          )}
          aria-label={`${tTheme("label")}: ${tTheme(currentThemeOption.label)}`}
          aria-expanded={showThemeMenu}
          aria-haspopup="menu"
        >
          <CurrentThemeIcon className="w-4 h-4" />
          <span className="hidden sm:inline" suppressHydrationWarning>{tTheme(currentThemeOption.label)}</span>
        </button>

        {showThemeMenu && (
          <div
            ref={themeListRef}
            onKeyDown={onThemeMenuKeyDown}
            className="absolute end-0 top-full mt-2 w-40 rounded-xl border border-border bg-background shadow-lg overflow-hidden animate-fade-in z-50"
            role="menu"
            aria-label={tTheme("label")}
          >
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isActive = theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => handleThemeSelect(option.value)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors",
                    isActive
                      ? "bg-primary/10 text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  <span className="flex-1 text-start">{tTheme(option.label)}</span>
                  {isActive && <Check className="w-3.5 h-3.5 text-primary" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="w-full max-w-[400px] mx-auto">
        {/* Card container */}
        <div className="rounded-2xl border border-border/60 bg-background/80 backdrop-blur-sm shadow-xl shadow-black/5 dark:shadow-black/20 overflow-hidden">
          {/* Header section with logo */}
          <div className="px-8 pt-10 pb-6 text-center">
            <div className={cn("inline-flex items-center justify-center mb-5", !hasLogoSize && "w-16 h-16")}>
              <img
                src={withBasePath(resolvedTheme === 'dark' ? loginLogoDarkUrl : loginLogoLightUrl)}
                alt={appName}
                className={cn("object-contain", !hasLogoSize && "max-w-16 max-h-16")}
                style={loginLogoStyle}
              />
            </div>
            {loginShowHeading && (
              <h1 className="text-2xl font-semibold text-foreground tracking-tight">
                {isAddAccountMode ? t("add_account_title") : appName}
              </h1>
            )}
            {loginShowSubtitle && (
              <p className="text-sm text-muted-foreground mt-1.5">
                {isAddAccountMode ? t("add_account_subtitle") : t("subtitle")}
              </p>
            )}
          </div>

          {/* Form section */}
          <div className="px-8 pb-8">
            {/* Session Expired Banner */}
            {sessionExpired && (
              <div
                className="mb-5 p-3 rounded-xl border border-info/20 bg-info/5 flex items-start gap-3"
                role="status"
                aria-live="polite"
              >
                <div className="w-10 h-10 rounded-full bg-info/15 text-info flex items-center justify-center flex-shrink-0 shadow-sm">
                  <Info className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0 self-center flex items-center gap-2">
                  <p className="text-sm text-info flex-1 leading-relaxed" data-testid="session-expired-reason">
                    {sessionEnd?.kind === "idle"
                      ? tSessionLimits("reason_idle", { minutes: sessionEnd.minutes })
                      : sessionEnd?.kind === "max"
                        ? tSessionLimits("reason_max", { hours: sessionEnd.hours })
                        : t("session_expired")}
                    {(sessionEnd?.draftsUnsaved || expiredDraftsUnsaved) && (
                      <span className="block mt-1" data-testid="session-drafts-not-saved">{tSessionLimits("drafts_not_saved")}</span>
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={() => setSessionExpired(false)}
                    className="p-1 rounded-md text-info hover:bg-info/10 transition-colors flex-shrink-0"
                    aria-label={t("dismiss")}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Error Message. Asking for the code is the next step of a
                sign-in that worked so far, not a failure (#1422). */}
            {shownError && (
              <div
                className={cn(
                  "mb-5 p-3 rounded-xl border flex items-start gap-3",
                  shownError === 'totp_required' ? "border-info/20 bg-info/5" : "border-destructive/20 bg-destructive/5",
                  shakeError && "animate-shake"
                )}
                data-testid="login-error"
                role={shownError === 'totp_required' ? "status" : "alert"}
              >
                <div className={cn(
                  "w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm",
                  shownError === 'totp_required' ? "bg-info/15 text-info" : "bg-destructive/15 text-destructive"
                )}>
                  {shownError === 'totp_required' ? <Info className="w-5 h-5" aria-hidden="true" /> : <AlertCircle className="w-5 h-5" aria-hidden="true" />}
                </div>
                <div className="flex-1 min-w-0 self-center">
                  <p id={errorId} className={cn("text-sm leading-relaxed", shownError === 'totp_required' ? "text-info" : "text-destructive")}>
                    {shownError === 'invalid_credentials' && showTotpField && totpCode
                      ? t('error.totp_invalid')
                      : t(`error.${shownError}`) || t("error.generic")}
                  </p>
                </div>
              </div>
            )}

            {/* Dev Mode: One-click login */}
            {devMode ? (
              <div className="space-y-4">
                <Button
                  type="button"
                  className="w-full h-12 font-medium text-base bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-lg shadow-primary/20"
                  onClick={handleDevLogin}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t("signing_in")}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <LogIn className="w-4 h-4" />
                      {t("sign_in")}
                    </div>
                  )}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Dev mode - logging in as dev@localhost
                </p>
              </div>
            ) : oauthOnly ? (
              /* OAuth-only mode: server picker (if any) plus the SSO button */
              <div className="space-y-4">
                {serverPicker}
                {oauthMetadata && showRememberMe && rememberMeBox}
                {oauthMetadata ? (
                  <Button
                    type="button"
                    className="w-full h-11 font-medium text-[0.9375rem] bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-md shadow-primary/15 hover:shadow-lg hover:shadow-primary/20"
                    onClick={() => handleOAuthLogin()}
                    disabled={oauthLoading}
                  >
                    {oauthLoading ? (
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {t("signing_in")}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <LogIn className="w-4 h-4" />
                        {selectedServer?.oauth?.buttonLabel || t("sign_in_sso")}
                      </div>
                    )}
                  </Button>
                ) : oauthDiscoveryDone ? (
                  <div className="p-3 rounded-xl border border-warning/20 bg-warning/5 flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-warning/15 text-warning flex items-center justify-center flex-shrink-0 shadow-sm">
                      <AlertCircle className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0 self-center">
                      <p className="text-sm text-warning leading-relaxed">
                        {t("error.oauth_discovery_failed")}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-center py-4">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                )}
              </div>
            ) : (
              /* Login Form */
              <form onSubmit={handleSubmit} className="space-y-5">
                <fieldset disabled={isLoading} className="space-y-4">
                  {serverPicker}
                  {/* JMAP Endpoint field (only when no server list and custom endpoints are allowed) */}
                  {!hasServerList && allowCustomJmapEndpoint && (
                    <div className="space-y-1.5">
                      <label htmlFor="jmap-endpoint" className="block text-sm font-medium text-foreground">
                        {t("jmap_endpoint_label")}
                      </label>
                      <Input
                        id="jmap-endpoint"
                        type="url"
                        dir="ltr"
                        value={jmapEndpoint}
                        onChange={(e) => setJmapEndpoint(e.target.value)}
                        className="h-11 px-3.5 bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200"
                        placeholder={t("jmap_endpoint_placeholder")}
                        required
                      />
                      <p className="text-[0.6875rem] text-muted-foreground leading-snug">
                        {t("jmap_endpoint_cors_hint")}
                      </p>
                    </div>
                  )}

                  {/* Username field. The access token names the account, so
                      token sign-in has none. */}
                  <div className={cn("space-y-1.5", signInWithToken && "hidden")}>
                    <label htmlFor="username" className="block text-sm font-medium text-foreground">
                      {t("username_label")}
                    </label>
                    <div className="relative">
                      <Input
                        ref={inputRef}
                        id="username"
                        type="text"
                        dir="ltr"
                        value={formData.username}
                        onChange={handleUsernameChange}
                        onFocus={handleUsernameFocus}
                        onKeyDown={handleKeyDown}
                        className="h-11 px-3.5 bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200"
                        placeholder={loginUsernamePlaceholder || t("username_placeholder")}
                        required={!signInWithToken}
                        // Password managers fill and save the pair by this (WCAG 3.3.8).
                        autoComplete="username"
                        autoFocus
                        // The recent accounts are a combobox's list: the arrow
                        // keys move through them while the focus stays here.
                        role={savedUsernames.length > 0 ? "combobox" : undefined}
                        aria-autocomplete={savedUsernames.length > 0 ? "list" : undefined}
                        aria-expanded={savedUsernames.length > 0 ? suggestionsOpen : undefined}
                        aria-controls={suggestionsOpen ? suggestionsId : undefined}
                        aria-activedescendant={suggestionsOpen && selectedSuggestionIndex >= 0 ? suggestionId(selectedSuggestionIndex) : undefined}
                        aria-invalid={credentialsBlamed || undefined}
                        aria-describedby={[credentialsBlamed ? errorId : null, suggestionsOpen ? suggestionsHintId : null].filter(Boolean).join(" ") || undefined}
                      />

                      {/* Recent accounts on this device */}
                      {suggestionsOpen && (
                        <>
                          <span id={suggestionsHintId} className="sr-only">{t("recent_accounts_hint")}</span>
                          <ul
                            ref={suggestionsRef}
                            id={suggestionsId}
                            role="listbox"
                            aria-label={t("recent_accounts")}
                            className="absolute top-full mt-1.5 w-full bg-background border border-border rounded-xl shadow-lg z-50 overflow-hidden"
                          >
                            {filteredSuggestions.map((username, index) => (
                              <li
                                key={username}
                                id={suggestionId(index)}
                                role="option"
                                aria-selected={index === selectedSuggestionIndex}
                                aria-label={username}
                                className={cn(
                                  "px-3.5 py-2.5 flex items-center justify-between hover:bg-muted cursor-pointer transition-colors",
                                  index === selectedSuggestionIndex && "bg-muted"
                                )}
                                // Keep the focus (and the caret) in the field.
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => selectSuggestion(username)}
                              >
                                <span className="text-sm text-foreground">{username}</span>
                                {/* Out of the tab order: from the keyboard, Delete
                                    removes the highlighted account. Named, so
                                    voice control can still press it. */}
                                <button
                                  type="button"
                                  tabIndex={-1}
                                  onClick={(e) => removeUsername(username, e)}
                                  className="p-1 hover:bg-secondary rounded-md transition-colors"
                                  aria-label={t("remove_account_from_list", { username })}
                                  title={t("remove_from_history")}
                                >
                                  <X className="w-3 h-3 text-muted-foreground" aria-hidden="true" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Password field. Hidden for an account that signs in at an
                      external provider (Lite on Stalwart): the submit button is
                      the SSO button then. */}
                  <div className={cn("space-y-1.5", (liteSsoRequired || signInWithToken) && "hidden")}>
                    <label htmlFor="password" className="block text-sm font-medium text-foreground">
                      {t("password_label")}
                    </label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        dir="ltr"
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className="h-11 px-3.5 pe-11 bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200"
                        placeholder={t("password_placeholder")}
                        required={!liteSsoRequired && !signInWithToken}
                        autoComplete="current-password"
                        {...errorProps(credentialsBlamed)}
                      />
                      {/* In the tab order, so keyboard users can check what
                          they typed. One name, the state in aria-pressed. */}
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute end-3 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t("show_password")}
                        aria-pressed={showPassword}
                        aria-controls="password"
                        title={showPassword ? t("hide_password") : t("show_password")}
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" aria-hidden="true" />
                        ) : (
                          <Eye className="w-4 h-4" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>

                  {signInWithToken && (
                    <div className="space-y-1.5">
                      <label htmlFor="access-token" className="block text-sm font-medium text-foreground">
                        {t("token_label")}
                      </label>
                      <Input
                        ref={tokenInputRef}
                        id="access-token"
                        type="password"
                        value={accessToken}
                        onChange={(e) => setAccessToken(e.target.value)}
                        className="h-11 px-3.5 bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200 font-mono"
                        placeholder={t("token_placeholder")}
                        required
                        autoComplete="off"
                        spellCheck={false}
                        data-lpignore="true"
                        {...errorProps(tokenBlamed)}
                      />
                      <p className="text-[0.6875rem] text-muted-foreground leading-snug">
                        {t("token_hint")}
                      </p>
                    </div>
                  )}

                  {/* 2FA toggle / field. The manual toggle can be hidden via
                      LOGIN_SHOW_TOTP (loginShowTotp) for deployments whose mail
                      server has no per-account TOTP (auth delegated to an
                      external directory); server-required TOTP still shows. */}
                  {liteSsoRequired || signInWithToken ? null : !showTotpField ? (
                    loginShowTotp ? (
                    <button
                      type="button"
                      onClick={() => {
                        setShowTotpField(true);
                        setTimeout(() => totpInputRef.current?.focus(), 50);
                      }}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Shield className="w-3.5 h-3.5" />
                      {t("totp_toggle")}
                    </button>
                    ) : null
                  ) : (
                    <div className="space-y-1.5">
                      <label htmlFor="totp" className="block text-sm font-medium text-foreground">
                        {t("totp_label")}
                      </label>
                      <Input
                        ref={totpInputRef}
                        id="totp"
                        type="text"
                        dir="ltr"
                        inputMode="numeric"
                        maxLength={6}
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                        className={cn(
                          "h-11 px-3.5 bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200 text-center font-mono tracking-widest",
                          error === 'totp_required' && "border-primary ring-2 ring-primary/30"
                        )}
                        placeholder={t("totp_placeholder")}
                        autoComplete="one-time-code"
                        {...errorProps(totpBlamed)}
                      />
                    </div>
                  )}

                  {loginShowTokenLogin && !isMobileHandoff && !liteSsoRequired && (
                    <button
                      type="button"
                      onClick={() => {
                        clearError();
                        setTokenMode(!signInWithToken);
                        setTimeout(() => (signInWithToken ? inputRef : tokenInputRef).current?.focus(), 50);
                      }}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      {signInWithToken ? t("password_toggle") : t("token_toggle")}
                    </button>
                  )}

                  {/* Remember me, for the password and the SSO buttons below */}
                  {showRememberMe && rememberMeBox}
                </fieldset>

                <Button
                  type="submit"
                  className="w-full h-11 font-medium text-[0.9375rem] bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-md shadow-primary/15 hover:shadow-lg hover:shadow-primary/20"
                  disabled={isLoading || (liteSsoRequired && oauthLoading)}
                >
                  {isLoading || (liteSsoRequired && oauthLoading) ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t("signing_in")}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <LogIn className="w-4 h-4" />
                      {liteSsoRequired ? t("sign_in_sso") : t("sign_in")}
                    </div>
                  )}
                </Button>

                {(oauthMetadata || liteSsoOffered || otherOauthButtons.length > 0) && (
                  <>
                    <div className="relative my-2">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t border-border/60" />
                      </div>
                      <div className="relative flex justify-center text-xs">
                        <span className="bg-background/80 px-3 text-muted-foreground">{t("or")}</span>
                      </div>
                    </div>

                    {(oauthMetadata || liteSsoOffered) && (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full h-11 font-medium text-[0.9375rem] rounded-xl border-border/60 hover:bg-muted/50"
                        onClick={() => handleOAuthLogin()}
                        disabled={oauthLoading || isLoading}
                      >
                        {oauthLoading ? (
                          <Loader2 className="w-4 h-4 animate-spin me-2" />
                        ) : (
                          <LogIn className="w-4 h-4 me-2" />
                        )}
                        {selectedServer?.oauth?.buttonLabel || t("sign_in_sso")}
                      </Button>
                    )}
                    {otherOauthButtons}
                  </>
                )}

                {((serverOauthEnabled && oauthDiscoveryDone && !oauthMetadata) || liteOAuthFailed) && (
                  <div className="mt-2 p-3 rounded-xl border border-warning/20 bg-warning/5 flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-warning/15 text-warning flex items-center justify-center flex-shrink-0 shadow-sm">
                      <AlertCircle className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0 self-center">
                      <p className="text-sm text-warning leading-relaxed">
                        {t("error.oauth_discovery_failed")}
                      </p>
                    </div>
                  </div>
                )}
              </form>
            )}

            {isAddAccountMode && (
              <div className="mt-4">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full h-10 text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => router.push('/')}
                >
                  {t("cancel")}
                </Button>
              </div>
            )}

            {/* Demo Mode Button */}
            {demoMode && !isAddAccountMode && (
              <div className="mt-4 pt-4 border-t border-border/40">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full h-11 font-medium text-[0.9375rem] rounded-xl border-border/60 hover:bg-muted/50"
                  onClick={handleDemoLogin}
                  disabled={demoLoading || isLoading}
                >
                  {demoLoading ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t("demo_launching")}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Play className="w-4 h-4" />
                      {t("try_demo")}
                    </div>
                  )}
                </Button>
                <p className="text-center text-xs text-muted-foreground mt-2">
                  {t("demo_description")}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Company name & links - below card */}
        <div className="mt-6 flex flex-col items-center gap-2">
          {loginCompanyName && (
            <p className="text-center text-xs text-muted-foreground font-medium">
              {loginCompanyName}
            </p>
          )}
          {(loginImprintUrl || loginPrivacyPolicyUrl || loginWebsiteUrl) && (
            <div className="flex items-center gap-3 flex-wrap justify-center">
              {loginWebsiteUrl && (
                <a
                  href={loginWebsiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors"
                >
                  {t("website")}
                </a>
              )}
              {loginImprintUrl && (
                <a
                  href={loginImprintUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors"
                >
                  {t("imprint")}
                </a>
              )}
              {loginPrivacyPolicyUrl && (
                <a
                  href={loginPrivacyPolicyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors"
                >
                  {t("privacy_policy")}
                </a>
              )}
            </div>
          )}
          <HelpLinks listClassName="justify-center" />
          {loginShowVersion && <VersionBadge />}
        </div>
      </div>
    </div>
  );
}

// useSearchParams() above must sit under a Suspense boundary for the route to
// prerender (the static Lite build); at runtime the boundary never suspends.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}
