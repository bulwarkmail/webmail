import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { logger } from '@/lib/logger';
import { storeUnavailableResponse } from '@/lib/admin/store-unavailable-response';
import { listHistory } from '@/lib/admin/extension-history';
import { getPlugin, getTheme } from '@/lib/admin/plugin-registry';
import { EXTENSION_ID_RE } from '@/lib/extension-package';

function parseKind(value: string): 'plugin' | 'theme' | null {
  return value === 'plugin' || value === 'theme' ? value : null;
}

/**
 * GET /api/admin/extensions/[kind]/[id]/history
 *
 * The versions of an installed plugin or theme this server still has a copy
 * of, newest replacement first, plus what is installed now. Each one can be
 * put back with POST .../rollback.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const { kind: rawKind, id } = await params;
    const kind = parseKind(rawKind);
    if (!kind) return NextResponse.json({ error: 'Unknown extension kind' }, { status: 400 });
    if (!EXTENSION_ID_RE.test(id)) return NextResponse.json({ error: 'Invalid extension id' }, { status: 400 });

    const current = kind === 'plugin' ? await getPlugin(id) : await getTheme(id);
    const history = await listHistory(kind, id);
    return NextResponse.json(
      {
        kind,
        id,
        current: current ? { version: current.version, updatedAt: current.updatedAt, source: current.source ?? null } : null,
        history,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const unavailable = storeUnavailableResponse(error);
    if (unavailable) return unavailable;
    logger.error('Extension history error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
