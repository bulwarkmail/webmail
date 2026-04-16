import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logger } from '@/lib/logger';
import { decryptSession } from '@/lib/auth/crypto';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { saveUserSettings, loadUserSettings, deleteUserSettings } from '@/lib/settings-sync';
import { configManager } from '@/lib/admin/config-manager';
import { readFileEnv } from '@/lib/read-file-env';

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
  return process.env.SETTINGS_SYNC_ENABLED === 'true' && (!!process.env.SESSION_SECRET || !!readFileEnv(process.env.SESSION_SECRET_FILE));
}

/** Strip trailing slashes so differently-formatted URLs still match. */
function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Verify identity against session cookies across all account slots.
 * With multi-account, the requesting account may be on any slot (0-4).
 * Checks both basic-auth session cookies and stalwart auth context cookies
 * (used by OAuth/SSO and TOTP-upgraded sessions).
 * Returns true only if a matching cookie is found.
 */
async function verifyIdentity(username: string, serverUrl: string): Promise<boolean> {
  const cookieStore = await cookies();
  const normalizedServerUrl = normalizeUrl(serverUrl);

  for (let slot = 0; slot <= 4; slot++) {
    // Check basic-auth session cookie
    const token = cookieStore.get(sessionCookieName(slot))?.value;
    if (token) {
      const session = decryptSession(token);
      if (session && session.username === username && normalizeUrl(session.serverUrl) === normalizedServerUrl) {
        return true;
      }
    }

    // Check stalwart auth context cookie (set for all auth modes)
    const ctx = readStalwartAuthContextFromStore(cookieStore, slot);
    if (ctx && ctx.username === username && normalizeUrl(ctx.serverUrl) === normalizedServerUrl) {
      return true;
    }
  }

  // No matching session found (or no cookies at all) → reject
  return false;
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

  if (!(await verifyIdentity(username, serverUrl))) {
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

    if (!(await verifyIdentity(username, serverUrl))) {
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

    if (!(await verifyIdentity(username, serverUrl))) {
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
