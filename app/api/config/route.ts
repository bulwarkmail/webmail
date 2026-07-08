import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, redactJmapServers } from '@/lib/admin/jmap-servers';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { getOauthScopes } from '@/lib/oauth/tokens';
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
  type BrandingOverrideKey,
} from '@/lib/admin/domain-branding';

/**
 * Runtime configuration endpoint
 *
 * This endpoint serves configuration values that can be set at runtime
 * via environment variables or admin dashboard overrides, enabling
 * post-build configuration for Docker deployments.
 *
 * Priority order:
 * 1. Per-domain branding override (admin-configured, matched on request host)
 * 2. Admin dashboard overrides (data/admin/config.json)
 * 3. Runtime env vars (APP_NAME, JMAP_SERVER_URL)
 * 4. Build-time env vars (NEXT_PUBLIC_APP_NAME, NEXT_PUBLIC_JMAP_SERVER_URL)
 * 5. Default values
 */
export async function GET(request: NextRequest) {
  logger.debug('Config requested');
  await configManager.ensureLoaded();

  const host = pickRequestHost(request);
  const domainOverrides = matchDomainBranding(
    host,
    parseDomainBranding(configManager.get<unknown>('domainBranding', [])),
  );

  // Per-domain override wins over the global value, but only when the
  // entry explicitly sets that key. Otherwise we fall through to the
  // global admin/env/default chain.
  const branded = <T,>(key: BrandingOverrideKey, fallback: T): T => {
    const override = domainOverrides[key];
    if (typeof override === 'string' && override.length > 0) return override as T;
    return configManager.get<T>(key, fallback);
  };

  const appName =
    branded<string>('appName', '') || process.env.NEXT_PUBLIC_APP_NAME || 'Webmail';
  const jmapServerUrl = configManager.get<string>('jmapServerUrl') || process.env.NEXT_PUBLIC_JMAP_SERVER_URL || '';
  const oauthEnabled = configManager.get<boolean>('oauthEnabled', false);
  const oauthOnly = oauthEnabled && configManager.get<boolean>('oauthOnly', false);
  const stalwartFeaturesEnabled = configManager.get<boolean>('stalwartFeaturesEnabled', true);
  const allowedFrameAncestors = configManager.get<string>('allowedFrameAncestors', '');

  return NextResponse.json(
    {
      appName,
      jmapServerUrl,
      oauthEnabled,
      oauthOnly,
      oauthClientId: configManager.get<string>('oauthClientId', ''),
      oauthIssuerUrl: configManager.get<string>('oauthIssuerUrl', ''),
      oauthScopes: getOauthScopes(),
      rememberMeEnabled: hasSessionSecret(),
      settingsSyncEnabled: configManager.get<boolean>('settingsSyncEnabled', false) && hasSessionSecret(),
      stalwartFeaturesEnabled,
      devMode: configManager.get<boolean>('devMode', false),
      faviconUrl: branded<string>('faviconUrl', '/branding/Bulwark_Favicon.svg'),
      appLogoLightUrl: branded<string>('appLogoLightUrl', ''),
      appLogoDarkUrl: branded<string>('appLogoDarkUrl', ''),
      loginLogoLightUrl: branded<string>('loginLogoLightUrl', '/branding/Bulwark_Logo_Color.svg'),
      loginLogoDarkUrl: branded<string>('loginLogoDarkUrl', '/branding/Bulwark_Logo_White.svg'),
      loginCompanyName: branded<string>('loginCompanyName', ''),
      loginImprintUrl: branded<string>('loginImprintUrl', ''),
      loginPrivacyPolicyUrl: branded<string>('loginPrivacyPolicyUrl', ''),
      loginWebsiteUrl: branded<string>('loginWebsiteUrl', ''),
      loginLogoMaxHeight: configManager.get<string>('loginLogoMaxHeight', ''),
      loginLogoMaxWidth: configManager.get<string>('loginLogoMaxWidth', ''),
      loginShowHeading: configManager.get<boolean>('loginShowHeading', true),
      loginShowSubtitle: configManager.get<boolean>('loginShowSubtitle', true),
      demoMode: configManager.get<boolean>('demoMode', false),
      allowCustomJmapEndpoint: configManager.get<boolean>('allowCustomJmapEndpoint', false),
      jmapServers: redactJmapServers(parseJmapServers(configManager.get<unknown>('jmapServers', []))),
      jmapServerAutoPickByDomain: configManager.get<boolean>('jmapServerAutoPickByDomain', false),
      autoSsoEnabled: configManager.get<boolean>('autoSsoEnabled', false),
      embeddedMode: !!allowedFrameAncestors && allowedFrameAncestors !== "'none'",
      parentOrigin: configManager.get<string>('parentOrigin', ''),
    },
    {
      // Branding varies by host, so any cache between us and the browser
      // must key its entry by the host headers we consulted.
      headers: { Vary: 'Host, X-Forwarded-Host' },
    },
  );
}
