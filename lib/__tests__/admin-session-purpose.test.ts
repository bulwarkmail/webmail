/**
 * @vitest-environment node
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminSession, verifyAdminSession } from '@/lib/admin/session';
import { saveUserSettings } from '@/lib/settings-sync';

// Synced settings are encrypted with the same key and layout as the admin
// session, and any signed-in user chooses their content. A settings file
// holding {"role":"admin","exp":...} must not open the admin dashboard to
// whoever gets hold of that file.
describe('admin session token purpose', () => {
  let settingsDir: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(path.join(tmpdir(), 'bw-admin-purpose-'));
    vi.stubEnv('SESSION_SECRET', 'a'.repeat(64));
    vi.stubEnv('SETTINGS_DATA_DIR', settingsDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it('accepts its own tokens', () => {
    expect(verifyAdminSession(createAdminSession())?.role).toBe('admin');
  });

  it('refuses a synced settings blob shaped like a session', async () => {
    await saveUserSettings('user@example.org', 'https://mail.example.org', {
      role: 'admin',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const [file] = readdirSync(settingsDir).filter((name) => name.endsWith('.enc'));
    const blob = readFileSync(path.join(settingsDir, file!)).toString('base64');

    expect(verifyAdminSession(blob)).toBeNull();
  });
});
