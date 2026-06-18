// Admin dashboard types

/**
 * Operator-authored admin record. Lives in admin.json under the config dir
 * and can be mounted read-only after setup. Only the password hash itself
 * is config; mutable timestamps live in AdminStateData.
 */
export interface AdminConfigData {
  passwordHash: string | undefined;
  passwordHashFile: string | undefined;
}

/**
 * Runtime-mutable admin record. Lives in admin-state.json under the state
 * dir. Updated on every login and password change, so it must stay writable.
 */
export interface AdminStateData {
  createdAt: string;
  lastLogin: string | null;
  passwordChangedAt: string;
}

/**
 * Combined view used by getAdminMeta() and tests. Constructed by merging
 * admin.json + admin-state.json at read time.
 */
export interface AdminData extends AdminConfigData, AdminStateData {}

export interface AdminSessionPayload {
  role: 'admin';
  iat: number;
  exp: number;
}

export interface SettingRestriction {
  locked?: boolean;
  value?: unknown;
  hidden?: boolean;
  allowedValues?: unknown[];
  min?: number;
  max?: number;
}

export interface FeatureGates {
  pluginsEnabled: boolean;
  pluginsUploadEnabled: boolean;
  requirePluginApproval: boolean;
  themesEnabled: boolean;
  sidebarAppsEnabled: boolean;
  userThemesEnabled: boolean;
  settingsExportEnabled: boolean;
  customKeywordsEnabled: boolean;
  templatesEnabled: boolean;
  calendarTasksEnabled: boolean;
  smimeEnabled: boolean;
  externalContentEnabled: boolean;
  debugModeEnabled: boolean;
  folderIconsEnabled: boolean;
  hoverActionsConfigEnabled: boolean;
  filesEnabled: boolean;
  contactsEnabled: boolean;
  allMailViewEnabled: boolean;
}

export const DEFAULT_FEATURE_GATES: FeatureGates = {
  pluginsEnabled: false,
  pluginsUploadEnabled: true,
  requirePluginApproval: true,
  themesEnabled: true,
  sidebarAppsEnabled: true,
  userThemesEnabled: true,
  settingsExportEnabled: true,
  customKeywordsEnabled: true,
  templatesEnabled: true,
  calendarTasksEnabled: true,
  smimeEnabled: true,
  externalContentEnabled: true,
  debugModeEnabled: true,
  folderIconsEnabled: true,
  hoverActionsConfigEnabled: true,
  filesEnabled: true,
  contactsEnabled: true,
  allMailViewEnabled: false,
};

export interface ThemePolicy {
  /** Built-in theme IDs that are disabled (hidden from users) */
  disabledBuiltinThemes: string[];
  /** Admin-deployed theme IDs that are disabled (hidden from users) */
  disabledThemes: string[];
  /** Default theme ID for new users (null = system default) */
  defaultThemeId: string | null;
}

export const DEFAULT_THEME_POLICY: ThemePolicy = {
  disabledBuiltinThemes: [],
  disabledThemes: [],
  defaultThemeId: null,
};

export interface SettingsPolicy {
  restrictions: Record<string, SettingRestriction>;
  features: FeatureGates;
  defaults: Record<string, unknown>;
  themePolicy: ThemePolicy;
  /** Plugin IDs that are force-enabled (users cannot disable) */
  forceEnabledPlugins: string[];
  /** Plugin IDs that have been approved by admin (users can enable) */
  approvedPlugins: string[];
  /** Theme IDs that are force-enabled (users cannot deactivate) */
  forceEnabledThemes: string[];
  /** Web Push relay base URL shown to users. Empty means the built-in default. */
  pushRelayUrl?: string;
  /** When true, users cannot change pushRelayUrl in notification settings. */
  pushRelayUrlLocked?: boolean;
}

export const DEFAULT_POLICY: SettingsPolicy = {
  restrictions: {},
  features: { ...DEFAULT_FEATURE_GATES },
  defaults: {},
  themePolicy: { ...DEFAULT_THEME_POLICY },
  forceEnabledPlugins: [],
  approvedPlugins: [],
  forceEnabledThemes: [],
  pushRelayUrl: '',
  pushRelayUrlLocked: false,
};

export interface AuditEntry {
  ts: string;
  action: string;
  detail: Record<string, unknown>;
  ip: string;
}

/** Config keys that map to environment variables */
export const CONFIG_ENV_MAP: Record<string, { envVar: string; fileEnvVar?: string; type: 'string' | 'boolean' | 'url' | 'enum' | 'json'; defaultValue: unknown; enumValues?: string[] }> = {
  appName: { envVar: 'APP_NAME', type: 'string', defaultValue: 'Webmail' },
  appShortName: { envVar: 'APP_SHORT_NAME', type: 'string', defaultValue: '' },
  appDescription: { envVar: 'APP_DESCRIPTION', type: 'string', defaultValue: '' },
  searchEngineIndexing: { envVar: 'SEARCH_ENGINE_INDEXING', type: 'boolean', defaultValue: false },
  jmapServerUrl: { envVar: 'JMAP_SERVER_URL', type: 'url', defaultValue: '' },
  stalwartFeaturesEnabled: { envVar: 'STALWART_FEATURES', type: 'boolean', defaultValue: true },
  demoMode: { envVar: 'DEMO_MODE', type: 'boolean', defaultValue: false },
  devMode: { envVar: 'DEV_MOCK_JMAP', type: 'boolean', defaultValue: false },
  faviconUrl: { envVar: 'FAVICON_URL', type: 'url', defaultValue: '/branding/Bulwark_Favicon.svg' },
  pwaIconUrl: { envVar: 'PWA_ICON_URL', type: 'url', defaultValue: '' },
  pwaScreenshotMobileUrl: { envVar: 'PWA_SCREENSHOT_MOBILE_URL', type: 'url', defaultValue: '' },
  pwaScreenshotDesktopUrl: { envVar: 'PWA_SCREENSHOT_DESKTOP_URL', type: 'url', defaultValue: '' },
  pwaThemeColor: { envVar: 'PWA_THEME_COLOR', type: 'string', defaultValue: '#ffffff' },
  pwaBackgroundColor: { envVar: 'PWA_BACKGROUND_COLOR', type: 'string', defaultValue: '#ffffff' },
  appLogoLightUrl: { envVar: 'APP_LOGO_LIGHT_URL', type: 'url', defaultValue: '' },
  appLogoDarkUrl: { envVar: 'APP_LOGO_DARK_URL', type: 'url', defaultValue: '' },
  loginLogoLightUrl: { envVar: 'LOGIN_LOGO_LIGHT_URL', type: 'url', defaultValue: '/branding/Bulwark_Logo_Color.svg' },
  loginLogoDarkUrl: { envVar: 'LOGIN_LOGO_DARK_URL', type: 'url', defaultValue: '/branding/Bulwark_Logo_White.svg' },
  loginCompanyName: { envVar: 'LOGIN_COMPANY_NAME', type: 'string', defaultValue: '' },
  loginImprintUrl: { envVar: 'LOGIN_IMPRINT_URL', type: 'url', defaultValue: '' },
  loginPrivacyPolicyUrl: { envVar: 'LOGIN_PRIVACY_POLICY_URL', type: 'url', defaultValue: '' },
  loginWebsiteUrl: { envVar: 'LOGIN_WEBSITE_URL', type: 'url', defaultValue: '' },
  oauthEnabled: { envVar: 'OAUTH_ENABLED', type: 'boolean', defaultValue: false },
  oauthOnly: { envVar: 'OAUTH_ONLY', type: 'boolean', defaultValue: false },
  oauthClientId: { envVar: 'OAUTH_CLIENT_ID', type: 'string', defaultValue: '' },
  oauthClientSecret: { envVar: 'OAUTH_CLIENT_SECRET', fileEnvVar: 'OAUTH_CLIENT_SECRET_FILE', type: 'string', defaultValue: '' },
  oauthIssuerUrl: { envVar: 'OAUTH_ISSUER_URL', type: 'url', defaultValue: '' },
  // Overrides only the user-facing authorize endpoint. Discovery, token exchange
  // and refresh continue to use the canonical OAUTH_ISSUER_URL. Lets a per-brand
  // authorize host front a single canonical issuer. Empty = use the discovered
  // authorization_endpoint.
  oauthAuthorizeUrl: { envVar: 'OAUTH_AUTHORIZE_URL', type: 'url', defaultValue: '' },
  oauthScopes: { envVar: 'OAUTH_SCOPES', type: 'string', defaultValue: '' },
  oauthExtraScopes: { envVar: 'OAUTH_EXTRA_SCOPES', type: 'string', defaultValue: '' },
  oauthAllowPrivateEndpoints: { envVar: 'OAUTH_ALLOW_PRIVATE_ENDPOINTS', type: 'boolean', defaultValue: false },
  allowCustomJmapEndpoint: { envVar: 'ALLOW_CUSTOM_JMAP_ENDPOINT', type: 'boolean', defaultValue: false },
  jmapServers: { envVar: 'JMAP_SERVERS', type: 'json', defaultValue: [] },
  jmapServerAutoPickByDomain: { envVar: 'JMAP_SERVER_AUTO_PICK_BY_DOMAIN', type: 'boolean', defaultValue: false },
  domainBranding: { envVar: 'DOMAIN_BRANDING', type: 'json', defaultValue: [] },
  autoSsoEnabled: { envVar: 'AUTO_SSO_ENABLED', type: 'boolean', defaultValue: false },
  cookieSameSite: { envVar: 'COOKIE_SAME_SITE', type: 'enum', defaultValue: 'lax', enumValues: ['lax', 'strict', 'none'] },
  allowedFrameAncestors: { envVar: 'ALLOWED_FRAME_ANCESTORS', type: 'string', defaultValue: '' },
  parentOrigin: { envVar: 'NEXT_PUBLIC_PARENT_ORIGIN', type: 'string', defaultValue: '' },
  settingsSyncEnabled: { envVar: 'SETTINGS_SYNC_ENABLED', type: 'boolean', defaultValue: false },
  logFormat: { envVar: 'LOG_FORMAT', type: 'enum', defaultValue: 'text', enumValues: ['text', 'json'] },
  logLevel: { envVar: 'LOG_LEVEL', type: 'enum', defaultValue: 'info', enumValues: ['error', 'warn', 'info', 'debug'] },
  sessionSecret: { envVar: 'SESSION_SECRET', fileEnvVar: 'SESSION_SECRET_FILE', type: 'string', defaultValue: '' },
  extensionDirectoryUrl: { envVar: 'EXTENSION_DIRECTORY_URL', type: 'url', defaultValue: 'https://extensions.bulwarkmail.org' },
};

/** Keys that should never be exposed to the client config endpoint */
export const SENSITIVE_CONFIG_KEYS = new Set(['oauthClientSecret', 'sessionSecret']);

/** Admin session cookie name */
export const ADMIN_SESSION_COOKIE = 'admin_session';

/** Default admin session TTL in seconds */
export const DEFAULT_ADMIN_SESSION_TTL = 3600;
