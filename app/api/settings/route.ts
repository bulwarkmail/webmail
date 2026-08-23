import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { saveUserSettings, loadUserSettings, deleteUserSettings } from '@/lib/settings-sync';
import { configManager } from '@/lib/admin/config-manager';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { verifyAccountIdentity } from '@/lib/auth/verify-account-identity';

function classifyError(error: unknown): { message: string; status: number } {
  const code = (error as NodeJS.ErrnoException).code;
  const msg = error instanceof Error ? error.message : 'Unknown error';

  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return {
        message: 'Write permission denied on settings data directory. Check filesystem permissions for the SETTINGS_DATA_DIR (or data/settings/).',
        status: 500,
      };
    case 'EROFS':
      return {
        message: 'Filesystem is read-only. Settings cannot be saved. Ensure the data directory is on a writable volume.',
        status: 500,
      };
    case 'ENOSPC':
      return {
        message: 'No disk space available to save settings.',
        status: 507,
      };
    case 'ENOENT':
      return {
        message: 'Settings data directory does not exist and could not be created. Check SETTINGS_DATA_DIR configuration.',
        status: 500,
      };
    default:
      if (msg.includes('SESSION_SECRET')) {
        return {
          message: 'Server configuration error: SESSION_SECRET is not set.',
          status: 500,
        };
      }
      return {
        message: `Internal server error: ${msg}`,
        status: 500,
      };
  }
}

function isEnabled(): boolean {
  const flagOn =
    process.env.SETTINGS_SYNC_ENABLED === 'true' ||
    configManager.get<boolean>('settingsSyncEnabled', false);
  return flagOn && hasSessionSecret();
}

export async function GET(request: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ error: 'Settings sync is disabled' }, { status: 404 });
  }

  const username = request.headers.get('x-settings-username');
  const serverUrl = request.headers.get('x-settings-server');
  if (!username || !serverUrl) {
    return NextResponse.json({ error: 'Missing identity headers' }, { status: 400 });
  }

  if (!(await verifyAccountIdentity(username, serverUrl))) {
    return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
  }

  try {
    const settings = await loadUserSettings(username, serverUrl);
    return NextResponse.json({ settings: settings || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const code = (error as NodeJS.ErrnoException).code;
    logger.error('Settings load error', { error: message, code });
    const classified = classifyError(error);
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}

export async function POST(request: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ error: 'Settings sync is disabled' }, { status: 404 });
  }

  try {
    const { username, serverUrl, settings } = await request.json();
    if (!username || !serverUrl || !settings) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return NextResponse.json({ error: 'Settings must be an object' }, { status: 400 });
    }

    if (!(await verifyAccountIdentity(username, serverUrl))) {
      return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
    }

    // Enforce admin policy - strip locked settings so users can't override them
    await configManager.ensureLoaded();
    const policy = configManager.getPolicy();
    const filteredSettings = { ...settings };
    for (const key of Object.keys(filteredSettings)) {
      const restriction = policy.restrictions[key];
      if (!restriction) continue;
      if (restriction.locked) {
        delete filteredSettings[key];
        continue;
      }
      const value = filteredSettings[key];
      if (restriction.allowedValues && restriction.allowedValues.length > 0) {
        if (!restriction.allowedValues.includes(value)) {
          delete filteredSettings[key];
        }
      }
      if (typeof value === 'number') {
        if (restriction.min !== undefined && value < restriction.min) {
          delete filteredSettings[key];
        }
        if (restriction.max !== undefined && value > restriction.max) {
          delete filteredSettings[key];
        }
      }
    }

    await saveUserSettings(username, serverUrl, filteredSettings);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const code = (error as NodeJS.ErrnoException).code;
    logger.error('Settings save error', { error: message, code });
    const classified = classifyError(error);
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isEnabled()) {
    return NextResponse.json({ error: 'Settings sync is disabled' }, { status: 404 });
  }

  try {
    const { username, serverUrl } = await request.json();
    if (!username || !serverUrl) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!(await verifyAccountIdentity(username, serverUrl))) {
      return NextResponse.json({ error: 'Identity mismatch' }, { status: 403 });
    }

    await deleteUserSettings(username, serverUrl);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const code = (error as NodeJS.ErrnoException).code;
    logger.error('Settings delete error', { error: message, code });
    const classified = classifyError(error);
    return NextResponse.json({ error: classified.message }, { status: classified.status });
  }
}
