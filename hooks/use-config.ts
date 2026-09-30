"use client";

import { useState, useEffect } from 'react';
import { usePolicyStore } from '@/stores/policy-store';
import { apiFetch } from '@/lib/browser-navigation';
import type { PublicJmapServerEntry } from '@/lib/admin/jmap-servers';
import { IS_LITE, IS_LITE_STALWART, LITE_CONFIG_PATH, withLiteBuildId } from '@/lib/lite';
import { applyLiteConfig, liteStalwartDefaults } from '@/lib/lite-config';

export interface ConfigData {
  appName: string;
  jmapServerUrl: string;
  oauthEnabled: boolean;
  oauthOnly: boolean;
  oauthClientId: string;
  oauthIssuerUrl: string;
  oauthScopes: string;
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
  loginLogoMaxHeight: string;
  loginLogoMaxWidth: string;
  loginShowHeading: boolean;
  loginShowSubtitle: boolean;
  loginShowTotp: boolean;
  loginShowVersion: boolean;
  demoMode: boolean;
  autoSsoEnabled: boolean;
  allowCustomJmapEndpoint: boolean;
  jmapServers: PublicJmapServerEntry[];
  jmapServerAutoPickByDomain: boolean;
  embeddedMode: boolean;
  parentOrigin: string;
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
  // On Stalwart the bundle is read-only and served from the JMAP origin:
  // config.json ships inside the zip (build-id URL, immutable cache) and an
  // empty server URL means "this origin".
  const defaults = IS_LITE_STALWART ? liteStalwartDefaults() : undefined;
  try {
    const res = await apiFetch(withLiteBuildId(LITE_CONFIG_PATH), IS_LITE_STALWART ? undefined : { cache: 'no-store' });
    if (!res.ok) throw new Error(`config.json answered ${res.status}`);
    return applyLiteConfig(await res.json(), defaults);
  } catch (err) {
    console.warn('[lite] config.json missing or invalid, using defaults:', err);
    return applyLiteConfig({}, defaults);
  }
}

async function fetchServerConfig(): Promise<ConfigData> {
  const res = await apiFetch('/api/config');
  if (!res.ok) {
    throw new Error('Failed to fetch config');
  }
  return res.json();
}

/** Test hook: forget the cached config so the next fetch hits the network again. */
export function resetConfigCache(): void {
  configCache = null;
  configPromise = null;
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
 * Hook to fetch runtime configuration
 *
 * Fetches app configuration from /api/config endpoint, which reads
 * environment variables at runtime (not build time).
 *
 * The config is cached after first fetch to avoid unnecessary requests.
 */
export function useConfig(): AppConfig {
  const [config, setConfig] = useState<AppConfig>({
    appName: configCache?.appName || 'Webmail',
    jmapServerUrl: configCache?.jmapServerUrl || '',
    oauthEnabled: configCache?.oauthEnabled || false,
    oauthOnly: configCache?.oauthOnly || false,
    oauthClientId: configCache?.oauthClientId || '',
    oauthIssuerUrl: configCache?.oauthIssuerUrl || '',
    oauthScopes: configCache?.oauthScopes || '',
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
    loginLogoMaxHeight: configCache?.loginLogoMaxHeight || '',
    loginLogoMaxWidth: configCache?.loginLogoMaxWidth || '',
    loginShowHeading: configCache?.loginShowHeading ?? true,
    loginShowSubtitle: configCache?.loginShowSubtitle ?? true,
    loginShowTotp: configCache?.loginShowTotp ?? true,
    loginShowVersion: configCache?.loginShowVersion ?? true,
    demoMode: configCache?.demoMode || false,
    autoSsoEnabled: configCache?.autoSsoEnabled || false,
    allowCustomJmapEndpoint: configCache?.allowCustomJmapEndpoint || false,
    jmapServers: configCache?.jmapServers || [],
    jmapServerAutoPickByDomain: configCache?.jmapServerAutoPickByDomain || false,
    embeddedMode: configCache?.embeddedMode || false,
    parentOrigin: configCache?.parentOrigin || '',
    isLoading: !configCache,
    error: null,
  });

  useEffect(() => {
    // If already cached, no need to fetch
    if (configCache) {
      setConfig({
        appName: configCache.appName,
        jmapServerUrl: configCache.jmapServerUrl,
        oauthEnabled: configCache.oauthEnabled,
        oauthOnly: configCache.oauthOnly,
        oauthClientId: configCache.oauthClientId,
        oauthIssuerUrl: configCache.oauthIssuerUrl,
        oauthScopes: configCache.oauthScopes,
        rememberMeEnabled: configCache.rememberMeEnabled,
        settingsSyncEnabled: configCache.settingsSyncEnabled,
        stalwartFeaturesEnabled: configCache.stalwartFeaturesEnabled,
        stalwartJmapPassthroughEnabled: configCache.stalwartJmapPassthroughEnabled,
        devMode: configCache.devMode,
        faviconUrl: configCache.faviconUrl,
        appLogoLightUrl: configCache.appLogoLightUrl,
        appLogoDarkUrl: configCache.appLogoDarkUrl,
        loginLogoLightUrl: configCache.loginLogoLightUrl,
        loginLogoDarkUrl: configCache.loginLogoDarkUrl,
        loginCompanyName: configCache.loginCompanyName,
        loginImprintUrl: configCache.loginImprintUrl,
        loginPrivacyPolicyUrl: configCache.loginPrivacyPolicyUrl,
        loginWebsiteUrl: configCache.loginWebsiteUrl,
        loginLogoMaxHeight: configCache.loginLogoMaxHeight,
        loginLogoMaxWidth: configCache.loginLogoMaxWidth,
        loginShowHeading: configCache.loginShowHeading,
        loginShowSubtitle: configCache.loginShowSubtitle,
        loginShowTotp: configCache.loginShowTotp,
        loginShowVersion: configCache.loginShowVersion,
        demoMode: configCache.demoMode,
        autoSsoEnabled: configCache.autoSsoEnabled,
        allowCustomJmapEndpoint: configCache.allowCustomJmapEndpoint,
        jmapServers: configCache.jmapServers || [],
        jmapServerAutoPickByDomain: configCache.jmapServerAutoPickByDomain || false,
        embeddedMode: configCache.embeddedMode,
        parentOrigin: configCache.parentOrigin,
        isLoading: false,
        error: null,
      });
      return;
    }

    fetchConfig()
      .then((data) => {
        setConfig({
          appName: data.appName,
          jmapServerUrl: data.jmapServerUrl,
          oauthEnabled: data.oauthEnabled,
          oauthOnly: data.oauthOnly,
          oauthClientId: data.oauthClientId,
          oauthIssuerUrl: data.oauthIssuerUrl,
          oauthScopes: data.oauthScopes,
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
          loginLogoMaxHeight: data.loginLogoMaxHeight,
          loginLogoMaxWidth: data.loginLogoMaxWidth,
          loginShowHeading: data.loginShowHeading,
          loginShowSubtitle: data.loginShowSubtitle,
          loginShowTotp: data.loginShowTotp,
          loginShowVersion: data.loginShowVersion,
          demoMode: data.demoMode,
          autoSsoEnabled: data.autoSsoEnabled,
          allowCustomJmapEndpoint: data.allowCustomJmapEndpoint,
          jmapServers: data.jmapServers || [],
          jmapServerAutoPickByDomain: data.jmapServerAutoPickByDomain || false,
          embeddedMode: data.embeddedMode,
          parentOrigin: data.parentOrigin,
          isLoading: false,
          error: null,
        });
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
