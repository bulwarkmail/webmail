import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../settings-store';
import { usePolicyStore } from '../policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';

// #1342: compact shared mailboxes is the user's choice, off until the user or
// the admin's policy default turns it on.

const settings = () => useSettingsStore.getState();

beforeEach(() => {
  localStorage.clear();
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, loaded: false });
  settings().resetToDefaults();
});

describe('settings-store compactSharedMailboxes', () => {
  it('is off by default', () => {
    expect(settings().compactSharedMailboxes).toBe(false);
  });

  it('is synced', () => {
    settings().updateSetting('compactSharedMailboxes', true);
    expect(JSON.parse(settings().exportSettings()).compactSharedMailboxes).toBe(true);

    settings().importSettings(JSON.stringify({ compactSharedMailboxes: false }));
    expect(settings().compactSharedMailboxes).toBe(false);
  });

  it('takes the admin\'s default', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, defaults: { compactSharedMailboxes: true } }, loaded: true });
    expect(settings().compactSharedMailboxes).toBe(true);
  });
});
