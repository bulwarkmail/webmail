import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { DEFAULT_SCOPE } from '@/lib/store/area';
import {
  attachmentCapOptions,
  effectiveScope,
  LEGACY_CHOICE,
  offlineDefaultOn,
  olderThanCap,
  platformDefault,
  userChoiceFor,
  windowOptions,
} from '../scope';
import { offlineScopeFor, useOfflineStore } from '../state';

const NO_LIMITS = DEFAULT_ORGANISATION_POLICY.devices;
const MB = 1024 * 1024;
const BROWSER = { on: false, scope: DEFAULT_SCOPE };
const DESKTOP = { on: true, scope: DEFAULT_SCOPE };

describe('effectiveScope', () => {
  it('the default when nothing else says', () => {
    expect(effectiveScope('a', null, NO_LIMITS, BROWSER)).toMatchObject({ account: 'a', enabled: false, scope: DEFAULT_SCOPE });
    expect(effectiveScope('a', null, NO_LIMITS, DESKTOP).enabled).toBe(true);
  });

  it('the user over the default', () => {
    const effective = effectiveScope('a', { on: true, days: 30, attachments: false, maxAttachmentBytes: 5 * MB }, NO_LIMITS, BROWSER);
    expect(effective.enabled).toBe(true);
    expect(effective.scope).toEqual({ ...DEFAULT_SCOPE, days: 30, attachments: false, maxAttachmentBytes: 5 * MB, orgMaxFileBytes: null });
    expect(effectiveScope('a', { on: false }, NO_LIMITS, DESKTOP).enabled).toBe(false);
    expect(effectiveScope('a', { days: null }, NO_LIMITS, BROWSER).scope.days).toBeNull();
  });

  it('the organisation over the user and over the desktop default', () => {
    const policy = { ...NO_LIMITS, noOffline: true };
    expect(effectiveScope('a', { on: true }, policy, BROWSER).enabled).toBe(false);
    expect(effectiveScope('a', null, policy, DESKTOP).enabled).toBe(false);
    expect(effectiveScope('a', { on: true }, policy, DESKTOP).locked.offline).toBe(true);
  });

  it('a cap lowers the choice and the default, also "everything", and never raises', () => {
    const policy = { ...NO_LIMITS, offlineMaxDays: 60, offlineMaxAttachmentMb: 10, offlineMaxTotalMb: 100 };
    const capped = effectiveScope('a', { days: null, maxAttachmentBytes: 500 * MB }, policy, DESKTOP);
    expect(capped.scope).toMatchObject({ days: 60, attachments: true, maxAttachmentBytes: 10 * MB, maxTotalBytes: 100 * MB });
    expect(capped.locked).toMatchObject({ days: true, maxAttachment: true, maxTotal: true, attachments: false });
    // Sent on its own: a pin obeys this one, not the user's size.
    expect(capped.scope.orgMaxFileBytes).toBe(10 * MB);
    expect(effectiveScope('a', { maxAttachmentBytes: 5 * MB }, NO_LIMITS, BROWSER).scope.orgMaxFileBytes).toBeNull();
    expect(effectiveScope('a', null, { ...policy, offlineMaxDays: 30 }, DESKTOP).scope.days).toBe(30);
    const under = effectiveScope('a', { days: 30, maxAttachmentBytes: 5 * MB }, policy, BROWSER);
    expect(under.scope.days).toBe(30);
    expect(under.scope.maxAttachmentBytes).toBe(5 * MB);
  });

  it('forbidden attachments stay off whatever the user chose', () => {
    const effective = effectiveScope('a', { attachments: true }, { ...NO_LIMITS, noOfflineAttachments: true }, DESKTOP);
    expect(effective.scope.attachments).toBe(false);
    expect(effective.locked.attachments).toBe(true);
  });
});

describe('the platform default', () => {
  afterEach(() => { delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop; });

  it('is off in a browser and on with the desktop bridge', () => {
    expect(offlineDefaultOn()).toBe(false);
    expect(platformDefault().on).toBe(false);
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1 };
    expect(offlineDefaultOn()).toBe(true);
    expect(platformDefault().on).toBe(true);
  });
});

describe('the OfflineEnabled policy of the desktop app', () => {
  const withPolicy = (OfflineEnabled: unknown) => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, policy: { get: () => ({ OfflineEnabled }) } };
  };
  afterEach(() => { delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop; });

  it('recommended off changes the default, and a user can still turn it on', () => {
    withPolicy({ value: false, locked: false, source: 'machine' });
    expect(offlineDefaultOn()).toBe(false);
    expect(effectiveScope('a', null, NO_LIMITS, platformDefault()).enabled).toBe(false);
    expect(effectiveScope('a', { on: true }, NO_LIMITS, platformDefault()).enabled).toBe(true);
  });

  it('the shipped default is no recommendation', () => {
    withPolicy({ value: false, locked: false, source: 'default' });
    expect(offlineDefaultOn()).toBe(true);
  });

  it('forced beats what the user chose, either way', () => {
    withPolicy({ value: true, locked: true, source: 'machine' });
    expect(effectiveScope('a', { on: false }, NO_LIMITS, platformDefault())).toMatchObject({ enabled: true, locked: { forced: true } });
    withPolicy({ value: false, locked: true, source: 'machine' });
    expect(effectiveScope('a', { on: true }, NO_LIMITS, platformDefault()).enabled).toBe(false);
  });

  it('the organisation still beats it', () => {
    withPolicy({ value: true, locked: true, source: 'machine' });
    expect(effectiveScope('a', null, { ...NO_LIMITS, noOffline: true }, platformDefault()).enabled).toBe(false);
  });

  it('a shell without the member, or a member that throws, is the plain default', () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1 };
    expect(offlineDefaultOn()).toBe(true);
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, policy: { get: () => { throw new Error('gone'); } } };
    expect(platformDefault()).toMatchObject({ on: true, forced: null });
  });
});

describe('the seam for what a user chose', () => {
  it('reads bulwark-offline-scope over the defaults, without the switch', () => {
    localStorage.setItem('bulwark-offline-scope', JSON.stringify({ acc: { on: true, days: 30 } }));
    expect(offlineScopeFor('acc')).toEqual({ ...DEFAULT_SCOPE, days: 30 });
    expect(offlineScopeFor('other')).toEqual(DEFAULT_SCOPE);
    localStorage.removeItem('bulwark-offline-scope');
  });
});

describe('what the user chose', () => {
  beforeEach(() => useOfflineStore.setState({ enabled: [], choices: {} }));

  it('nothing for an account that never had it on', () => {
    expect(userChoiceFor('a')).toBeNull();
  });

  it('an account on from before the local store keeps the 30 days it had', () => {
    useOfflineStore.setState({ enabled: ['a'] });
    expect(userChoiceFor('a')).toEqual(LEGACY_CHOICE);
    expect(LEGACY_CHOICE.days).toBe(30);
    expect(effectiveScope('a', userChoiceFor('a'), NO_LIMITS, BROWSER).scope.days).toBe(30);
  });

  it('a stored choice wins', () => {
    useOfflineStore.setState({ enabled: ['a'], choices: { a: { on: true, days: 365 } } });
    expect(userChoiceFor('a')?.days).toBe(365);
  });
});

describe('what the page offers', () => {
  it('every window without a cap', () => {
    expect(windowOptions(0)).toEqual([30, 90, 365, null]);
  });

  it('what fits under a cap, and the cap itself', () => {
    expect(windowOptions(90)).toEqual([30, 90]);
    expect(windowOptions(60)).toEqual([30, 60]);
    expect(windowOptions(7)).toEqual([7]);
    expect(attachmentCapOptions(0)).toEqual([5, 25, 100, 500]);
    expect(attachmentCapOptions(10)).toEqual([5, 10]);
  });
});

describe('Lite', () => {
  it('reads the caps from the same policy.json', async () => {
    const { applyLitePolicy } = await import('@/lib/lite-config');
    const policy = applyLitePolicy({ organisation: { devices: { offlineMaxDays: 30, noOfflineAttachments: true, offlineMaxTotalMb: 'lots' } } } as never);
    expect(policy.organisation?.devices).toMatchObject({ offlineMaxDays: 30, noOfflineAttachments: true, offlineMaxTotalMb: 0 });
    // A cap is lower than anything, also where nothing else is known.
    expect(effectiveScope('a', { days: null }, policy.organisation!.devices, BROWSER).scope).toMatchObject({ days: 30, attachments: false });
  });

  it('has no store to apply them to, whatever a caller asks', async () => {
    vi.resetModules();
    vi.doMock('@/lib/lite', async (original) => ({ ...(await original<typeof import('@/lib/lite')>()), IS_LITE: true }));
    try {
      const { enableOffline, offlineSupported } = await import('../offline-mode');
      const { useOfflineStore: lite } = await import('../state');
      expect(offlineSupported()).toBe(false);
      await enableOffline('a');
      expect(lite.getState().enabled).toEqual([]);
    } finally {
      vi.doUnmock('@/lib/lite');
      vi.resetModules();
    }
  });
});

describe('olderThanCap', () => {
  const now = Date.UTC(2026, 10, 3);
  it('only with a cap, and only past it', () => {
    expect(olderThanCap('2026-01-01T00:00:00Z', 0, now)).toBe(false);
    expect(olderThanCap('2026-01-01T00:00:00Z', 30, now)).toBe(true);
    expect(olderThanCap('2026-10-30T00:00:00Z', 30, now)).toBe(false);
    expect(olderThanCap(undefined, 30, now)).toBe(false);
  });
});
