"use client";

import { freshLoginRequired } from "@/lib/app-lock/sign-out";
import { ContextMenu, ContextMenuCheckItem } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { Suspense, useState, useEffect, useRef, useCallback, useId, useMemo, useSyncExternalStore } from "react";
import { IS_DESKTOP_BUILD } from "@/lib/desktop/flag";
import { forgetDesktopServer, getDesktopBridge } from "@/lib/desktop/bridge";
import { customServerAllowedByDesktopPolicy, jmapServerAllowedByDesktopPolicy, useDesktopPolicy } from "@/lib/desktop/policy";
import { accountRefusedByDesktopPolicy } from "@/lib/desktop/refused-accounts";
import { browserSignInAvailable, cancelBrowserSignIn, runDesktopBrowserSignIn, runInstanceBrowserSignIn, type DesktopBrowserSignInOutcome } from "@/lib/desktop/browser-sign-in";
import { useRouter } from "@/i18n/navigation";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { useAuthStore, consumeSignedOut, SESSION_EXPIRED_DRAFTS_UNSAVED_KEY } from "@/stores/auth-store";
import { consumeLost } from "@/lib/offline/lost";
import { consumeWipeNote, onRefusedLoginsChanged, refusedWaits, type RefusedWait, type WipeNote } from "@/lib/devices/wipe-state";
import { wipeNoteText } from "@/components/offline/device-wipe-host";
import { useAccountStore } from "@/stores/account-store";
import { useThemeStore } from "@/stores/theme-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useShallow } from "zustand/react/shallow";
import { useConfig } from "@/hooks/use-config";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { apiFetch, getPathPrefix, toRouterPath, withBasePath } from "@/lib/browser-navigation";
import { cn } from "@/lib/utils";
import { AlertCircle, Loader2, X, Info, Eye, EyeOff, LogIn, Sun, Moon, Monitor, Check, Shield, Play, Copy, KeyRound } from "@/components/icons";
import { type OAuthMetadata } from "@/lib/oauth/discovery";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "@/lib/oauth/pkce";
import { DEFAULT_OAUTH_SCOPES, withProviderDataScopes } from "@/lib/oauth/scopes";
import { addOauthResource } from "@/lib/oauth/resource";
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
import { usePrefetchMailView, useWarmMailViewWhenIdle, warmMailView } from "@/hooks/use-prefetch-mail-view";
import { endSignInHold } from "@/lib/sign-in-hold";
import { buildMobileHandoffCodeUrl, buildMobileHandoffUrl, desktopHandoffDeclineUrl, desktopHandoffPort, desktopHandoffTarget, mobileCodeChallenge, mobileHandoffTarget, signedInLoginAction } from "@/lib/auth/mobile-handoff";
import { checkDesktopSignIn, parkDesktopSignIn, requestMobileHandoffCodeUrl } from "@/lib/auth/mobile-handoff-client";
import { MobileHandoffConsent } from "@/components/auth/mobile-handoff-consent";
import { LoginServerField, requestServerDiscovery, type ServerFieldError } from "@/components/auth/login-server-field";
import { emailDomain, normalizeServerInput, serverHostLabel, unsupportedProvider } from "@/lib/auth/mail-server-address";
import { loginHintFrom, serverOfSignedInDomain } from "@/lib/auth/login-hint";
import { askAndChangeConnection, changeConnectionAvailable } from "@/lib/desktop/change-connection";
import { HelpLinks } from "@/components/layout/help-links";
import { LoginFrame } from "@/components/auth/login-frame";
import { LoginSkeleton } from "@/components/boot-skeleton/login-skeleton";
import { Block } from "@/components/boot-skeleton/kit";
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
  const tDesktop = useTranslations("desktop_sign_in");
  const tBrowser = useTranslations("desktop_browser_sign_in");
  const tDesktopPolicy = useTranslations("desktop_policy");
  const desktopPolicy = useDesktopPolicy();
  // Only the desktop build sets these; a browser never shows them.
  const [desktopNotice, setDesktopNotice] = useState<string | null>(null);
  const [desktopWaiting, setDesktopWaiting] = useState(false);
  // Leaving the page ends a sign-in it's waiting for: the verifier goes with it.
  useEffect(() => () => cancelBrowserSignIn(), []);
  const tSessionLimits = useTranslations("session_limits");
  const tOffline = useTranslations("offline");
  const tOfflineWipe = useTranslations("offlineWipe");
  const tTheme = useTranslations("settings.appearance.theme");
  const tLogin = useTranslations("uxs_login");
  const tP3 = useTranslations("ux_p3_settings");
  const tCommonP3 = useTranslations("common");
  // Read after mount: the bridge isn't there during the server render.
  const [orgLinkOffered, setOrgLinkOffered] = useState(false);
  useEffect(() => setOrgLinkOffered(changeConnectionAvailable()), []);
  const params = useParams();
  const searchParams = useSearchParams();
  const isAddAccountMode = searchParams.get("mode") === "add-account";
  const [desktopPolicyNotice, setDesktopPolicyNotice] = useState<string | null>(null);
  // Whichever way someone got here: every account they have is on a server the device's
  // OS policy refuses for now. They wait, and come back when it's allowed again.
  useEffect(() => {
    const stored = useAccountStore.getState().accounts;
    if (stored.length > 0 && stored.every((account) => accountRefusedByDesktopPolicy(account, desktopPolicy))) {
      setDesktopPolicyNotice(tDesktopPolicy("server_refused"));
    }
  }, [desktopPolicy, tDesktopPolicy]);

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
  // The desktop app's loopback listener is the other target, only ever with a code and a
  // state, and the desktop build itself has no hand-off routes (lib/desktop/blocked-routes.ts).
  const { desktopBrowserSignIn: desktopSignInEnabled } = useConfig();
  const desktopTarget = !IS_DESKTOP_BUILD && desktopSignInEnabled && mobileChallenge && rawMobileState
    ? desktopHandoffTarget(searchParams.get("mobile_redirect_uri"))
    : "";
  const isDesktopHandoff = Boolean(desktopTarget);
  const mobileRedirectUri = desktopTarget || (rawMobileCodeChallenge && !mobileChallenge
    ? ""
    : mobileHandoffTarget(searchParams.get("mobile_redirect_uri")));
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
  const { appName, jmapServerUrl: configuredServerUrl, oauthEnabled, oauthOnly, oauthPasswordFallbackEnabled, oauthClientId: globalOauthClientId, oauthIssuerUrl: globalOauthIssuerUrl, oauthScopes, oauthResource, rememberMeEnabled, devMode, demoMode, loginLogoLightUrl, loginLogoDarkUrl, loginCompanyName, loginImprintUrl, loginPrivacyPolicyUrl, loginWebsiteUrl, loginUsernamePlaceholder, loginLogoMaxHeight, loginLogoMaxWidth, loginShowHeading, loginShowSubtitle, loginShowTotp, loginShowTokenLogin, loginShowRememberMe, loginShowVersion, isLoading: configLoading, error: configError, autoSsoEnabled, embeddedMode: _embeddedMode, allowCustomJmapEndpoint: configAllowsCustomEndpoint, jmapServers: configuredServers, jmapServerAutoPickByDomain } = useConfig();
  // The device's OS policy narrows what the server offers. A forced Bulwark server hides
  // the field for a server of one's own, unless that field is the only way to sign in there.
  const allowCustomJmapEndpoint = configAllowsCustomEndpoint && (customServerAllowedByDesktopPolicy(desktopPolicy) || !configuredServerUrl);
  const jmapServers = useMemo(
    () => (desktopPolicy.AllowedJmapServers.value ? configuredServers.filter((s) => jmapServerAllowedByDesktopPolicy(s.url, desktopPolicy)) : configuredServers),
    [configuredServers, desktopPolicy],
  );
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const colorModeLocked = usePolicyStore((s) => s.getColorModePolicy().locked);

  // Login logo sizing: when a max height/width is configured, drop the fixed
  // 64×64 box so the logo (e.g. a wide wordmark) can render at its true size.
  const hasLogoSize = Boolean(loginLogoMaxHeight || loginLogoMaxWidth);
  const loginLogoStyle = hasLogoSize
    ? { maxHeight: loginLogoMaxHeight || undefined, maxWidth: loginLogoMaxWidth || undefined }
    : undefined;

  // The address typed on the desktop app's first screen (or named by a link): the form
  // starts with it, looks its server up at once and puts the caret in the next field.
  const [loginHint] = useState(() => loginHintFrom(searchParams.get("login_hint")));
  const [formData, setFormData] = useState({
    // An account restored from the list backup opens this form with its address.
    username: (isAddAccountMode ? searchParams.get("username") : null) || loginHint,
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
  // A server of one's own (custom endpoint, the desktop app's standalone mode): the
  // email address comes first and the server is looked up from its domain (JMAP
  // well-known, SRV, then the admin's default). The field for it only opens when
  // nothing was found or the user wants another one. Lite has no server to ask
  // and keeps the field open.
  const customServerMode = !hasServerList && allowCustomJmapEndpoint;
  const canLookUpServer = customServerMode && !IS_LITE;
  const [serverEditing, setServerEditing] = useState(false);
  // Change on a found server: another one is wanted, nothing failed.
  const [serverChanging, setServerChanging] = useState(false);
  // Asks for focus in the server field once it is on screen (the field mounts in the next render).
  const [serverFocusRequest, setServerFocusRequest] = useState(0);
  const [serverLookup, setServerLookup] = useState<{ domain: string; status: "looking" | "found" | "failed"; url: string | null } | null>(null);
  const [serverError, setServerError] = useState<ServerFieldError>(null);
  const [emailNeeded, setEmailNeeded] = useState(false);
  const serverInputRef = useRef<HTMLInputElement>(null);
  const serverLookups = useRef(new Map<string, Promise<string | null>>());
  const typedDomain = canLookUpServer ? emailDomain(formData.username) : "";
  const unsupportedMailProvider = typedDomain ? unsupportedProvider(typedDomain) : null;
  const lookupForAddress = serverLookup && serverLookup.domain === typedDomain ? serverLookup : null;
  // What the lookup found, else the admin's default once it found nothing (or for
  // a user name with no domain to look up).
  const autoServer = lookupForAddress?.status === "found"
    ? lookupForAddress.url
    : configuredServerUrl && (lookupForAddress?.status === "failed" || (!typedDomain && formData.username.trim() !== ""))
      ? configuredServerUrl
      : null;
  const [totpCode, setTotpCode] = useState("");
  const [showTotpField, setShowTotpField] = useState(false);
  // Access-token sign-in (Bearer auth) in place of username and password.
  // The mobile hand-off passes a password on to the app, so it has none.
  const [tokenMode, setTokenMode] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const signInWithToken = tokenMode && loginShowTokenLogin && !isMobileHandoff;
  const serverFieldOpen = customServerMode && (
    !canLookUpServer
    || serverEditing
    || signInWithToken
    || unsupportedMailProvider !== null
    || (lookupForAddress?.status === "failed" && !configuredServerUrl)
  );
  /** The server a sign-in goes to right now, in custom-server mode; null when there is none yet. */
  const customServer = serverFieldOpen ? normalizeServerInput(jmapEndpoint) : autoServer;
  // With OAUTH_ONLY, a configured password fallback swaps the SSO-only card
  // for the regular password form, which carries its own "or" + SSO button
  // back. Off (the default) keeps the SSO-only card exactly as before.
  const [passwordFallbackMode, setPasswordFallbackMode] = useState(false);
  const passwordFallbackAvailable = oauthOnly && oauthPasswordFallbackEnabled;
  const [rememberMe, setRememberMe] = useState(false);
  // Lite (no server session): "remember me" needs Stalwart's token login on the
  // target server. Probe it once per URL and hide the box when it is missing;
  // those sessions then only last as long as the tab (lib/auth/lite-tokens.ts).
  const [liteTokenLoginSupported, setLiteTokenLoginSupported] = useState<boolean | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // Signed out by the organisation's idle timeout or maximum session length.
  const [sessionEnd, setSessionEnd] = useState<SessionEndReason | null>(null);
  // Offline outbox messages a sign-out deleted unsent (#523), named once.
  const [outboxLost, setOutboxLost] = useState<string[]>([]);
  // Unsent mail a wipe took with it: how many, never which.
  const [wipeLost, setWipeLost] = useState<WipeNote | null>(null);
  // Unsent mail that waits for a new password: how many and until when, never which.
  const [refusedWaiting, setRefusedWaiting] = useState<RefusedWait[]>([]);
  useEffect(() => {
    setOutboxLost(consumeLost());
    setWipeLost(consumeWipeNote());
    const read = () => setRefusedWaiting(refusedWaits());
    read();
    return onRefusedLoginsChanged(read);
  }, []);
  const [expiredDraftsUnsaved, setExpiredDraftsUnsaved] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [shakeError, setShakeError] = useState(false);
  // The theme menu: the app's menu, as everywhere else.
  const themeMenu = useContextMenu<null>();
  const showThemeMenu = themeMenu.contextMenu.isOpen;

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
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const prevError = useRef<string | null>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const themeButtonRef = useRef<HTMLButtonElement>(null);
  // Captured by handleSubmit when in mobile handoff mode; consumed by the
  // isAuthenticated effect to build the deep-link fragment.
  const mobileHandoffPayloadRef = useRef<{ server_url: string; username: string; password: string } | null>(null);

  useEffect(() => {
    initializeTheme();
  }, [initializeTheme]);

  const probeTarget = hasServerList
    ? selectedServer?.url ?? ""
    : (allowCustomJmapEndpoint ? normalizeServerInput(jmapEndpoint) : serverUrl) || "";
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
  // Not in the browser the desktop app opened: nothing stays in this browser to remember.
  const showRememberMe = canRememberSession && loginShowRememberMe && !isDesktopHandoff;
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
  // With or without a server set up: a page that came here from the mail view
  // would otherwise keep that view's title ("Mail - Bulwark").
  useDocumentTitle(isAddAccountMode ? t("add_account_title") : t("sign_in"), { showAccount: false });

  useEffect(() => {
    if (customServerMode) return;
    if (serverUrl && !jmapEndpoint) {
      setJmapEndpoint(serverUrl);
    }
  }, [serverUrl, jmapEndpoint, customServerMode]);

  /**
   * One lookup per domain while the page is open. A domain an account here already
   * signs in at needs none: the second address there goes to the same server, and
   * Change still picks another.
   */
  const lookUpServer = useCallback((domain: string, address: string): Promise<string | null> => {
    let pending = serverLookups.current.get(domain);
    if (!pending) {
      const known = serverOfSignedInDomain(useAccountStore.getState().accounts, domain);
      pending = known ? Promise.resolve(known) : requestServerDiscovery(address);
      serverLookups.current.set(domain, pending);
    }
    return pending;
  }, []);

  // Look the server up once the address is complete, after a pause in typing.
  const typedAddress = formData.username.trim();
  useEffect(() => {
    if (!typedDomain || unsupportedMailProvider || serverLookup?.domain === typedDomain) return;
    // An address handed over from the first screen is complete: no typing to wait for.
    const delay = loginHint && typedAddress === loginHint ? 0 : 600;
    const timer = setTimeout(() => {
      setServerLookup({ domain: typedDomain, status: "looking", url: null });
      lookUpServer(typedDomain, typedAddress).then((url) => {
        setServerLookup((current) => (current?.domain === typedDomain ? { domain: typedDomain, status: url ? "found" : "failed", url } : current));
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [typedDomain, typedAddress, unsupportedMailProvider, serverLookup?.domain, lookUpServer, loginHint]);

  useEffect(() => {
    if (serverFocusRequest) serverInputRef.current?.focus();
  }, [serverFocusRequest]);

  // The field opens by itself when the lookup found nothing, usually after the user
  // already left the address field. Focus goes there, unless they are typing elsewhere.
  const serverFieldOpenedByLookup = canLookUpServer && lookupForAddress?.status === "failed" && !configuredServerUrl && !unsupportedMailProvider;
  useEffect(() => {
    if (!serverFieldOpenedByLookup) return;
    const active = document.activeElement;
    if (active && active.id === "username") return;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      if (!(active.id === "password" && !active.value)) return;
    }
    serverInputRef.current?.focus();
  }, [serverFieldOpenedByLookup, typedDomain]);

  /**
   * The server to sign in to in custom-server mode, looked up now if need be.
   * Null after it opened the field and said what is missing there.
   */
  const resolveCustomServer = async (): Promise<string | null> => {
    setServerError(null);
    if (!serverFieldOpen) {
      if (typedDomain) {
        const url = await lookUpServer(typedDomain, typedAddress);
        setServerLookup({ domain: typedDomain, status: url ? "found" : "failed", url });
        if (url) return url;
      }
      if (configuredServerUrl && (typedDomain || typedAddress)) return configuredServerUrl;
    } else {
      const typed = normalizeServerInput(jmapEndpoint);
      if (typed) return typed;
    }
    setServerEditing(true);
    setServerError(serverFieldOpen && jmapEndpoint.trim() ? "invalid" : "needed");
    setServerFocusRequest((n) => n + 1);
    return null;
  };

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

  // A wrong password or token: focus that field with its text selected, ready to type again.
  useEffect(() => {
    if (error === "invalid_credentials" && !totpBlamed) {
      passwordInputRef.current?.focus();
      passwordInputRef.current?.select();
    } else if (error === "invalid_token") {
      tokenInputRef.current?.focus();
      tokenInputRef.current?.select();
    }
    // Only on a new error, not when the code field changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // The first screen's address after File > Change connection…: open that account if
    // it's here, else the form to add it with the address filled in (desktop-p3-2).
    if (action === "mailbox" && loginHint && !isAddAccountMode) {
      const wanted = loginHint.toLowerCase();
      const accounts = useAccountStore.getState().accounts;
      const match = accounts.find((a) => a.email?.toLowerCase() === wanted || a.username.toLowerCase() === wanted);
      if (!match) {
        router.replace(`/login?mode=add-account&login_hint=${encodeURIComponent(loginHint)}`);
        return;
      }
      if (match.id !== useAuthStore.getState().activeAccountId) void useAuthStore.getState().switchAccount(match.id);
      endSignInHold();
      router.push('/');
      return;
    }
    if (action === "mailbox") {
      // The page is about to go: nothing the app behind it needs waits now.
      endSignInHold();
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
  }, [isAuthenticated, router, isAddAccountMode, isMobileHandoff, offerMobileHandoff, loginHint]);

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
    // The device's OS policy, as for a password: nothing starts towards a refused server.
    if (serverUrl && !jmapServerAllowedByDesktopPolicy(serverUrl, desktopPolicy)) {
      setDesktopPolicyNotice(tDesktopPolicy("server_refused"));
      return;
    }
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
          // In the browser the desktop app opened, its word counts: the flag is in the app.
          ...(freshLoginRequired() || (isDesktopHandoff && searchParams.get("fresh_login") === "1") ? { fresh_login: true } : {}),
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
        // The app is waiting on this tab, so it can't just stay quiet here.
        if (isDesktopHandoff) setHandoffError("server_error");
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
  }, [params.locale, selectedServer?.id, serverUrl, desktopPolicy, tDesktopPolicy, persistProviderSession, isMobileHandoff, isDesktopHandoff, searchParams, mobileRedirectUri, mobileState, mobileChallenge]);

  useEffect(() => {
    // After signing out, show the login page rather than signing straight
    // back in through a provider session that outlived the sign-out (#905).
    if (signedOutOnPurpose.current === null) signedOutOnPurpose.current = consumeSignedOut();
    if (signedOutOnPurpose.current) return;
    if (!autoSsoEnabled || !oauthOnly || !oauthDiscoveryDone || !oauthMetadata) return;
    if (passwordFallbackMode) return;
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
  }, [autoSsoEnabled, oauthOnly, oauthDiscoveryDone, oauthMetadata, passwordFallbackMode, ssoError, isAddAccountMode, isAuthenticated, jmapServers.length, startServerSideSso]);

  const handleThemeSelect = useCallback((newTheme: "light" | "dark" | "system") => {
    setTheme(newTheme);
    themeMenu.closeContextMenu();
  }, [setTheme, themeMenu]);

  // The server HTML, and every visit until /api/config answers: the card's
  // shape, the same one signed-out visitors of the app pages get first. Also
  // the pass that hydrates that HTML, however far the config has got: this
  // page's Suspense boundary hydrates after the app around it, which may have
  // fetched the config by then, and drawing the form would throw the HTML away.
  const hydrating = useSyncExternalStore(neverChanges, notHydrating, isHydrating);
  useWarmMailViewWhenIdle(!isMobileHandoff && !configLoading && !hydrating);
  if (configLoading || hydrating) {
    return <LoginSkeleton label={t("loading")} />;
  }

  if (configError) {
    return (
      <LoginFrame cardClassName="p-8 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 mb-5">
          <AlertCircle className="w-8 h-8 text-red-500" />
        </div>
        <h1 className="text-xl font-semibold text-foreground mb-2">{t("config_error.title")}</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t("config_error.fetch_failed")}
        </p>
      </LoginFrame>
    );
  }

  if (!serverUrl && !demoMode && !allowCustomJmapEndpoint) {
    return (
      <LoginFrame cardClassName="p-8 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 mb-5">
          <AlertCircle className="w-8 h-8 text-red-500" />
        </div>
        <h1 className="text-xl font-semibold text-foreground mb-2">{t("config_error.title")}</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t("config_error.server_not_configured")}
        </p>
      </LoginFrame>
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
    setEmailNeeded(false);
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
    if (freshLoginRequired()) authUrl.searchParams.set("prompt", "login");

    window.location.href = authUrl.toString();
  };

  /**
   * Starts OAuth for the selected server, or for `target`: a server in the
   * list with its own OAuth client (a Gmail bridge, say), offered on the page
   * whichever server is selected so that "Sign in with Google" is one tap.
   */
  const handleOAuthLogin = async (target?: PublicJmapServerEntry) => {
    const oauthTarget = (target ?? selectedServer)?.url || (allowCustomJmapEndpoint ? customServer || configuredServerUrl : configuredServerUrl);
    if (oauthTarget && !jmapServerAllowedByDesktopPolicy(oauthTarget, desktopPolicy)) {
      setDesktopPolicyNotice(tDesktopPolicy("server_refused"));
      return;
    }
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
      || (allowCustomJmapEndpoint ? customServer || configuredServerUrl : configuredServerUrl);

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
    // RFC 8707 resource for the global provider only (#1461).
    addOauthResource(authUrl, oauthResource, Boolean(server));
    // OIDC: the provider's page starts with the address already typed here.
    const hint = loginHintFrom(formData.username);
    if (hint) authUrl.searchParams.set("login_hint", hint);
    if (isAddAccountMode) {
      authUrl.searchParams.set("prompt", "select_account");
    }
    if (freshLoginRequired()) authUrl.searchParams.set("prompt", "login");

    window.location.href = authUrl.toString();
  };

  /** What the user sees when a browser sign-in ends without one. Cancelling says nothing. */
  const showBrowserSignInOutcome = (outcome: DesktopBrowserSignInOutcome) => {
    setDesktopWaiting(false);
    if (outcome.kind === "policy") setDesktopPolicyNotice(tDesktopPolicy("server_refused"));
    else if (outcome.kind === "denied") setDesktopNotice(tBrowser("declined"));
    else if (outcome.kind === "declined") setDesktopNotice(tDesktop("server_declined"));
    else if (outcome.kind === "invalid") setDesktopNotice(tDesktop("server_invalid"));
    else if (outcome.kind === "timeout") setDesktopNotice(tBrowser("timed_out"));
    else if (outcome.kind === "no_browser") setDesktopNotice(tBrowser("no_browser"));
    else if (outcome.kind === "failed") setDesktopNotice(tBrowser("failed"));
  };

  /** The server's or the instance's own sign-in page in the system browser. */
  const handleBrowserSignIn = async () => {
    setDesktopNotice(null);
    setDesktopPolicyNotice(null);
    // Spelled out, not IS_DESKTOP_BUILD: only this form keeps the route out of other
    // builds' bundles, which Lite's check on API strings relies on.
    if (process.env.NEXT_PUBLIC_BULWARK_DESKTOP === '1') {
      let target = jmapEndpoint.trim();
      if (customServerMode) {
        // The address first: the server is found from it. A server typed by hand needs none.
        if (!typedAddress && !serverFieldOpen) {
          setEmailNeeded(true);
          inputRef.current?.focus();
          return;
        }
        const resolved = await resolveCustomServer();
        if (!resolved) return;
        target = resolved;
      } else if (!target) {
        setDesktopNotice(tDesktop("server_needed"));
        return;
      }
      if (!jmapServerAllowedByDesktopPolicy(target, desktopPolicy)) {
        setDesktopPolicyNotice(tDesktopPolicy("server_refused"));
        return;
      }
      setDesktopWaiting(true);
      const outcome = await runDesktopBrowserSignIn({
        serverUrl: target,
        slot: useAccountStore.getState().getNextCookieSlot(),
        remember: persistProviderSession,
        addAccount: isAddAccountMode,
        fresh: freshLoginRequired(),
        loginHint: loginHintFrom(typedAddress),
        redeem: (server, code, verifier, redirectUri) => useAuthStore.getState().loginWithOAuth(server, code, verifier, redirectUri),
        tryPassword: async ({ username, password, totp }) => {
          if (await useAuthStore.getState().login(target, username, password, totp, persistSession)) {
            if (!rememberMeEnabled || persistSession) saveUsername(username);
            return { ok: true };
          }
          const failed = useAuthStore.getState().error;
          return { ok: false, error: failed === "invalid_credentials" || failed === "totp_required" ? failed : "other" };
        },
      });
      if (outcome.kind === "signed-in") {
        setDesktopWaiting(false);
        router.push('/');
        return;
      }
      forgetDesktopServer(target, "failed");
      showBrowserSignInOutcome(outcome);
      return;
    }
    // A server the device's OS policy refuses, where it's known up front. With a list of
    // servers the browser picks, and the redeem below is what checks.
    if (!hasServerList && serverUrl && !jmapServerAllowedByDesktopPolicy(serverUrl, desktopPolicy)) {
      setDesktopPolicyNotice(tDesktopPolicy("server_refused"));
      return;
    }
    setDesktopWaiting(true);
    const outcome = await runInstanceBrowserSignIn({
      base: `${window.location.origin}${getPathPrefix(params.locale as string)}`,
      locale: params.locale as string,
      fresh: freshLoginRequired(),
      loginHint: loginHintFrom(formData.username),
    });
    if (outcome.kind !== "code") {
      showBrowserSignInOutcome(outcome);
      return;
    }
    const redeemed = await useAuthStore.getState().loginWithDesktopHandoff(outcome.code, outcome.verifier, {
      remember: persistProviderSession,
      rememberPassword: persistSession,
      allowedServers: desktopPolicy.AllowedJmapServers.value,
      // The same rule as the field for a server of one's own on this page.
      customServersAllowed: customServerAllowedByDesktopPolicy(desktopPolicy) || !configuredServerUrl,
    });
    setDesktopWaiting(false);
    if (redeemed === "ok") router.push('/');
    else if (redeemed === "blocked") setDesktopPolicyNotice(tDesktopPolicy("server_refused"));
    else setDesktopNotice(tBrowser("failed"));
  };

  const browserSignInShown = browserSignInAvailable() && desktopSignInEnabled;
  // Once a password (or token) is typed, "Sign in" is what the user means: it becomes the
  // main button and "Sign in with your browser" the other way.
  const formSignInPreferred = signInWithToken ? accessToken.trim() !== "" : formData.password !== "";
  const browserSignInPrimary = browserSignInShown && !formSignInPreferred;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Server-list entries always win - `allowCustomJmapEndpoint` is only honored
    // when the admin hasn't configured a server list.
    let effectiveServerUrl = selectedServer?.url
      || (allowCustomJmapEndpoint ? jmapEndpoint : serverUrl);
    if (customServerMode) {
      const resolved = await resolveCustomServer();
      if (!resolved) return;
      effectiveServerUrl = resolved;
    }
    // The desktop app opened this page in the user's browser. Nothing leaves this page until
    // the user says yes: the password is only checked, and a two-factor code can't be, as it
    // works once. This browser gets no session of its own out of any of it.
    if (isDesktopHandoff) {
      const failed = (reason: string) => {
        useAuthStore.setState({
          isLoading: false,
          error: reason === "invalid_credentials" || reason === "totp_required" ? reason : reason === "too_many_attempts" ? null : "server_error",
        });
        setDesktopNotice(reason === "too_many_attempts" ? tBrowser("too_many") : null);
      };
      const { username, password } = formData;
      const totp = totpCode || undefined;
      useAuthStore.setState({ isLoading: true, error: null });
      setHandoffError(null);
      setDesktopNotice(null);
      if (!totp) {
        const checked = await checkDesktopSignIn({ serverUrl: effectiveServerUrl, serverId: selectedServer?.id, username, password });
        if ("error" in checked) {
          failed(checked.error);
          return;
        }
      }
      useAuthStore.setState({ isLoading: false });
      const prefix = getPathPrefix(params.locale as string);
      setPendingHandoff({
        url: null,
        resolveUrl: async () => {
          const parked = await parkDesktopSignIn({
            challenge: mobileChallenge,
            state: mobileState,
            serverUrl: effectiveServerUrl,
            serverId: selectedServer?.id,
            username,
            password,
            totp,
            redirectUri: `${window.location.origin}${prefix}/${params.locale}/auth/callback`,
          });
          if ("error" in parked) {
            failed(parked.error);
            return null;
          }
          return buildMobileHandoffCodeUrl(mobileRedirectUri, parked.code, mobileState);
        },
        username,
      });
      return;
    }
    // The device's OS policy, also on an instance: nothing is sent to a server it refuses.
    setDesktopPolicyNotice(null);
    if (!jmapServerAllowedByDesktopPolicy(effectiveServerUrl, desktopPolicy)) {
      setDesktopPolicyNotice(tDesktopPolicy("server_refused"));
      return;
    }
    // A LAN or plain http server gets a native prompt first, and the app can
    // reach it from then on. Without a yes, nothing is sent there.
    if (IS_DESKTOP_BUILD) {
      setDesktopNotice(null);
      const prepared = await getDesktopBridge()?.servers?.prepare(effectiveServerUrl);
      if (prepared && !prepared.ok) {
        if (prepared.reason === "policy") setDesktopPolicyNotice(tDesktopPolicy("server_refused"));
        else setDesktopNotice(prepared.reason === "invalid" ? tDesktop("server_invalid") : tDesktop("server_declined"));
        return;
      }
    }
    // The mail view's code runs while the server checks the sign-in.
    if (!isMobileHandoff) warmMailView();
    // A link that brought the user here opens next (a message draws the
    // reader): the rest of the catalog comes now (lib/sign-in-hold.ts).
    try {
      if (sessionStorage.getItem('redirect_after_login')) endSignInHold();
    } catch { /* sessionStorage unavailable */ }
    if (signInWithToken) {
      if (await loginWithToken(effectiveServerUrl, accessToken, persistSession)) {
        router.push('/');
      } else if (IS_DESKTOP_BUILD) {
        forgetDesktopServer(effectiveServerUrl, 'failed');
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
    } else if (IS_DESKTOP_BUILD) {
      forgetDesktopServer(effectiveServerUrl, 'failed');
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
  // "Webmail" is the default name, not a brand: the heading then says what the page is for.
  const brandedAppName = appName && appName !== "Webmail" ? appName : "";
  const CurrentThemeIcon = currentThemeOption.icon;

  // The theme menu in the corner, hidden while the theme policy locks the mode (#1280).
  const themeToggle = (
    <div data-window-beside-controls="" className="absolute top-5 end-5 z-10" ref={themeMenuRef} hidden={colorModeLocked} suppressHydrationWarning>
      <button
        type="button"
        ref={themeButtonRef}
        onClick={(e) => (showThemeMenu ? themeMenu.closeContextMenu() : themeMenu.openContextMenuFrom(e.currentTarget, null, "end"))}
        className={cn(
          "flex items-center justify-center w-9 h-9 rounded-md border border-border transition-colors",
          showThemeMenu
            ? "bg-accent text-accent-foreground"
            : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"
        )}
        aria-label={`${tLogin("theme_button")}: ${tTheme(currentThemeOption.label)}`}
        title={tLogin("theme_button")}
        aria-expanded={showThemeMenu}
        aria-haspopup="menu"
        data-testid="login-theme-button"
      >
        <CurrentThemeIcon className="w-4 h-4" aria-hidden="true" />
      </button>

      <ContextMenu
        ref={themeMenu.menuRef}
        isOpen={showThemeMenu}
        position={themeMenu.contextMenu.position}
        onClose={themeMenu.closeContextMenu}
        label={tTheme("label")}
      >
        {THEME_OPTIONS.map((option) => (
          <ContextMenuCheckItem
            key={option.value}
            kind="radio"
            icon={option.icon}
            checked={theme === option.value}
            label={tTheme(option.label)}
            onClick={() => handleThemeSelect(option.value)}
          />
        ))}
      </ContextMenu>
    </div>
  );

  // Under the card: the company, its links, help and the version.
  const footerLinkClass = "text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2 transition-colors";
  const loginFooter = (
    <>
      {loginCompanyName && (
        <p className="text-center text-xs text-muted-foreground font-medium">
          {loginCompanyName}
        </p>
      )}
      {(loginImprintUrl || loginPrivacyPolicyUrl || loginWebsiteUrl) && (
        <div className="flex items-center gap-3 flex-wrap justify-center">
          {loginWebsiteUrl && (
            <a href={loginWebsiteUrl} target="_blank" rel="noopener noreferrer" className={footerLinkClass}>
              {t("website")}
            </a>
          )}
          {loginImprintUrl && (
            <a href={loginImprintUrl} target="_blank" rel="noopener noreferrer" className={footerLinkClass}>
              {t("imprint")}
            </a>
          )}
          {loginPrivacyPolicyUrl && (
            <a href={loginPrivacyPolicyUrl} target="_blank" rel="noopener noreferrer" className={footerLinkClass}>
              {t("privacy_policy")}
            </a>
          )}
        </div>
      )}
      <HelpLinks listClassName="justify-center" />
      {loginShowVersion && <VersionBadge />}
    </>
  );

  // Server picker (when admin has configured a server list). Rendered by both
  // the password form and the OAuth-only branch - with several servers the user
  // has to pick which one SSO targets before the button starts the flow, since
  // the selection drives OAuth discovery and the server_id sent to the callback
  // (issue #799).
  // In the app: the main way in, above the form, which stays as the other choice.
  const browserSignInOption = browserSignInShown && (
    <div className="space-y-3">
      <Button
        type="button"
        variant={browserSignInPrimary ? undefined : "outline"}
        className="w-full"
        onClick={handleBrowserSignIn}
        disabled={desktopWaiting || isLoading}
        data-testid="desktop-browser-sign-in"
      >
        {desktopWaiting ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : <LogIn className="w-4 h-4 me-2" />}
        {desktopWaiting ? tBrowser("waiting") : tBrowser("button")}
      </Button>
      {desktopWaiting && (
        <p role="status" data-testid="desktop-browser-waiting" className="text-center text-xs text-muted-foreground leading-relaxed">
          {tBrowser("waiting_hint")}{" "}
          <button
            type="button"
            className="underline hover:text-foreground"
            data-testid="desktop-browser-cancel"
            onClick={() => {
              cancelBrowserSignIn();
              setDesktopWaiting(false);
            }}
          >
            {tBrowser("cancel")}
          </button>
        </p>
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground py-1">
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <span>{tBrowser("or_here")}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
    </div>
  );

  // The desktop app's sign-in, in the browser: says what this page is for.
  const desktopHandoffBanner = isDesktopHandoff && (
    <p data-testid="desktop-handoff-banner" className="mb-4 text-center text-sm text-muted-foreground leading-relaxed">
      {tBrowser("handoff_banner")}
    </p>
  );

  const desktopPolicyAlert = desktopPolicyNotice && (
    <p role="alert" data-testid="desktop-policy-notice" className="mt-2 text-sm text-warning leading-relaxed">
      {desktopPolicyNotice}
    </p>
  );

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
        className="h-10 w-full px-3 bg-background border border-input rounded-md transition-colors text-sm text-foreground disabled:opacity-70 disabled:cursor-not-allowed"
      >
        {jmapServers.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>
      {domainAutoLocked && (
        <p className="text-xs text-muted-foreground leading-snug">
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
      className="w-full"
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
        <span className="flex items-center justify-center w-[18px] h-[18px] rounded-[5px] border border-input bg-background peer-checked:bg-primary peer-checked:border-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus-ring-color)] transition-all duration-200">
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
      <LoginFrame size="wide" before={themeToggle} footer={loginFooter}>
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
              "mb-5 p-3 rounded-md border border-destructive/20 bg-destructive/5 flex items-start gap-3",
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
            className="w-full h-12 text-base font-semibold"
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
      </LoginFrame>
    );
  }

  return (
    <LoginFrame
      before={
        <>
          <MobileHandoffConsent
            url={pendingHandoff?.url ?? null}
            resolveUrl={pendingHandoff?.resolveUrl ?? null}
            username={pendingHandoff?.username ?? ""}
            desktopPort={isDesktopHandoff ? desktopHandoffPort(desktopTarget) : undefined}
            onCancel={() => {
              setPendingHandoff(null);
              // Ends the flow at the app, which isn't left waiting. Nothing was parked.
              if (isDesktopHandoff) window.location.replace(desktopHandoffDeclineUrl(desktopTarget, mobileState));
              else router.push('/');
            }}
            onError={() => {
              setPendingHandoff(null);
              // The desktop's answer has said what went wrong, on the form.
              if (!isDesktopHandoff) setHandoffError("server_error");
            }}
          />
          {themeToggle}
        </>
      }
      footer={loginFooter}
    >
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
              {isAddAccountMode ? t("add_account_title") : brandedAppName || t("sign_in")}
            </h1>
          )}
          {/* Under a heading that already says "Sign in" the subtitle would say it twice. */}
          {loginShowSubtitle && (isAddAccountMode || brandedAppName || !loginShowHeading) && (
            <p className="text-sm text-muted-foreground mt-1.5">
              {isAddAccountMode ? t("add_account_subtitle") : t("subtitle")}
            </p>
          )}
        </div>

        {/* Form section */}
        <div className="px-8 pb-8">
          {wipeLost !== null && (
            <div className="mb-5 p-3 rounded-md border border-warning/30 bg-warning/5 text-sm text-foreground" role="status" data-testid="device-wipe-note">
              {wipeNoteText(wipeLost, tOfflineWipe)}
            </div>
          )}
          {refusedWaiting.map((wait) => {
            const date = new Date(wait.until).toLocaleDateString(String(params?.locale ?? "en"), { dateStyle: "medium" });
            const prefix = wait.kind === "session" ? "session_waiting" : "refused_waiting";
            return (
              <div key={wait.until} className="mb-5 p-3 rounded-md border border-warning/30 bg-warning/5 text-sm text-foreground" role="status" data-testid="login-refused-waiting">
                {wait.unsent === null ? tOfflineWipe(`${prefix}_unknown`, { date }) : tOfflineWipe(prefix, { count: wait.unsent, date })}
              </div>
            );
          })}
          {outboxLost.length > 0 && (
            <div className="mb-5 p-3 rounded-md border border-warning/30 bg-warning/5 text-sm text-foreground [overflow-wrap:anywhere]" role="status" data-testid="session-outbox-lost">
              {tOffline("signout.lost", { subjects: outboxLost.map((s) => s || tOffline("outbox.no_subject")).join(", ") })}
            </div>
          )}

          {/* Session Expired Banner */}
          {sessionExpired && (
            <div
              className="mb-5 p-3 rounded-md border border-info/20 bg-info/5 flex items-start gap-3"
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
                "mb-5 p-3 rounded-md border flex items-start gap-3",
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

          {desktopHandoffBanner}

          {/* Dev Mode: One-click login */}
          {devMode ? (
            <div className="space-y-4">
              <Button
                type="button"
                className="w-full"
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
          ) : oauthOnly && !passwordFallbackMode ? (
            /* OAuth-only mode: server picker (if any) plus the SSO button */
            <div className="space-y-4">
              {serverPicker}
              {desktopPolicyAlert}
              {oauthMetadata && showRememberMe && rememberMeBox}
              {browserSignInOption}
              {oauthMetadata ? (
                <Button
                  type="button"
                  variant={browserSignInShown ? "outline" : undefined}
                  className="w-full"
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
                <div className="p-3 rounded-md border border-warning/20 bg-warning/5 flex items-start gap-3">
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
                // Where the sign-in button goes once the provider answers.
                <Block className="w-full h-10 rounded-md" />
              )}
              {desktopNotice && (
                <p role="alert" data-testid="desktop-notice" className="mt-2 text-sm text-warning leading-relaxed">
                  {desktopNotice}
                </p>
              )}
              {passwordFallbackAvailable && (
                <button
                  type="button"
                  onClick={() => {
                    clearError();
                    setPasswordFallbackMode(true);
                    setTimeout(() => inputRef.current?.focus(), 50);
                  }}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {t("password_toggle")}
                </button>
              )}
            </div>
          ) : (
            /* Login Form */
            <form onSubmit={handleSubmit} className="space-y-5">
              <fieldset disabled={isLoading} className="space-y-4">
                {serverPicker}

                {!customServerMode && browserSignInOption}

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
                      value={formData.username}
                      onChange={handleUsernameChange}
                      onFocus={handleUsernameFocus}
                      onKeyDown={handleKeyDown}
                      placeholder={loginUsernamePlaceholder || t("username_placeholder")}
                      required={!signInWithToken}
                      // Password managers fill and save the pair by this (WCAG 3.3.8).
                      autoComplete="username"
                      // With the address handed over, the password is what's missing.
                      autoFocus={!loginHint}
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
                          className="absolute top-full mt-1.5 w-full bg-background border border-border rounded-md shadow-lg z-50 overflow-hidden"
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
                  {emailNeeded && (
                    <p role="alert" data-testid="login-email-needed" className="text-xs text-destructive leading-snug">
                      {tLogin("email_needed")}
                    </p>
                  )}
                </div>

                {customServerMode && (
                  <LoginServerField
                    ref={serverInputRef}
                    lookup={canLookUpServer ? lookupForAddress?.status ?? "idle" : "idle"}
                    server={autoServer}
                    editing={serverFieldOpen}
                    value={jmapEndpoint}
                    onChange={(value) => {
                      setJmapEndpoint(value);
                      setServerEditing(true);
                      setServerError(null);
                    }}
                    onEdit={() => {
                      setJmapEndpoint(autoServer ? serverHostLabel(autoServer) : "");
                      setServerEditing(true);
                      setServerChanging(true);
                      setServerFocusRequest((n) => n + 1);
                    }}
                    changing={serverChanging}
                    provider={unsupportedMailProvider}
                    error={serverError}
                    showTrouble={!IS_DESKTOP_BUILD}
                  />
                )}

                {customServerMode && browserSignInOption}

                {/* Password field. Hidden for an account that signs in at an
                    external provider (Lite on Stalwart): the submit button is
                    the SSO button then. */}
                <div className={cn("space-y-1.5", (liteSsoRequired || signInWithToken) && "hidden")}>
                  <label htmlFor="password" className="block text-sm font-medium text-foreground">
                    {t("password_label")}
                  </label>
                  <div className="relative">
                    <Input
                      ref={passwordInputRef}
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      className="pe-10 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20"
                      placeholder={t("password_placeholder")}
                      required={!liteSsoRequired && !signInWithToken}
                      autoComplete="current-password"
                      autoFocus={!!loginHint}
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
                      className="font-mono"
                      placeholder={t("token_placeholder")}
                      required
                      autoComplete="off"
                      spellCheck={false}
                      data-lpignore="true"
                      {...errorProps(tokenBlamed)}
                    />
                    <p className="text-xs text-muted-foreground leading-snug">
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
                      inputMode="numeric"
                      maxLength={6}
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      className={cn(
                        "text-center font-mono tracking-widest",
                        error === 'totp_required' && "border-primary ring-2 ring-primary/30"
                      )}
                      placeholder={t("totp_placeholder")}
                      autoComplete="one-time-code"
                      {...errorProps(totpBlamed)}
                    />
                  </div>
                )}

                {loginShowTokenLogin && !isMobileHandoff && !liteSsoRequired && (() => {
                  const tokenToggle = (
                    <button
                      type="button"
                      data-testid="login-token-toggle"
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
                  );
                  // Few people have a token: the way back to the password stays in sight,
                  // the way to a token waits behind "Other ways to sign in".
                  return signInWithToken ? tokenToggle : (
                    <details className="text-xs text-muted-foreground" data-testid="login-other-ways">
                      <summary className="cursor-pointer hover:text-foreground w-fit">{tLogin("other_ways")}</summary>
                      <div className="mt-2 ps-1">{tokenToggle}</div>
                    </details>
                  );
                })()}

                {/* Remember me, for the password and the SSO buttons below */}
                {showRememberMe && rememberMeBox}
              </fieldset>

              <Button
                type="submit"
                data-testid="login-submit"
                variant={browserSignInPrimary ? "outline" : undefined}
                className="w-full"
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
                  <div className="flex items-center gap-3 text-xs text-muted-foreground my-2">
                    <span aria-hidden="true" className="h-px flex-1 bg-border" />
                    <span>{t("or")}</span>
                    <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  </div>

                  {(oauthMetadata || liteSsoOffered) && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
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

              {desktopPolicyAlert}
              {desktopNotice && (
                <p role="alert" data-testid="desktop-notice" className="mt-2 text-sm text-warning leading-relaxed">
                  {desktopNotice}
                </p>
              )}
              {((serverOauthEnabled && oauthDiscoveryDone && !oauthMetadata) || liteOAuthFailed) && (
                <div className="mt-2 p-3 rounded-md border border-warning/20 bg-warning/5 flex items-start gap-3">
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

          {/* The desktop app on its own, first sign-in: the way back to "My organisation
              gave me a Bulwark web address" (settings-p3-1). It asks before the restart. */}
          {IS_DESKTOP_BUILD && customServerMode && !isAddAccountMode && orgLinkOffered && (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              <button
                type="button"
                data-testid="login-use-organisation"
                className="underline hover:text-foreground"
                onClick={() => {
                  void askAndChangeConnection({
                    title: tP3("connection.title"),
                    message: tP3("connection.message"),
                    confirm: tP3("connection.confirm"),
                    cancel: tCommonP3("cancel"),
                  });
                }}
              >
                {tP3("connection.org_link")}
              </button>
            </p>
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
                className="w-full"
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
    </LoginFrame>
  );
}

const neverChanges = () => () => {};
const notHydrating = () => false;
const isHydrating = () => true;

// useSearchParams() above must sit under a Suspense boundary for the route to
// prerender (the static Lite build); at runtime the boundary never suspends.
export default function LoginPage() {
  const t = useTranslations("login");
  return (
    <Suspense fallback={<LoginSkeleton label={t("loading")} />}>
      <LoginPageContent />
    </Suspense>
  );
}
