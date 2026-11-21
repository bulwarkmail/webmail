import { NextRequest, NextResponse } from 'next/server';
import { getPlugin } from '@/lib/admin/plugin-registry';
import { getDevPlugin } from '@/lib/admin/plugin-dev';
import { getPluginConfig, setPluginConfig, deletePluginConfigKey } from '@/lib/admin/plugin-config';
import { requireAdminAuth } from '@/lib/admin/session';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { configReadOnlyResponse } from '@/lib/admin/config-read-only-response';
import { storeUnavailableResponse } from '@/lib/admin/store-unavailable-response';
import { adminSettings, declarationOf, isOrdinarySetting, ordinarySettings } from '@/lib/plugin-secrets/sealed';

/** Resolve a plugin from the persisted registry first, then PLUGIN_DEV_DIR. */
async function resolvePlugin(id: string) {
  const registered = await getPlugin(id);
  if (registered) return registered;
  const dev = await getDevPlugin(id);
  return dev?.plugin ?? null;
}

/**
 * GET /api/admin/plugins/[id]/config - Read plugin config
 *
 * - Admin sessions receive every field, including those declared
 *   `type: 'secret'` in the plugin's configSchema.
 * - Authenticated mailbox users (the plugin running in their browser)
 *   receive only non-secret fields.
 * - A value that was stored as a secret is never among the non-secret
 *   fields, whatever the installed version declares for its key; the
 *   setting then reads as unset until an admin enters a new value.
 * - Anonymous callers are rejected so unauthenticated visitors cannot
 *   enumerate plugin secrets.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      return NextResponse.json({ error: 'Invalid plugin ID' }, { status: 400 });
    }

    // ?public=1: only the fields any signed-in user may see, even for an
    // admin. The plugin API uses it so a plugin never gets secrets just
    // because the user is also signed in to the admin dashboard.
    const publicOnly = request.nextUrl.searchParams.get('public') === '1';
    const adminAuth = await requireAdminAuth(request);
    const isAdmin = !publicOnly && !('error' in adminAuth);

    if (!isAdmin) {
      const creds = await getStalwartCredentials(request);
      if (!creds) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      }
    }

    const plugin = await resolvePlugin(id);
    if (!plugin) {
      return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }

    const config = await getPluginConfig(id);

    // A value stored as a secret stays one whatever the installed version
    // declares for its key: users never get it, and the admin's page only
    // while the field is still a secret (lib/plugin-secrets/sealed.ts).
    const response = isAdmin
      ? adminSettings(config, plugin.configSchema)
      : ordinarySettings(config, plugin.configSchema);

    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const unavailable = storeUnavailableResponse(error);
    if (unavailable) return unavailable;
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PUT /api/admin/plugins/[id]/config - Set a config key
 *
 * Body: { key: string, value: unknown }
 * Requires admin authentication (checked via admin session).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const { id } = await params;

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      return NextResponse.json({ error: 'Invalid plugin ID' }, { status: 400 });
    }

    const plugin = await resolvePlugin(id);
    if (!plugin) {
      return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }

    let body: { key?: string; value?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (!body.key || typeof body.key !== 'string') {
      return NextResponse.json({ error: 'key is required and must be a string' }, { status: 400 });
    }

    // Validate key format (alphanumeric, hyphens, underscores, dots)
    if (!/^[a-zA-Z0-9._-]+$/.test(body.key)) {
      return NextResponse.json({ error: 'Invalid key format' }, { status: 400 });
    }

    if (plugin.configSchema && !plugin.configSchema[body.key]) {
      return NextResponse.json(
        { error: 'Key is not declared in the plugin configSchema' },
        { status: 400 },
      );
    }

    // Stored with how the field is declared now: plain only into a field of
    // an ordinary kind, a secret otherwise, and it stays what it was stored as
    // when a later version declares the key differently.
    const kind = isOrdinarySetting(declarationOf(plugin.configSchema, body.key)) ? 'plain' : 'secret';
    await setPluginConfig(id, body.key, body.value, kind);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/plugins/[id]/config - Delete a config key
 *
 * Body: { key: string }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const { id } = await params;

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      return NextResponse.json({ error: 'Invalid plugin ID' }, { status: 400 });
    }

    let body: { key?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    if (!body.key || typeof body.key !== 'string') {
      return NextResponse.json({ error: 'key is required' }, { status: 400 });
    }

    await deletePluginConfigKey(id, body.key);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
