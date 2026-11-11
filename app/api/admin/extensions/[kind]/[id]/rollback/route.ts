import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { HistoryError, readHistoryEntry } from '@/lib/admin/extension-history';
import { getPlugin, getTheme, savePlugin, saveTheme } from '@/lib/admin/plugin-registry';
import { invalidateFrameOriginsCache } from '@/lib/admin/csp-frame-origins';
import { sealPluginSecrets } from '@/lib/admin/plugin-config';
import { CREDENTIAL_HEADER_NAMES, unlistedCredentialHeaders } from '@/lib/plugin-secrets/credentials';
import { configReadOnlyResponse } from '@/lib/admin/config-read-only-response';
import { EXTENSION_ID_RE } from '@/lib/extension-package';
import { devicePolicyPluginRefusal } from '@/lib/desktop/server-policy';
import {
  anyGrants,
  compactGrants,
  describeReachAdded,
  grantsAdded,
  grantsOf,
  judgeAnswer,
  unexpectedMessage,
  type Grants,
} from '@/lib/admin/extension-grants';

/**
 * POST /api/admin/extensions/[kind]/[id]/rollback
 * Body: { version: string, acceptPermissions?: string[], acceptGrants?: object }
 *
 * Puts a previously installed version back from the server's own copy
 * (lib/admin/extension-history.ts). The directory is not involved, so this
 * works offline and for versions the directory has since withdrawn. The
 * extension keeps whether it is enabled or forced; only the code and the
 * manifest-derived fields go back to what that version had.
 *
 * A kept version that may do more than the installed one (permissions,
 * hosts, POST paths, frame origins, credential servers, which stored secret
 * a credential sends where, a setting that stops being a secret, the
 * privileged tier, a theme's skin) is refused
 * with 409 and `grantsAdded` until the request accepts it, the same question
 * an update asks (lib/admin/extension-grants.ts).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { kind, id } = await params;
    if (kind !== 'plugin' && kind !== 'theme') {
      return NextResponse.json({ error: 'Unknown extension kind' }, { status: 400 });
    }
    if (!EXTENSION_ID_RE.test(id)) return NextResponse.json({ error: 'Invalid extension id' }, { status: 400 });
    if (kind === 'plugin') {
      const refused = devicePolicyPluginRefusal(id);
      if (refused) return refused;
    }

    const body = await request.json().catch(() => ({}));
    const version = typeof body?.version === 'string' ? body.version.trim() : '';
    if (!version || version.length > 64) {
      return NextResponse.json({ error: 'Missing version' }, { status: 400 });
    }

    const now = new Date().toISOString();
    /**
     * The 409 for a kept version that brings back more than is installed, unless the
     * request accepted each addition as listed (and nothing else that wasn't installed).
     */
    const question = (added: Grants, seen: Grants, installed: string) => {
      const answer = judgeAnswer(added, seen, body ?? {});
      if (answer.settled) return null;
      return NextResponse.json(
        {
          error: answer.unexpected
            ? unexpectedMessage(answer.unexpected)
            : [
                `Version ${version} may do more than the installed ${installed}.`,
                ...(added.permissions.length > 0 ? [`Permissions it brings back: ${added.permissions.join(', ')}.`] : []),
                ...describeReachAdded(added),
              ].join(' '),
          permissionsAdded: added.permissions,
          grantsAdded: added,
          compared: 'rollback',
          ...(answer.unexpected ? { unexpected: answer.unexpected } : {}),
        },
        { status: 409 },
      );
    };

    if (kind === 'plugin') {
      const current = await getPlugin(id);
      if (!current) return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
      if (current.version === version) {
        return NextResponse.json({ error: `Version ${version} is already installed` }, { status: 409 });
      }
      const kept = await readHistoryEntry('plugin', id, version);
      // A kept version goes back as it was stored, so what an install checks
      // about a credential's header has to hold for it here.
      const headers = unlistedCredentialHeaders(kept.entry.credentials);
      if (headers.length > 0) {
        return NextResponse.json(
          {
            error: `Version ${version} puts a credential into the request header ${headers.map((h) => `"${h}"`).join(', ')}, `
              + `which is not a header a credential may use (${CREDENTIAL_HEADER_NAMES.join(', ')}). It can't be put back.`,
          },
          { status: 400 },
        );
      }
      const installed = grantsOf(current);
      const added = grantsAdded(installed, grantsOf(kept.entry));
      const asked = question(added, installed, current.version);
      if (asked) return asked;
      const plugin = {
        ...kept.entry,
        id,
        enabled: current.enabled,
        ...(current.forceEnabled !== undefined ? { forceEnabled: current.forceEnabled } : {}),
        defaultOff: current.defaultOff === true ? true : undefined,
        installedAt: current.installedAt,
        updatedAt: now,
      };
      // What the admin stored under the installed version's secret fields stays a
      // secret, whatever the kept version declares for those keys.
      await sealPluginSecrets(id, current.configSchema);
      await savePlugin(plugin, kept.code);
      invalidateFrameOriginsCache();
      await auditLog('plugin.rollback', {
        id, from: current.version, to: version,
        ...(anyGrants(added) ? { accepted: compactGrants(added) } : {}),
      }, ip);
      const saved = await getPlugin(id);
      return NextResponse.json({ success: true, plugin: saved ?? plugin });
    }

    const current = await getTheme(id);
    if (!current) return NextResponse.json({ error: 'Theme not found' }, { status: 404 });
    if (current.version === version) {
      return NextResponse.json({ error: `Version ${version} is already installed` }, { status: 409 });
    }
    const kept = await readHistoryEntry('theme', id, version);
    const installed = grantsOf(current);
    const added = grantsAdded(installed, { skin: kept.skin !== null });
    const asked = question(added, installed, current.version);
    if (asked) return asked;
    const theme = {
      ...kept.entry,
      id,
      enabled: current.enabled,
      ...(current.forceEnabled !== undefined ? { forceEnabled: current.forceEnabled } : {}),
      installedAt: current.installedAt,
      updatedAt: now,
    };
    await saveTheme(theme, kept.css, kept.skin);
    await auditLog('theme.rollback', {
      id, from: current.version, to: version,
      ...(anyGrants(added) ? { accepted: compactGrants(added) } : {}),
    }, ip);
    const saved = await getTheme(id);
    return NextResponse.json({ success: true, theme: saved ?? theme });
  } catch (error) {
    if (error instanceof HistoryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    logger.error('Extension rollback error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Rollback failed' }, { status: 500 });
  }
}
