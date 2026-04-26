// Admin dashboard types

export interface AdminData {
  passwordHash: string;
  createdAt: string;
  lastLogin: string | null;
  passwordChangedAt: string;
}

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
}

export const DEFAULT_POLICY: SettingsPolicy = {
  restrictions: {},
  features: { ...DEFAULT_FEATURE_GATES },
  defaults: {},
  themePolicy: { ...DEFAULT_THEME_POLICY },
  forceEnabledPlugins: [],
  approvedPlugins: [],
  forceEnabledThemes: [],
};

export interface AuditEntry {
  ts: string;
  action: string;
  detail: Record<string, unknown>;
  ip: string;
}

/** Config keys that map to environment variables */
export const CONFIG_ENV_MAP: Record<string, { envVar: string; fileEnvVar?: string; type: 'string' | 'boolean' | 'url' | 'enum'; defaultValue: unknown; enumValues?: string[] }> = {
  appName: { envVar: 'APP_NAME', type: 'string', defaultValue: 'Webmail' },
  jmapServerUrl: { envVar: 'JMAP_SERVER_URL', type: 'url', defaultValue: '' },
  stalwartFeaturesEnabled: { envVar: 'STALWART_FEATURES', type: 'boolean', defaultValue: true },
  demoMode: { envVar: 'DEMO_MODE', type: 'boolean', defaultValue: false },
  devMode: { envVar: 'DEV_MOCK_JMAP', type: 'boolean', defaultValue: false },
  faviconUrl: { envVar: 'FAVICON_URL', type: 'url', defaultValue: '/branding/Bulwark_Favicon.svg' },
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
  allowCustomJmapEndpoint: { envVar: 'ALLOW_CUSTOM_JMAP_ENDPOINT', type: 'boolean', defaultValue: false },
  autoSsoEnabled: { envVar: 'AUTO_SSO_ENABLED', type: 'boolean', defaultValue: false },
  cookieSameSite: { envVar: 'COOKIE_SAME_SITE', type: 'enum', defaultValue: 'lax', enumValues: ['lax', 'strict', 'none'] },
  allowedFrameAncestors: { envVar: 'ALLOWED_FRAME_ANCESTORS', type: 'string', defaultValue: '' },
  parentOrigin: { envVar: 'NEXT_PUBLIC_PARENT_ORIGIN', type: 'string', defaultValue: '' },
  settingsSyncEnabled: { envVar: 'SETTINGS_SYNC_ENABLED', type: 'boolean', defaultValue: false },
  logFormat: { envVar: 'LOG_FORMAT', type: 'enum', defaultValue: 'text', enumValues: ['text', 'json'] },
  logLevel: { envVar: 'LOG_LEVEL', type: 'enum', defaultValue: 'info', enumValues: ['error', 'warn', 'info', 'debug'] },
  sessionSecret: { envVar: 'SESSION_SECRET', fileEnvVar: 'SESSION_SECRET_FILE', type: 'string', defaultValue: '' },
};

/** Keys that should never be exposed to the client config endpoint */
export const SENSITIVE_CONFIG_KEYS = new Set(['oauthClientSecret', 'sessionSecret']);

/** Admin session cookie name */
export const ADMIN_SESSION_COOKIE = 'admin_session';

/** Default admin session TTL in seconds */
export const DEFAULT_ADMIN_SESSION_TTL = 3600;
