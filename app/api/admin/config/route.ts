import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { CONFIG_ENV_MAP, SENSITIVE_CONFIG_KEYS } from '@/lib/admin/types';
import { parseJmapServers } from '@/lib/admin/jmap-servers';
import { parseDomainBranding } from '@/lib/admin/domain-branding';
import { logger } from '@/lib/logger';

const BRANDING_CONFIG_KEYS = new Set([
  'faviconUrl',
  'pwaIconUrl',
  'appLogoLightUrl',
  'appLogoDarkUrl',
  'loginLogoLightUrl',
  'loginLogoDarkUrl',
  'pwaScreenshotMobileUrl',
  'pwaScreenshotDesktopUrl',
  'domainBranding',
]);

function canMutateBrandingConfig(payload: { authMethod: 'password' | 'stalwart' | 'legacy'; stalwartSystemAdmin?: boolean }): boolean {
  return payload.authMethod === 'stalwart' && payload.stalwartSystemAdmin === true;
}

// Strings that count as "no real secret configured" - used so the dashboard
// can warn about a placeholder session secret without us ever returning the
// raw value to the client.
const SENSITIVE_PLACEHOLDERS = new Set(['your-secret-key-here']);

/**
 * GET /api/admin/config - Get full config with sources (admin-protected)
 *
 * Sensitive keys (sessionSecret, oauthClientSecret) are returned with
 * `value` omitted and a `hasValue` boolean instead. An admin session is
 * enough to read every other config knob; the secrets themselves stay on
 * the server so that an XSS or session-theft can't lift them in one
 * request and forge admin/user session cookies offline.
 */
export async function GET(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    await configManager.ensureLoaded();
    const config = configManager.getAllWithSources();

    const safe: Record<string, { value?: unknown; source: 'admin' | 'env' | 'default'; hasValue?: boolean }> = {};
    for (const [key, entry] of Object.entries(config)) {
      if (SENSITIVE_CONFIG_KEYS.has(key)) {
        const v = entry.value;
        const hasValue =
          typeof v === 'string' && v.length > 0 && !SENSITIVE_PLACEHOLDERS.has(v);
        safe[key] = { source: entry.source, hasValue };
      } else {
        safe[key] = entry;
      }
    }

    return NextResponse.json(safe, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Admin config read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/config - Update config overrides (admin-protected)
 */
export async function PATCH(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const updates = await request.json();

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
    }

    // Validate keys
    const validKeys = Object.keys(CONFIG_ENV_MAP);
    const invalidKeys = Object.keys(updates).filter(k => !validKeys.includes(k));
    if (invalidKeys.length > 0) {
      return NextResponse.json({ error: `Unknown config keys: ${invalidKeys.join(', ')}` }, { status: 400 });
    }

    const brandingKeys = Object.keys(updates).filter(k => BRANDING_CONFIG_KEYS.has(k));
    if (brandingKeys.length > 0 && !canMutateBrandingConfig(result.payload)) {
      await auditLog('config.update_denied', {
        reason: 'stalwart_system_admin_required_for_branding',
        authMethod: result.payload.authMethod,
        stalwartSystemAdmin: result.payload.stalwartSystemAdmin === true,
        keys: brandingKeys,
      }, ip);
      return NextResponse.json(
        { error: 'Branding config changes require Stalwart system admin access' },
        { status: 403 },
      );
    }

    // Normalize jmapServers: pass through the parser so invalid entries are
    // rejected (bad ids, duplicate ids, non-HTTP URLs) before they're persisted.
    if ('jmapServers' in updates) {
      const incoming = updates.jmapServers;
      if (incoming != null && !Array.isArray(incoming)) {
        return NextResponse.json({ error: 'jmapServers must be an array' }, { status: 400 });
      }
      const sanitized = parseJmapServers(incoming);
      const incomingCount = Array.isArray(incoming) ? incoming.length : 0;
      if (sanitized.length !== incomingCount) {
        return NextResponse.json({
          error: 'One or more jmapServers entries are invalid (each needs a unique id, label, and HTTP(S) url).',
        }, { status: 400 });
      }
      updates.jmapServers = sanitized;
    }

    // Normalize domainBranding: drop entries with an invalid/missing host or
    // duplicate hosts before persisting. Each entry's branding field strings
    // are passed through unchanged (URL/string content is the operator's
    // responsibility, same as the flat branding fields).
    if ('domainBranding' in updates) {
      const incoming = updates.domainBranding;
      if (incoming != null && !Array.isArray(incoming)) {
        return NextResponse.json({ error: 'domainBranding must be an array' }, { status: 400 });
      }
      const sanitized = parseDomainBranding(incoming);
      const incomingCount = Array.isArray(incoming) ? incoming.length : 0;
      if (sanitized.length !== incomingCount) {
        return NextResponse.json({
          error: 'One or more domainBranding entries are invalid (each needs a unique, valid host).',
        }, { status: 400 });
      }
      updates.domainBranding = sanitized;
    }

    // Get old values for audit
    const oldValues: Record<string, unknown> = {};
    for (const key of Object.keys(updates)) {
      oldValues[key] = configManager.get(key);
    }

    await configManager.setAdminConfig(updates);
    await auditLog('config.update', { changes: Object.keys(updates).map(k => ({ key: k, old: oldValues[k], new: updates[k] })) }, ip);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin config update error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/config - Remove admin override for a key (revert to env/default)
 */
export async function DELETE(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { key } = await request.json();

    if (!key || typeof key !== 'string') {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 });
    }

    if (!CONFIG_ENV_MAP[key]) {
      return NextResponse.json({ error: `Unknown config key: ${key}` }, { status: 400 });
    }

    if (BRANDING_CONFIG_KEYS.has(key) && !canMutateBrandingConfig(result.payload)) {
      await auditLog('config.revert_denied', {
        reason: 'stalwart_system_admin_required_for_branding',
        authMethod: result.payload.authMethod,
        stalwartSystemAdmin: result.payload.stalwartSystemAdmin === true,
        key,
      }, ip);
      return NextResponse.json(
        { error: 'Branding config reverts require Stalwart system admin access' },
        { status: 403 },
      );
    }

    const oldValue = configManager.get(key);
    await configManager.removeAdminOverride(key);
    await auditLog('config.revert', { key, oldValue }, ip);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Admin config revert error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
