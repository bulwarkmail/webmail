/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The wizard lets the operator paste their own session secret. Every place
// that uses it (admin sign-in, remember me) refuses one shorter than 32
// characters, so a short one saved here made the admin sign-in answer 500
// right after setup, with no way back in short of editing config.json.

const setAdminConfig = vi.hoisted(() => vi.fn(async (_updates: Record<string, unknown>) => {}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: () => 'bootstrap' }));
vi.mock('@/lib/setup/session', () => ({ authenticateWizardRequest: async () => true }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, setAdminConfig },
}));
vi.mock('@/lib/telemetry', () => ({
  effectiveConsent: async () => ({ source: 'env' }),
  loadState: async () => ({}),
  saveState: async () => {},
  reschedule: async () => {},
}));

import { POST } from '../step/route';

function step(values: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/setup/step', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ step: 'security', values }),
  }));
}

describe('POST /api/setup/step (security)', () => {
  beforeEach(() => setAdminConfig.mockClear());

  it('refuses a session secret shorter than 32 characters', async () => {
    const res = await step({ sessionSecret: 'too-short', settingsSyncEnabled: true });
    expect(res.status).toBe(400);
    expect(setAdminConfig).not.toHaveBeenCalled();
  });

  it('saves a generated one', async () => {
    const secret = Buffer.alloc(32, 7).toString('base64');
    const res = await step({ sessionSecret: secret, settingsSyncEnabled: true });
    expect(res.status).toBe(200);
    expect(setAdminConfig).toHaveBeenCalledWith({ sessionSecret: secret, settingsSyncEnabled: true });
  });
});
