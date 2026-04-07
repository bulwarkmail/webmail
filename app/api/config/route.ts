import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { configManager } from '@/lib/admin/config-manager';
import { readFileEnv } from '@/lib/read-file-env';

/**
 * Runtime configuration endpoint
 *
 * This endpoint serves configuration values that can be set at runtime
 * via environment variables or admin dashboard overrides, enabling
 * post-build configuration for Docker deployments.
 *
 * Priority order:
 * 1. Admin dashboard overrides (data/admin/config.json)
 * 2. Runtime env vars (APP_NAME, JMAP_SERVER_URL)
 * 3. Build-time env vars (NEXT_PUBLIC_APP_NAME, NEXT_PUBLIC_JMAP_SERVER_URL)
 * 4. Default values
 */
export async function GET() {
  logger.debug('Config requested');
  await configManager.ensureLoaded();

  const appName = configManager.get<string>('appName') || process.env.NEXT_PUBLIC_APP_NAME || 'Webmail';
  const jmapServerUrl = configManager.get<string>('jmapServerUrl') || process.env.NEXT_PUBLIC_JMAP_SERVER_URL || '';
  const oauthEnabled = configManager.get<boolean>('oauthEnabled', false);
  const oauthOnly = oauthEnabled && configManager.get<boolean>('oauthOnly', false);
  const stalwartFeaturesEnabled = configManager.get<boolean>('stalwartFeaturesEnabled', true);
  const allowedFrameAncestors = configManager.get<string>('allowedFrameAncestors', '');

  return NextResponse.json({
    appName,
    jmapServerUrl,
    oauthEnabled,
    oauthOnly,
    oauthClientId: configManager.get<string>('oauthClientId', ''),
    oauthIssuerUrl: configManager.get<string>('oauthIssuerUrl', ''),
    rememberMeEnabled: !!process.env.SESSION_SECRET || !!readFileEnv(process.env.SESSION_SECRET_FILE),
    settingsSyncEnabled: configManager.get<boolean>('settingsSyncEnabled', false) && (!!process.env.SESSION_SECRET || !!readFileEnv(process.env.SESSION_SECRET_FILE)),
    stalwartFeaturesEnabled,
    devMode: configManager.get<boolean>('devMode', false),
    faviconUrl: configManager.get<string>('faviconUrl', '/branding/Bulwark_Favicon.svg'),
    appLogoLightUrl: configManager.get<string>('appLogoLightUrl', ''),
    appLogoDarkUrl: configManager.get<string>('appLogoDarkUrl', ''),
    loginLogoLightUrl: configManager.get<string>('loginLogoLightUrl', '/branding/Bulwark_Logo_Color.svg'),
    loginLogoDarkUrl: configManager.get<string>('loginLogoDarkUrl', '/branding/Bulwark_Logo_White.svg'),
    loginCompanyName: configManager.get<string>('loginCompanyName', ''),
    loginImprintUrl: configManager.get<string>('loginImprintUrl', ''),
    loginPrivacyPolicyUrl: configManager.get<string>('loginPrivacyPolicyUrl', ''),
    loginWebsiteUrl: configManager.get<string>('loginWebsiteUrl', ''),
    demoMode: configManager.get<boolean>('demoMode', false),
    allowCustomJmapEndpoint: configManager.get<boolean>('allowCustomJmapEndpoint', false),
    autoSsoEnabled: configManager.get<boolean>('autoSsoEnabled', false),
    embeddedMode: !!allowedFrameAncestors && allowedFrameAncestors !== "'none'",
    parentOrigin: configManager.get<string>('parentOrigin', ''),
  });
}
