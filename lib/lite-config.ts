import type { ConfigData } from '@/hooks/use-config';
import type { SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { httpOrMailtoOrEmpty, httpUrlOrEmpty } from '@/lib/config-validation';
import { parseNoThirdPartyValue } from '@/lib/third-party-mode';
import { sanitizeOrganisationPolicy } from '@/lib/admin/organisation-policy';
import { sanitizeRestrictions, sanitizeScopes } from '@/lib/admin/policy-scopes';

/**
 * Flags that need the Next.js server (cookies, filesystem, OAuth relay). They
 * are pinned regardless of what config.json contains. `oauthEnabled` is the
 * server-relayed flow; Lite on Stalwart signs in through an OpenID provider
 * on its own, decided per account at runtime (lib/auth/lite-oauth.ts).
 */
export const LITE_FORCED_FLAGS = {
  oauthEnabled: false,
  oauthOnly: false,
  oauthPasswordFallbackEnabled: false,
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
 * - `rememberMeEnabled` defaults to on, and sign-ins are remembered without
 *   asking unless `loginShowRememberMe` shows the box. Servers without
 *   Stalwart's token login are never remembered (see lib/auth/lite-tokens.ts).
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
    oauthResource: '',
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
    loginUsernamePlaceholder: str(input.loginUsernamePlaceholder, ''),
    loginLogoMaxHeight: str(input.loginLogoMaxHeight, ''),
    loginLogoMaxWidth: str(input.loginLogoMaxWidth, ''),
    loginShowHeading: bool(input.loginShowHeading, true),
    loginShowSubtitle: bool(input.loginShowSubtitle, true),
    loginShowTotp: bool(input.loginShowTotp, true),
    loginShowTokenLogin: bool(input.loginShowTokenLogin, false),
    desktopBrowserSignIn: false,
    loginShowRememberMe: bool(input.loginShowRememberMe, false),
    loginShowVersion: bool(input.loginShowVersion, true),
    demoMode: bool(input.demoMode, false),
    allowCustomJmapEndpoint: bool(input.allowCustomJmapEndpoint, jmapServerUrl === '' && jmapServers.length === 0),
    jmapServers,
    jmapServerAutoPickByDomain: bool(input.jmapServerAutoPickByDomain, false),
    embeddedMode: bool(input.embeddedMode, false),
    parentOrigin: str(input.parentOrigin, ''),
    sourceCodeUrl: httpUrlOrEmpty(input.sourceCodeUrl),
    accessibilityStatementUrl: httpUrlOrEmpty(input.accessibilityStatementUrl),
    accessibilityFeedbackUrl: httpOrMailtoOrEmpty(input.accessibilityFeedbackUrl),
    helpUrl: httpUrlOrEmpty(input.helpUrl),
    easyReadUrl: httpUrlOrEmpty(input.easyReadUrl),
    signLanguageUrl: httpUrlOrEmpty(input.signLanguageUrl),
    // Same browser-side switches as the server build (lib/outgoing-hosts.ts).
    noThirdPartyTraffic: parseNoThirdPartyValue(input.noThirdPartyTraffic),
    oauthRevokeOnSignOut: bool(input.oauthRevokeOnSignOut, true),
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
    restrictions: sanitizeRestrictions(input.restrictions),
    defaults: { ...(input.defaults ?? {}) },
    themePolicy: { ...DEFAULT_POLICY.themePolicy, ...(input.themePolicy ?? {}) },
    features: {
      ...DEFAULT_POLICY.features,
      ...(input.features ?? {}),
      ...LITE_PINNED_FEATURES,
    },
    forceEnabledPlugins: [],
    approvedPlugins: [],
    forceEnabledThemes: [],
    defaultSidebarApps: [],
    organisation: sanitizeOrganisationPolicy(input.organisation),
    // A scope can't switch back on what Lite can't do.
    scopes: sanitizeScopes(input.scopes).map((scope) => ({
      ...scope,
      policy: { ...scope.policy, features: { ...scope.policy.features, ...LITE_PINNED_FEATURES } },
    })),
  };
}

const LITE_PINNED_FEATURES = {
  pluginsEnabled: false,
  pluginsUploadEnabled: false,
  sidebarAppsEnabled: false,
  // Kept by this app's server, which Lite does not have.
  accountArchiveEnabled: false,
  accountArchivePasswordsEnabled: false,
} as const;
