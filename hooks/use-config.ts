"use client";

import { useState, useEffect, useRef } from 'react';
import { usePolicyStore } from '@/stores/policy-store';
import { apiFetch } from '@/lib/browser-navigation';
import type { PublicJmapServerEntry } from '@/lib/admin/jmap-servers';
import { IS_LITE, IS_LITE_STALWART, LITE_CONFIG_PATH, withLiteBuildId } from '@/lib/lite';
import { applyLiteConfig, liteStalwartDefaults } from '@/lib/lite-config';
import { isConfigData } from '@/lib/config-validation';
import { setNoThirdPartyTraffic } from '@/lib/third-party-mode';
import { configureErrorReporting, type ClientSettings } from '@/lib/error-reporting/client';

export interface ConfigData {
  appName: string;
  jmapServerUrl: string;
  oauthEnabled: boolean;
  oauthOnly: boolean;
  oauthPasswordFallbackEnabled: boolean;
  oauthClientId: string;
  oauthIssuerUrl: string;
  oauthScopes: string;
  oauthResource: string;
  rememberMeEnabled: boolean;
  settingsSyncEnabled: boolean;
  stalwartFeaturesEnabled: boolean;
  stalwartJmapPassthroughEnabled: boolean;
  devMode: boolean;
  faviconUrl: string;
  appLogoLightUrl: string;
  appLogoDarkUrl: string;
  loginLogoLightUrl: string;
  loginLogoDarkUrl: string;
  loginCompanyName: string;
  loginImprintUrl: string;
  loginPrivacyPolicyUrl: string;
  loginWebsiteUrl: string;
  loginUsernamePlaceholder: string;
  loginLogoMaxHeight: string;
  loginLogoMaxWidth: string;
  loginShowHeading: boolean;
  loginShowSubtitle: boolean;
  loginShowTotp: boolean;
  loginShowTokenLogin: boolean;
  desktopBrowserSignIn: boolean;
  loginShowRememberMe: boolean;
  loginShowVersion: boolean;
  demoMode: boolean;
  autoSsoEnabled: boolean;
  allowCustomJmapEndpoint: boolean;
  jmapServers: PublicJmapServerEntry[];
  jmapServerAutoPickByDomain: boolean;
  embeddedMode: boolean;
  parentOrigin: string;
  sourceCodeUrl: string;
  /** Accessibility and help links (lib/help-links.ts); '' hides a link. */
  accessibilityStatementUrl: string;
  accessibilityFeedbackUrl: string;
  helpUrl: string;
  easyReadUrl: string;
  signLanguageUrl: string;
  /** The mail server's own account page (2FA, app passwords) and its link text (#1570); '' hides it. */
  accountManagementUrl: string;
  accountManagementLabel: string;
  /** Stay off every built-in outside host (#903; lib/outgoing-hosts.ts). */
  noThirdPartyTraffic: boolean;
  /** Lite only: whether sign-out revokes the refresh token (#1388). The server build decides in its token route. */
  oauthRevokeOnSignOut?: boolean;
  /** Server build only; Lite reads it from policy.json (stores/policy-store.ts). */
  errorReporting?: ClientSettings;
}

interface AppConfig extends ConfigData {
  isLoading: boolean;
  error: string | null;
}

let configCache: ConfigData | null = null;
let configPromise: Promise<ConfigData> | null = null;

/**
 * Static Lite build: the deployer-edited config.json next to index.html
 * replaces /api/config. A missing or broken file falls back to the defaults
 * (custom endpoint allowed) so an unedited download still lets people sign in.
 */
async function fetchLiteConfig(): Promise<ConfigData> {
  // On Stalwart the bundle is served from the JMAP origin: config.json ships
  // inside the zip and an empty server URL means "this origin". Stalwart
  // marks the file immutable, so the browser is told to ask again: an admin
  // may edit the zip without a new build id (#1563).
  const defaults = IS_LITE_STALWART ? liteStalwartDefaults() : undefined;
  try {
    const res = await apiFetch(withLiteBuildId(LITE_CONFIG_PATH), { cache: IS_LITE_STALWART ? 'no-cache' : 'no-store' });
    if (!res.ok) throw new Error(`config.json answered ${res.status}`);
    return applyLiteConfig(await res.json(), defaults);
  } catch (err) {
    // Fail closed (#903): without a readable config.json nobody said outside
    // hosts may be used, so the no-third-party switches stay on.
    console.warn('[lite] config.json missing or invalid, using defaults with no third-party traffic:', err);
    return applyLiteConfig({ noThirdPartyTraffic: true }, defaults);
  }
}

const CONFIG_ATTEMPT_DELAYS_MS = [0, 500, 1500] as const;
const CONFIG_TIMEOUT_MS = 10000;

async function fetchServerConfig(): Promise<ConfigData> {
  let lastError: unknown;
  for (const delay of CONFIG_ATTEMPT_DELAYS_MS) {
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    const controller = new AbortController();
    // Keep the timeout active while reading the body, not only the headers.
    const timeout = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    try {
      const response = await apiFetch('/api/config', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Failed to fetch config (${response.status})`);
      const data: unknown = await response.json();
      if (!isConfigData(data)) {
        throw new Error('Invalid application configuration');
      }
      return data;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

/** The config once fetched (it is fetched at app start), for code outside React. */
export function getCachedConfig(): ConfigData | null {
  return configCache;
}

export async function fetchConfig(): Promise<ConfigData> {
  // Return cached config if available
  if (configCache) {
    return configCache;
  }

  // If a fetch is already in progress, wait for it
  if (configPromise) {
    return configPromise;
  }

  // Start a new fetch
  configPromise = (IS_LITE ? fetchLiteConfig() : fetchServerConfig())
    .then((data) => {
      configCache = data;
      setNoThirdPartyTraffic(data.noThirdPartyTraffic === true);
      // Lite configures error reporting from policy.json instead.
      if (!IS_LITE) configureErrorReporting(data.errorReporting ?? null);
      // Fetch admin policy alongside config (non-blocking)
      usePolicyStore.getState().fetchPolicy();
      return data;
    })
    .finally(() => {
      configPromise = null;
    });

  return configPromise;
}

/**
 * The hook's state for fetched config: one object per config, shared by
 * every component that reads it. Each one used to build its own copy in an
 * effect after mounting, which drew it a second time (every avatar of every
 * list row, right after the rows came).
 */
const configStates = new WeakMap<ConfigData, AppConfig>();
function configState(data: ConfigData): AppConfig {
  let state = configStates.get(data);
  if (!state) {
    state = {
      appName: data.appName,
      jmapServerUrl: data.jmapServerUrl,
      oauthEnabled: data.oauthEnabled,
      oauthOnly: data.oauthOnly,
      oauthPasswordFallbackEnabled: data.oauthPasswordFallbackEnabled,
      oauthClientId: data.oauthClientId,
      oauthIssuerUrl: data.oauthIssuerUrl,
      oauthScopes: data.oauthScopes,
      oauthResource: data.oauthResource,
      rememberMeEnabled: data.rememberMeEnabled,
      settingsSyncEnabled: data.settingsSyncEnabled,
      stalwartFeaturesEnabled: data.stalwartFeaturesEnabled,
      stalwartJmapPassthroughEnabled: data.stalwartJmapPassthroughEnabled,
      devMode: data.devMode,
      faviconUrl: data.faviconUrl,
      appLogoLightUrl: data.appLogoLightUrl,
      appLogoDarkUrl: data.appLogoDarkUrl,
      loginLogoLightUrl: data.loginLogoLightUrl,
      loginLogoDarkUrl: data.loginLogoDarkUrl,
      loginCompanyName: data.loginCompanyName,
      loginImprintUrl: data.loginImprintUrl,
      loginPrivacyPolicyUrl: data.loginPrivacyPolicyUrl,
      loginWebsiteUrl: data.loginWebsiteUrl,
      loginUsernamePlaceholder: data.loginUsernamePlaceholder,
      loginLogoMaxHeight: data.loginLogoMaxHeight,
      loginLogoMaxWidth: data.loginLogoMaxWidth,
      loginShowHeading: data.loginShowHeading,
      loginShowSubtitle: data.loginShowSubtitle,
      loginShowTotp: data.loginShowTotp,
      loginShowTokenLogin: data.loginShowTokenLogin,
      desktopBrowserSignIn: data.desktopBrowserSignIn,
      loginShowRememberMe: data.loginShowRememberMe,
      loginShowVersion: data.loginShowVersion,
      demoMode: data.demoMode,
      autoSsoEnabled: data.autoSsoEnabled,
      allowCustomJmapEndpoint: data.allowCustomJmapEndpoint,
      jmapServers: data.jmapServers || [],
      jmapServerAutoPickByDomain: data.jmapServerAutoPickByDomain || false,
      embeddedMode: data.embeddedMode,
      parentOrigin: data.parentOrigin,
      sourceCodeUrl: data.sourceCodeUrl,
      accessibilityStatementUrl: data.accessibilityStatementUrl,
      accessibilityFeedbackUrl: data.accessibilityFeedbackUrl,
      helpUrl: data.helpUrl,
      easyReadUrl: data.easyReadUrl,
      signLanguageUrl: data.signLanguageUrl,
      accountManagementUrl: data.accountManagementUrl,
      accountManagementLabel: data.accountManagementLabel,
      noThirdPartyTraffic: data.noThirdPartyTraffic,
      isLoading: false,
      error: null,
    };
    configStates.set(data, state);
  }
  return state;
}

/**
 * Hook to fetch runtime configuration
 *
 * Fetches app configuration from /api/config endpoint, which reads
 * environment variables at runtime (not build time).
 *
 * The config is cached after first fetch to avoid unnecessary requests.
 */
export function useConfig(): AppConfig {
  // Already fetched: its state from the first render, and nothing to set after mounting.
  const fromCache = useRef(configCache);
  const [config, setConfig] = useState<AppConfig>(() => fromCache.current ? configState(fromCache.current) : {
    appName: configCache?.appName || 'Webmail',
    jmapServerUrl: configCache?.jmapServerUrl || '',
    oauthEnabled: configCache?.oauthEnabled || false,
    oauthOnly: configCache?.oauthOnly || false,
    oauthPasswordFallbackEnabled: configCache?.oauthPasswordFallbackEnabled || false,
    oauthClientId: configCache?.oauthClientId || '',
    oauthIssuerUrl: configCache?.oauthIssuerUrl || '',
    oauthScopes: configCache?.oauthScopes || '',
    oauthResource: configCache?.oauthResource || '',
    rememberMeEnabled: configCache?.rememberMeEnabled || false,
    settingsSyncEnabled: configCache?.settingsSyncEnabled || false,
    stalwartFeaturesEnabled: configCache?.stalwartFeaturesEnabled ?? true,
    stalwartJmapPassthroughEnabled: configCache?.stalwartJmapPassthroughEnabled ?? true,
    devMode: configCache?.devMode || false,
    faviconUrl: configCache?.faviconUrl || '/branding/Bulwark_Favicon.svg',
    appLogoLightUrl: configCache?.appLogoLightUrl || '',
    appLogoDarkUrl: configCache?.appLogoDarkUrl || '',
    loginLogoLightUrl: configCache?.loginLogoLightUrl || '/branding/Bulwark_Logo_Color.svg',
    loginLogoDarkUrl: configCache?.loginLogoDarkUrl || '/branding/Bulwark_Logo_White.svg',
    loginCompanyName: configCache?.loginCompanyName || '',
    loginImprintUrl: configCache?.loginImprintUrl || '',
    loginPrivacyPolicyUrl: configCache?.loginPrivacyPolicyUrl || '',
    loginWebsiteUrl: configCache?.loginWebsiteUrl || '',
    loginUsernamePlaceholder: configCache?.loginUsernamePlaceholder || '',
    loginLogoMaxHeight: configCache?.loginLogoMaxHeight || '',
    loginLogoMaxWidth: configCache?.loginLogoMaxWidth || '',
    loginShowHeading: configCache?.loginShowHeading ?? true,
    loginShowSubtitle: configCache?.loginShowSubtitle ?? true,
    loginShowTotp: configCache?.loginShowTotp ?? true,
    loginShowTokenLogin: configCache?.loginShowTokenLogin ?? false,
    desktopBrowserSignIn: configCache?.desktopBrowserSignIn ?? true,
    loginShowRememberMe: configCache?.loginShowRememberMe ?? false,
    loginShowVersion: configCache?.loginShowVersion ?? true,
    demoMode: configCache?.demoMode || false,
    autoSsoEnabled: configCache?.autoSsoEnabled || false,
    allowCustomJmapEndpoint: configCache?.allowCustomJmapEndpoint || false,
    jmapServers: configCache?.jmapServers || [],
    jmapServerAutoPickByDomain: configCache?.jmapServerAutoPickByDomain || false,
    embeddedMode: configCache?.embeddedMode || false,
    parentOrigin: configCache?.parentOrigin || '',
    sourceCodeUrl: configCache?.sourceCodeUrl || '',
    accessibilityStatementUrl: configCache?.accessibilityStatementUrl || '',
    accessibilityFeedbackUrl: configCache?.accessibilityFeedbackUrl || '',
    helpUrl: configCache?.helpUrl || '',
    easyReadUrl: configCache?.easyReadUrl || '',
    signLanguageUrl: configCache?.signLanguageUrl || '',
    accountManagementUrl: configCache?.accountManagementUrl || '',
    accountManagementLabel: configCache?.accountManagementLabel || '',
    noThirdPartyTraffic: configCache?.noThirdPartyTraffic ?? false,
    isLoading: !configCache,
    error: null,
  });

  useEffect(() => {
    // If already cached, no need to fetch
    if (configCache) {
      if (fromCache.current !== configCache) setConfig(configState(configCache));
      return;
    }

    fetchConfig()
      .then((data) => {
        setConfig(configState(data));
      })
      .catch((err) => {
        setConfig((prev) => ({
          ...prev,
          isLoading: false,
          error: err.message,
        }));
      });
  }, []);

  return config;
}

// The sign-in form and the app's first screen wait for the config. Asked for
// as soon as this module runs, it is on its way while the page's other
// modules run and the page hydrates, instead of from the first effect after
// that. Not in tests, which set up fetch per case.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'production') {
  void fetchConfig().catch(() => {
    // useConfig asks again.
  });
}
