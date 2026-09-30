import type { ConfigData } from '@/hooks/use-config';
import type { SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';

/**
 * Runtime configuration for the static Lite build.
 *
 * `/api/config` used to merge env vars, the admin dashboard and per-host
 * branding on the server. Lite reads `config.json` instead: a deployer edits a
 * handful of keys (server URL, app name, logos) and everything else falls
 * back to the same defaults `useConfig` already assumes. Whatever the file
 * says, the flags that only work with a Next.js server behind them are forced
 * off so no surface ever calls an endpoint that does not exist.
 */

/** Keys a deployer may set in config.json. Everything else is ignored. */
export const LITE_CONFIG_KEYS = [
  'appName',
  'jmapServerUrl',
  'allowCustomJmapEndpoint',
  'jmapServers',
  'jmapServerAutoPickByDomain',
  'demoMode',
  'rememberMeEnabled',
  'faviconUrl',
  'appLogoLightUrl',
  'appLogoDarkUrl',
  'loginLogoLightUrl',
  'loginLogoDarkUrl',
  'loginCompanyName',
  'loginImprintUrl',
  'loginPrivacyPolicyUrl',
  'loginWebsiteUrl',
  'loginLogoMaxHeight',
  'loginLogoMaxWidth',
  'loginShowHeading',
  'loginShowSubtitle',
  'loginShowTotp',
  'loginShowVersion',
  'embeddedMode',
  'parentOrigin',
] as const;

/**
 * Flags that need the Next.js server (cookies, filesystem, OAuth relay). They
 * are pinned regardless of what config.json contains. `oauthEnabled` is the
 * server-relayed flow; Lite on Stalwart signs in through an OpenID provider
 * on its own, decided per account at runtime (lib/auth/lite-oauth.ts).
 */
export const LITE_FORCED_FLAGS = {
  oauthEnabled: false,
  oauthOnly: false,
  autoSsoEnabled: false,
  settingsSyncEnabled: false,
  stalwartFeaturesEnabled: false,
  stalwartJmapPassthroughEnabled: false,
  devMode: false,
} as const satisfies Partial<ConfigData>;

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function trimUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Turns the (possibly partial, possibly hand-edited) contents of config.json
 * into the full `ConfigData` shape the app consumes.
 *
 * - `jmapServerUrl` is trimmed of trailing slashes.
 * - `allowCustomJmapEndpoint` defaults to *on* when no server is configured,
 *   so an unedited download still lets people type their server.
 * - `rememberMeEnabled` defaults to on; the login page still hides the box for
 *   servers without Stalwart's token login (see lib/auth/lite-tokens.ts).
 * - `defaults.jmapServerUrl` (the Stalwart build passes the page origin) fills
 *   an empty server URL, and the server field then stays hidden unless
 *   config.json explicitly allows it.
 */
export function applyLiteConfig(raw: unknown, defaults?: { jmapServerUrl?: string }): ConfigData {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const jmapServerUrl = trimUrl(str(input.jmapServerUrl, '')) || trimUrl(defaults?.jmapServerUrl ?? '');
  const jmapServers = Array.isArray(input.jmapServers)
    ? (input.jmapServers as unknown[])
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .filter((entry) => typeof entry.id === 'string' && typeof entry.url === 'string')
        .map((entry) => ({
          id: entry.id as string,
          label: str(entry.label, entry.id as string),
          url: trimUrl(entry.url as string),
          domains: Array.isArray(entry.domains)
            ? (entry.domains as unknown[]).filter((d): d is string => typeof d === 'string')
            : [],
        }))
    : [];

  return {
    appName: str(input.appName, '') || 'Webmail',
    jmapServerUrl,
    oauthClientId: '',
    oauthIssuerUrl: '',
    oauthScopes: '',
    rememberMeEnabled: bool(input.rememberMeEnabled, true),
    faviconUrl: str(input.faviconUrl, '') || '/branding/Bulwark_Favicon.svg',
    appLogoLightUrl: str(input.appLogoLightUrl, ''),
    appLogoDarkUrl: str(input.appLogoDarkUrl, ''),
    loginLogoLightUrl: str(input.loginLogoLightUrl, '') || '/branding/Bulwark_Logo_Color.svg',
    loginLogoDarkUrl: str(input.loginLogoDarkUrl, '') || '/branding/Bulwark_Logo_White.svg',
    loginCompanyName: str(input.loginCompanyName, ''),
    loginImprintUrl: str(input.loginImprintUrl, ''),
    loginPrivacyPolicyUrl: str(input.loginPrivacyPolicyUrl, ''),
    loginWebsiteUrl: str(input.loginWebsiteUrl, ''),
    loginLogoMaxHeight: str(input.loginLogoMaxHeight, ''),
    loginLogoMaxWidth: str(input.loginLogoMaxWidth, ''),
    loginShowHeading: bool(input.loginShowHeading, true),
    loginShowSubtitle: bool(input.loginShowSubtitle, true),
    loginShowTotp: bool(input.loginShowTotp, true),
    loginShowVersion: bool(input.loginShowVersion, true),
    demoMode: bool(input.demoMode, false),
    allowCustomJmapEndpoint: bool(input.allowCustomJmapEndpoint, jmapServerUrl === '' && jmapServers.length === 0),
    jmapServers,
    jmapServerAutoPickByDomain: bool(input.jmapServerAutoPickByDomain, false),
    embeddedMode: bool(input.embeddedMode, false),
    parentOrigin: str(input.parentOrigin, ''),
    ...LITE_FORCED_FLAGS,
  };
}

/**
 * Zero-config defaults for a bundle served by Stalwart itself: the JMAP
 * server is the page's own origin (so no CORS), and there is nothing to type.
 */
export function liteStalwartDefaults(): { jmapServerUrl: string } {
  return { jmapServerUrl: typeof window === 'undefined' ? '' : window.location.origin };
}

/**
 * Policy for Lite: whatever policy.json says, merged over the defaults, with
 * the features that need the sandbox routes or the admin server pinned off.
 */
export function applyLitePolicy(raw: unknown): SettingsPolicy {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<SettingsPolicy>;
  return {
    ...DEFAULT_POLICY,
    ...input,
    restrictions: { ...(input.restrictions ?? {}) },
    defaults: { ...(input.defaults ?? {}) },
    themePolicy: { ...DEFAULT_POLICY.themePolicy, ...(input.themePolicy ?? {}) },
    features: {
      ...DEFAULT_POLICY.features,
      ...(input.features ?? {}),
      pluginsEnabled: false,
      pluginsUploadEnabled: false,
      sidebarAppsEnabled: false,
    },
    forceEnabledPlugins: [],
    approvedPlugins: [],
    forceEnabledThemes: [],
    defaultSidebarApps: [],
  };
}
