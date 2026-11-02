/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The wizard's telemetry choice used to load the whole state, change it and
// save it back, putting its copy over anything written meanwhile (the
// scheduler leader storing the next heartbeat, on this or another replica).
// It changes only the consent fields of what is stored now.

vi.mock('@/lib/setup/state', () => ({ detectSetupState: () => 'bootstrap' }));
vi.mock('@/lib/setup/session', () => ({ authenticateWizardRequest: async () => true, wizardSessionRefusal: async () => null }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, setAdminConfig: async () => {} },
}));
const stored = vi.hoisted(() => ({ consent: 'off', consentedAt: null as string | null, nextScheduledAt: 'kept' }));
vi.mock('@/lib/telemetry', () => ({
  effectiveConsent: async () => ({ source: 'file' }),
  loadState: async () => { throw new Error('read-modify-write of the whole state'); },
  saveState: async () => { throw new Error('read-modify-write of the whole state'); },
  updateState: async (change: (s: typeof stored) => void) => { change(stored); return stored; },
  reschedule: async () => {},
}));

import { POST } from '../step/route';

describe('POST /api/setup/step (security, telemetry)', () => {
  it('turns consent on against the stored state', async () => {
    const res = await POST(new NextRequest('http://localhost/api/setup/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: 'security', values: { telemetryConsent: 'on' } }),
    }));
    expect(res.status).toBe(200);
    expect(stored).toMatchObject({ consent: 'on', nextScheduledAt: 'kept' });
    expect(stored.consentedAt).not.toBeNull();
  });
});
