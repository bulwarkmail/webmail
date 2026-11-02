import { NextRequest, NextResponse } from 'next/server';
import { writeFile } from 'node:fs/promises';
import { detectSetupState } from '@/lib/setup/state';
import { wizardSessionRefusal, SETUP_COOKIE } from '@/lib/setup/session';
import { configWriteErrorResponse } from '@/lib/admin/config-read-only-response';
import { configManager } from '@/lib/admin/config-manager';
import { setInitialAdminPassword } from '@/lib/admin/password';
import { clearSetupToken } from '@/lib/setup/token';
import { ensureConfigDir, getConfigPath } from '@/lib/admin/paths';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { isSharedMode } from '@/lib/shared-store';
import { adminConfigDocs } from '@/lib/admin/admin-store';

export const dynamic = 'force-dynamic';

/**
 * POST /api/setup/finish
 *
 * Final wizard step. Validates that required config is in place, hashes the
 * admin password, marks setup complete, deletes the setup token (which
 * invalidates the wizard cookie), and optionally drops a `.config-locked`
 * marker so the operator remembers they intended to mount :ro.
 *
 * Body: { adminPassword: string, lockConfig?: boolean }
 */
export async function POST(request: NextRequest) {
  if (detectSetupState() !== 'bootstrap') {
    return NextResponse.json({ error: 'Setup is not active' }, { status: 404 });
  }
  const wizardRefused = await wizardSessionRefusal();
  if (wizardRefused) return wizardRefused;

  let body: { adminPassword?: unknown; lockConfig?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const adminPassword =
    typeof body?.adminPassword === 'string' ? body.adminPassword : '';
  if (adminPassword.length < 8) {
    return NextResponse.json(
      { error: 'Admin password must be at least 8 characters' },
      { status: 400 },
    );
  }

  const lockConfig = body?.lockConfig === true;

  // Validate required config is present.
  await configManager.ensureLoaded();
  const jmapUrl = configManager.get<string>('jmapServerUrl', '');
  if (!jmapUrl || typeof jmapUrl !== 'string') {
    return NextResponse.json(
      { error: 'JMAP server URL is required (run the Server step first)' },
      { status: 400 },
    );
  }

  try {
    // 1. Provision the admin account. An admin.json file may already exist
    //    from a previous ADMIN_PASSWORD env var or an aborted earlier wizard
    //    run while setupComplete is still false - accept the wizard's
    //    password as authoritative in that case. The finish route is gated
    //    by the bootstrap state + one-time setup token, so this is safe.
    const created = await setInitialAdminPassword(adminPassword, { allowOverwrite: true });
    if (!created) {
      return NextResponse.json(
        { error: 'Failed to write admin credentials' },
        { status: 500 },
      );
    }

    // 2. Persist setupComplete flag. After this, detectSetupState() flips
    //    to 'configured' and middleware starts 404'ing /setup paths.
    await configManager.markSetupComplete();

    // 3. Optional advisory lock marker.
    if (lockConfig) {
      if (isSharedMode()) {
        await adminConfigDocs().put('.config-locked', new Date().toISOString());
      } else {
        await ensureConfigDir();
        await writeFile(
          getConfigPath('.config-locked'),
          new Date().toISOString(),
          'utf-8',
        );
      }
    }

    // 4. Destroy the setup token. Any other browser holding the cookie is
    //    now unauthenticated.
    await clearSetupToken();

    await auditLog(
      'setup.finish',
      { lockConfig, jmapServerUrl: jmapUrl },
      request.headers.get('x-forwarded-for') ?? 'unknown',
    );

    const response = NextResponse.json({ ok: true, lockConfig });
    response.cookies.delete(SETUP_COOKIE);
    return response;
  } catch (error) {
    const refused = configWriteErrorResponse(error);
    if (refused) return refused;
    logger.error('Wizard finish failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json(
      { error: 'Failed to finish setup', detail: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}
