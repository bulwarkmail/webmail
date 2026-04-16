import { NextRequest, NextResponse } from 'next/server';
import { getPlugin } from '@/lib/admin/plugin-registry';
import { getPluginConfig, setPluginConfig, deletePluginConfigKey } from '@/lib/admin/plugin-config';
import { requireAdminAuth } from '@/lib/admin/session';

/**
 * GET /api/admin/plugins/[id]/config - Read all config for a plugin
 *
 * Returns the full config object for admin-configured plugin settings.
 * This endpoint is accessible from the client-side plugin API.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      return NextResponse.json({ error: 'Invalid plugin ID' }, { status: 400 });
    }

    const plugin = await getPlugin(id);
    if (!plugin) {
      return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }

    const config = await getPluginConfig(id);
    return NextResponse.json(config, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
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
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const { id } = await params;

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      return NextResponse.json({ error: 'Invalid plugin ID' }, { status: 400 });
    }

    const plugin = await getPlugin(id);
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

    await setPluginConfig(id, body.key, body.value);
    return NextResponse.json({ ok: true });
  } catch {
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
    const result = await requireAdminAuth();
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
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
