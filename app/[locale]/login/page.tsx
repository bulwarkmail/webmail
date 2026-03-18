"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "@/i18n/navigation";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";
import { useShallow } from "zustand/react/shallow";
import { useConfig } from "@/hooks/use-config";
import { cn } from "@/lib/utils";
import { Mail, AlertCircle, Loader2, X, Info, Eye, EyeOff, LogIn, Sun, Moon, Monitor, Check, Shield } from "lucide-react";
import { discoverOAuth, type OAuthMetadata } from "@/lib/oauth/discovery";
import { generateCodeVerifier, generateCodeChallenge, generateState } from "@/lib/oauth/pkce";
import { OAUTH_SCOPES } from "@/lib/oauth/tokens";

const APP_VERSION = "1.4.1";

const THEME_OPTIONS = [
  { value: "light" as const, icon: Sun, label: "Light" },
  { value: "dark" as const, icon: Moon, label: "Dark" },
  { value: "system" as const, icon: Monitor, label: "System" },
];

export default function LoginPage() {
  const router = useRouter();
  const t = useTranslations("login");
  const params = useParams();
  const { login, isLoading, error, clearError, isAuthenticated } = useAuthStore();
  const { theme, setTheme, initializeTheme } = useThemeStore(useShallow((s) => ({ theme: s.theme, setTheme: s.setTheme, initializeTheme: s.initializeTheme })));
  const { appName, jmapServerUrl: serverUrl, oauthEnabled, oauthOnly, oauthClientId, oauthIssuerUrl, rememberMeEnabled, devMode, loginLogoLightUrl, loginLogoDarkUrl, loginCompanyName, loginImprintUrl, loginPrivacyPolicyUrl, loginWebsiteUrl, isLoading: configLoading, error: configError } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);

  const [formData, setFormData] = useState({
    username: "",
    password: "",
  });
  const [totpCode, setTotpCode] = useState("");
  const [showTotpField, setShowTotpField] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
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

  const suggestionsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const justSelectedSuggestion = useRef(false);
  const totpInputRef = useRef<HTMLInputElement>(null);
  const prevError = useRef<string | null>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initializeTheme();
  }, [initializeTheme]);

  useEffect(() => {
    if (serverUrl) {
      document.title = appName;
    }
  }, [appName, serverUrl]);

  useEffect(() => {
    try {
      if (sessionStorage.getItem('session_expired') === 'true') {
        setSessionExpired(true);
        sessionStorage.removeItem('session_expired');
      }
    } catch { /* sessionStorage unavailable */ }
  }, []);

  useEffect(() => {
    if (error && error !== prevError.current) {
      setShakeError(true);
      const timer = setTimeout(() => setShakeError(false), 400);
      return () => clearTimeout(timer);
    }
    prevError.current = error;
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

  useEffect(() => {
    if (isAuthenticated) {
      let redirectTo = '/';
      try {
        const saved = sessionStorage.getItem('redirect_after_login');
        if (saved) {
          sessionStorage.removeItem('redirect_after_login');
          redirectTo = saved;
        }
      } catch { /* ignore */ }
      router.push(redirectTo);
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    clearError();
  }, [formData, clearError]);

  useEffect(() => {
    if (!serverUrl) return;
    if (justSelectedSuggestion.current) {
      justSelectedSuggestion.current = false;
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
    if (!oauthEnabled || !serverUrl) return;
    discoverOAuth(oauthIssuerUrl || serverUrl)
      .then((metadata) => {
        setOauthMetadata(metadata);
        setOauthDiscoveryDone(true);
      })
      .catch(() => {
        setOauthMetadata(null);
        setOauthDiscoveryDone(true);
      });
  }, [oauthEnabled, serverUrl, oauthIssuerUrl]);

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

  if (!serverUrl) {
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

  const removeUsername = (username: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = savedUsernames.filter(u => u !== username);
    localStorage.setItem("webmail_usernames", JSON.stringify(updated));
    setSavedUsernames(updated);
    setFilteredSuggestions(updated.filter(u =>
      u.toLowerCase().includes(formData.username.toLowerCase())
    ));
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
    if (!showSuggestions || filteredSuggestions.length === 0) return;

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

  const handleOAuthLogin = async () => {
    if (!oauthMetadata || !oauthClientId) return;
    setOauthLoading(true);

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();
    const redirectUri = `${window.location.origin}/${params.locale}/auth/callback`;

    sessionStorage.setItem("oauth_code_verifier", verifier);
    sessionStorage.setItem("oauth_state", state);
    sessionStorage.setItem("oauth_server_url", serverUrl!);

    const authUrl = new URL(oauthMetadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", oauthClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", OAUTH_SCOPES);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    window.location.href = authUrl.toString();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const success = await login(
      serverUrl,
      formData.username,
      formData.password,
      totpCode || undefined,
      rememberMe
    );

    if (success) {
      saveUsername(formData.username);
      let redirectTo = '/';
      try {
        const saved = sessionStorage.getItem('redirect_after_login');
        if (saved) {
          sessionStorage.removeItem('redirect_after_login');
          redirectTo = saved;
        }
      } catch { /* ignore */ }
      router.push(redirectTo);
    }
  };

  const handleDevLogin = async () => {
    const success = await login(serverUrl, "dev@localhost", "dev");
    if (success) {
      let redirectTo = '/';
      try {
        const saved = sessionStorage.getItem('redirect_after_login');
        if (saved) {
          sessionStorage.removeItem('redirect_after_login');
          redirectTo = saved;
        }
      } catch { /* ignore */ }
      router.push(redirectTo);
    }
  };

  const currentThemeOption = THEME_OPTIONS.find(o => o.value === theme) || THEME_OPTIONS[2];
  const CurrentThemeIcon = currentThemeOption.icon;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background via-muted/10 to-muted/30 relative px-4">
      {/* Theme toggle - top right, dropdown style */}
      <div className="absolute top-5 right-5" ref={themeMenuRef} suppressHydrationWarning>
        <button
          type="button"
          onClick={() => setShowThemeMenu(!showThemeMenu)}
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all duration-200",
            showThemeMenu
              ? "bg-secondary border-border text-foreground shadow-md"
              : "bg-background/60 backdrop-blur-sm border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary/80 hover:border-border"
          )}
          aria-label={`Theme: ${currentThemeOption.label}`}
          aria-expanded={showThemeMenu}
          aria-haspopup="listbox"
        >
          <CurrentThemeIcon className="w-4 h-4" />
          <span className="hidden sm:inline" suppressHydrationWarning>{currentThemeOption.label}</span>
        </button>

        {showThemeMenu && (
          <div
            className="absolute right-0 top-full mt-2 w-40 rounded-xl border border-border bg-background shadow-lg overflow-hidden animate-fade-in z-50"
            role="listbox"
            aria-label="Theme selection"
          >
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isActive = theme === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleThemeSelect(option.value)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3.5 py-2.5 text-sm transition-colors",
                    isActive
                      ? "bg-primary/10 text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  <span className="flex-1 text-left">{option.label}</span>
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
            <div className="inline-flex items-center justify-center w-16 h-16 mb-5">
              <img
                src={resolvedTheme === 'dark' ? loginLogoDarkUrl : loginLogoLightUrl}
                alt={appName}
                className="max-w-16 max-h-16 object-contain"
              />
            </div>
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">
              {appName}
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5">
              {t("title") !== appName ? t("title") : "Sign in to your account"}
            </p>
          </div>

          {/* Form section */}
          <div className="px-8 pb-8">
            {/* Session Expired Banner */}
            {sessionExpired && (
              <div
                className="mb-5 p-3.5 bg-blue-500/10 border border-blue-500/20 rounded-xl flex items-start gap-3"
                role="status"
                aria-live="polite"
              >
                <Info className="w-4.5 h-4.5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-blue-700 dark:text-blue-300 flex-1 leading-relaxed">
                  {t("session_expired")}
                </p>
                <button
                  type="button"
                  onClick={() => setSessionExpired(false)}
                  className="p-0.5 rounded-md hover:bg-blue-500/10 transition-colors flex-shrink-0"
                  aria-label={t("dismiss")}
                >
                  <X className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                </button>
              </div>
            )}

            {/* Error Message */}
            {error && (
              <div className={cn(
                "mb-5 p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3",
                shakeError && "animate-shake"
              )}>
                <AlertCircle className="w-4.5 h-4.5 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-600 dark:text-red-400 leading-relaxed">
                  {error === 'invalid_credentials' && showTotpField && totpCode
                    ? t('error.totp_invalid')
                    : t(`error.${error}`) || t("error.generic")}
                </p>
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
                  Dev mode — logging in as dev@localhost
                </p>
              </div>
            ) : oauthOnly ? (
              /* OAuth-only mode: show SSO button only */
              <div className="space-y-4">
                {oauthMetadata ? (
                  <Button
                    type="button"
                    className="w-full h-11 font-medium text-[15px] bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-md shadow-primary/15 hover:shadow-lg hover:shadow-primary/20"
                    onClick={handleOAuthLogin}
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
                        {t("sign_in_sso")}
                      </div>
                    )}
                  </Button>
                ) : oauthDiscoveryDone ? (
                  <div className="p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-700 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      {t("error.oauth_discovery_failed")}
                    </p>
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
                  {/* Username field */}
                  <div className="space-y-1.5">
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
                        className="h-11 px-3.5 bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200"
                        placeholder={t("username_placeholder")}
                        required
                        autoComplete="off"
                        data-form-type="other"
                        data-lpignore="true"
                        autoFocus
                      />

                      {/* Custom autocomplete dropdown */}
                      {showSuggestions && filteredSuggestions.length > 0 && (
                        <div
                          ref={suggestionsRef}
                          className="absolute top-full mt-1.5 w-full bg-background border border-border rounded-xl shadow-lg z-50 overflow-hidden"
                        >
                          {filteredSuggestions.map((username, index) => (
                            <div
                              key={username}
                              className={cn(
                                "px-3.5 py-2.5 flex items-center justify-between hover:bg-muted cursor-pointer transition-colors",
                                index === selectedSuggestionIndex && "bg-muted"
                              )}
                              onClick={() => selectSuggestion(username)}
                            >
                              <span className="text-sm text-foreground">{username}</span>
                              <button
                                type="button"
                                onClick={(e) => removeUsername(username, e)}
                                className="p-1 hover:bg-secondary rounded-md transition-colors"
                                title={t("remove_from_history")}
                              >
                                <X className="w-3 h-3 text-muted-foreground" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Password field */}
                  <div className="space-y-1.5">
                    <label htmlFor="password" className="block text-sm font-medium text-foreground">
                      {t("password_label")}
                    </label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className="h-11 px-3.5 pr-11 bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200"
                        placeholder={t("password_placeholder")}
                        required
                        autoComplete="current-password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={showPassword ? t("hide_password") : t("show_password")}
                        tabIndex={-1}
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* 2FA toggle / field */}
                  {!showTotpField ? (
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
                        className="h-11 px-3.5 bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200 text-center font-mono tracking-widest"
                        placeholder={t("totp_placeholder")}
                        autoComplete="one-time-code"
                        aria-label={t("totp_label")}
                      />
                    </div>
                  )}

                  {/* Remember me */}
                  {rememberMeEnabled && (
                    <label className="flex items-center gap-2.5 cursor-pointer group select-none pt-1">
                      <span className="relative flex items-center justify-center">
                        <input
                          type="checkbox"
                          checked={rememberMe}
                          onChange={(e) => setRememberMe(e.target.checked)}
                          className="peer sr-only"
                        />
                        <span className="flex items-center justify-center w-[18px] h-[18px] rounded-[5px] border border-border/80 bg-muted/40 peer-checked:bg-primary peer-checked:border-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background transition-all duration-200">
                          {rememberMe && (
                            <svg className="w-3 h-3 text-primary-foreground" viewBox="0 0 12 12" fill="none">
                              <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </span>
                      </span>
                      <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                        {t("remember_me")}
                      </span>
                    </label>
                  )}
                </fieldset>

                <Button
                  type="submit"
                  className="w-full h-11 font-medium text-[15px] bg-primary hover:bg-primary/90 transition-all duration-200 rounded-xl shadow-md shadow-primary/15 hover:shadow-lg hover:shadow-primary/20"
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

                {oauthMetadata && (
                  <>
                    <div className="relative my-2">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t border-border/60" />
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-background/80 px-3 text-muted-foreground">{t("or")}</span>
                      </div>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      className="w-full h-11 font-medium text-[15px] rounded-xl border-border/60 hover:bg-muted/50"
                      onClick={handleOAuthLogin}
                      disabled={oauthLoading || isLoading}
                    >
                      {oauthLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      ) : (
                        <LogIn className="w-4 h-4 mr-2" />
                      )}
                      {t("sign_in_sso")}
                    </Button>
                  </>
                )}

                {oauthEnabled && oauthDiscoveryDone && !oauthMetadata && (
                  <div className="mt-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-700 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      {t("error.oauth_discovery_failed")}
                    </p>
                  </div>
                )}
              </form>
            )}
          </div>
        </div>

        {/* Company name & links - below card */}
        <div className="mt-6 flex flex-col items-center gap-2">
          {loginCompanyName && (
            <p className="text-center text-xs text-muted-foreground/60 font-medium">
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
                  className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  {t("website")}
                </a>
              )}
              {loginImprintUrl && (
                <a
                  href={loginImprintUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  {t("imprint")}
                </a>
              )}
              {loginPrivacyPolicyUrl && (
                <a
                  href={loginPrivacyPolicyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  {t("privacy_policy")}
                </a>
              )}
            </div>
          )}
          <p className="text-center text-xs text-muted-foreground/40">
            v{APP_VERSION}
          </p>
        </div>
      </div>
    </div>
  );
}
