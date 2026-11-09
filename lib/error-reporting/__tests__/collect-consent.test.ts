// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const consent = vi.hoisted(() => ({ value: 'off' as 'on' | 'off' | 'instant' }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, get: (_key: string, fallback: unknown) => fallback },
}));
vi.mock('@/lib/telemetry/state', () => ({
  effectiveErrorsConsent: async () => ({ consent: consent.value, source: 'file' }),
}));

import { shouldCollectErrors } from '../settings';

// Error counts in the heartbeat need errors counted on this server, so the
// consent alone turns collection on; with nothing set it stays off.
describe('error collection', () => {
  it('is off with no DSN, no metrics and no error-count consent', async () => {
    consent.value = 'off';
    expect(await shouldCollectErrors()).toBe(false);
  });

  it('is on with the error-count consent alone', async () => {
    consent.value = 'on';
    expect(await shouldCollectErrors()).toBe(true);
  });

  it('is on in instant mode too', async () => {
    consent.value = 'instant';
    expect(await shouldCollectErrors()).toBe(true);
  });
});
