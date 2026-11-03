import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type SettingsPolicy } from '../types';
import { ALL_DEVICE_LIMITS, strictestOfAllScopes } from '../server-device-policy';
import { sanitizeOrganisationPartial } from '../organisation-policy';

// The offline caps are numbers in a section that used to hold only booleans.

const scope = (id: string, devices: Record<string, unknown>) => ({ id, label: id, match: { domains: [`${id}.example.org`] }, policy: { organisation: { devices } } });

describe('wipeOnForcedSignOut', () => {
  it('is off unless asked for, and survives the sanitizer', () => {
    expect(DEFAULT_POLICY.organisation?.devices?.wipeOnForcedSignOut ?? false).toBe(false);
    expect(sanitizeOrganisationPartial({ devices: { wipeOnForcedSignOut: true } }).devices).toMatchObject({ wipeOnForcedSignOut: true });
    expect(sanitizeOrganisationPartial({ devices: { wipeOnForcedSignOut: 'yes' } }).devices?.wipeOnForcedSignOut).not.toBe(true);
  });

  it('isn\'t set by the stand-in for a login nobody can read: that\'s for what stays on the server', () => {
    expect(ALL_DEVICE_LIMITS.wipeOnForcedSignOut).toBe(false);
  });
});

describe('strictest of all scopes', () => {
  it('keeps the lowest cap, and a boolean switch still turns on', () => {
    const policy = {
      ...DEFAULT_POLICY,
      organisation: { devices: { offlineMaxDays: 90 } },
      scopes: [scope('a', { offlineMaxDays: 30, offlineMaxTotalMb: 500 }), scope('b', { offlineMaxDays: 60, noPrint: true })],
    } as unknown as SettingsPolicy;
    expect(strictestOfAllScopes(policy)).toMatchObject({ offlineMaxDays: 30, offlineMaxTotalMb: 500, offlineMaxAttachmentMb: 0, noPrint: true, noExport: false });
  });

  it('a scope saying 0 does not lift a cap', () => {
    const policy = { ...DEFAULT_POLICY, organisation: { devices: { offlineMaxDays: 90 } }, scopes: [scope('a', { offlineMaxDays: 0 })] } as unknown as SettingsPolicy;
    expect(strictestOfAllScopes(policy).offlineMaxDays).toBe(90);
  });
});

describe('everything on', () => {
  it('holds booleans as true and caps as the lowest number', () => {
    expect(ALL_DEVICE_LIMITS).toMatchObject({ noOffline: true, noDownloads: true, noOfflineAttachments: true, offlineMaxDays: 1, offlineMaxAttachmentMb: 1, offlineMaxTotalMb: 1 });
  });
});
