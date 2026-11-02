import type { ConfigData } from '@/hooks/use-config';
import type { PublicJmapServerEntry } from '@/lib/admin/jmap-servers';

type Validator<T> = (value: unknown) => value is T;
type Validators<T> = { [Key in keyof T]-?: Validator<T[Key]> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isString: Validator<string> = (value): value is string => typeof value === 'string';
const isBoolean: Validator<boolean> = (value): value is boolean => typeof value === 'boolean';

function isJmapServers(value: unknown): value is PublicJmapServerEntry[] {
  return Array.isArray(value) && value.every((entry: unknown) => {
    if (!isRecord(entry)) return false;
    if (!isString(entry.id) || !isString(entry.label) || !isString(entry.url)) return false;
    if (!Array.isArray(entry.domains) || !entry.domains.every(isString)) return false;
    if (entry.oauth === undefined) return true;
    return isRecord(entry.oauth)
      && (entry.oauth.clientId === undefined || isString(entry.oauth.clientId))
      && (entry.oauth.issuerUrl === undefined || isString(entry.oauth.issuerUrl))
      && (entry.oauth.buttonLabel === undefined || isString(entry.oauth.buttonLabel));
  });
}

// Keep this exhaustive: a new required config field must be validated before
// a response can replace the hook's complete initial state and enter its cache.
const configValidators = {
  appName: isString,
  jmapServerUrl: isString,
  oauthEnabled: isBoolean,
  oauthOnly: isBoolean,
  oauthClientId: isString,
  oauthIssuerUrl: isString,
  oauthScopes: isString,
  oauthResource: isString,
  rememberMeEnabled: isBoolean,
  settingsSyncEnabled: isBoolean,
  stalwartFeaturesEnabled: isBoolean,
  stalwartJmapPassthroughEnabled: isBoolean,
  devMode: isBoolean,
  faviconUrl: isString,
  appLogoLightUrl: isString,
  appLogoDarkUrl: isString,
  loginLogoLightUrl: isString,
  loginLogoDarkUrl: isString,
  loginCompanyName: isString,
  loginImprintUrl: isString,
  loginPrivacyPolicyUrl: isString,
  loginWebsiteUrl: isString,
  loginUsernamePlaceholder: isString,
  loginLogoMaxHeight: isString,
  loginLogoMaxWidth: isString,
  loginShowHeading: isBoolean,
  loginShowSubtitle: isBoolean,
  loginShowTotp: isBoolean,
  loginShowTokenLogin: isBoolean,
  loginShowRememberMe: isBoolean,
  loginShowVersion: isBoolean,
  demoMode: isBoolean,
  autoSsoEnabled: isBoolean,
  allowCustomJmapEndpoint: isBoolean,
  jmapServers: isJmapServers,
  jmapServerAutoPickByDomain: isBoolean,
  embeddedMode: isBoolean,
  parentOrigin: isString,
  sourceCodeUrl: isString,
  accessibilityStatementUrl: isString,
  accessibilityFeedbackUrl: isString,
  helpUrl: isString,
  easyReadUrl: isString,
  signLanguageUrl: isString,
  noThirdPartyTraffic: isBoolean,
  // Lite only (lib/lite-config.ts); the server's response leaves it out.
  oauthRevokeOnSignOut: (value): value is boolean | undefined => value === undefined || typeof value === 'boolean',
  // Absent from Lite's config and from servers before 1.20.
  errorReporting: (value): value is ConfigData['errorReporting'] => value === undefined || (
    isRecord(value)
    && typeof value.dsn === 'string'
    && typeof value.sampleRate === 'number'
    && typeof value.environment === 'string'
    && typeof value.collect === 'boolean'
  ),
} satisfies Validators<ConfigData>;

/**
 * An absolute http(s) URL as given, or '' for anything else, so a configured
 * link can never carry a `javascript:` or other script-running scheme.
 */
export function httpUrlOrEmpty(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  try {
    const { protocol } = new URL(trimmed);
    return protocol === 'http:' || protocol === 'https:' ? trimmed : '';
  } catch {
    return '';
  }
}

const EMAIL_RE = /^[^\s@<>()"',;:\\/?#]+@[^\s@<>()"',;:\\/?#]+\.[^\s@<>()"',;:\\/?#]+$/;

/**
 * An absolute http(s) URL, a mailto: link, or an email address made into
 * one; '' for anything else. For links that may point at a mailbox, such
 * as the accessibility feedback address.
 */
export function httpOrMailtoOrEmpty(value: unknown): string {
  const url = httpUrlOrEmpty(value);
  if (url || typeof value !== 'string') return url;
  const trimmed = value.trim();
  if (/^mailto:/i.test(trimmed)) {
    const address = trimmed.slice('mailto:'.length).split('?')[0];
    return EMAIL_RE.test(address) ? trimmed : '';
  }
  return EMAIL_RE.test(trimmed) ? `mailto:${trimmed}` : '';
}

/** Validate the server's complete response without rewriting configured values. */
export function isConfigData(value: unknown): value is ConfigData {
  return isRecord(value)
    && Object.entries(configValidators).every(([key, validate]) => validate(value[key]));
}
