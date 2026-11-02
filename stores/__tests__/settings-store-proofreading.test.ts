import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import { useSettingsStore } from '../settings-store';
import { usePolicyStore } from '../policy-store';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { checkerAccess } from '@/lib/proofreading/gate';
import { currentPolicyView } from '@/components/email/proofreading/use-proofreading';

// Proofreading's settings: synced like the others, cleaned when they come in,
// and an admin lock wins over an old synced value or one set from the console.

const settings = () => useSettingsStore.getState();
const loadPolicy = (patch: Partial<SettingsPolicy>) =>
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, ...patch }, loaded: true, partial: false, subjectPending: false });

beforeEach(() => {
  localStorage.clear();
  apiFetch.mockReset();
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, loaded: false });
  settings().disableSync();
  settings().resetToDefaults();
});

describe('proofreading settings', () => {
  it('starts off, with automatic language detection', () => {
    expect(settings().proofreading).toBe(false);
    expect(settings().writingLanguage).toBe('auto');
    expect(settings().proofreadingPlugins).toEqual({});
  });

  it('drops odd values from an import', () => {
    settings().importSettings(JSON.stringify({
      proofreading: true,
      proofreadingPlugins: { lt: true, ai: 'yes', __proto__: { x: true } },
      writingLanguage: '<script>',
    }));
    expect(settings().proofreading).toBe(true);
    expect(settings().proofreadingPlugins).toEqual({ lt: true });
    expect(settings().writingLanguage).toBe('auto');
    settings().importSettings(JSON.stringify({ writingLanguage: 'de-CH' }));
    expect(settings().writingLanguage).toBe('de-CH');
  });

  it('a lock on puts the setting back after an old synced "off", and the checker stays on', () => {
    loadPolicy({ restrictions: { proofreading: { locked: true, value: true } } });
    expect(settings().proofreading).toBe(true);
    settings().importSettings(JSON.stringify({ proofreading: false, proofreadingPlugins: { lt: false } }));
    expect(settings().proofreading).toBe(true);
    // Even a value forced from the console doesn't turn the checker off.
    useSettingsStore.setState({ proofreading: false, proofreadingPlugins: { lt: false } });
    expect(checkerAccess(currentPolicyView(), settings(), 'lt')).toMatchObject({ on: true, forced: true });
  });

  it('a lock off keeps every checker off, whatever is stored', () => {
    loadPolicy({ restrictions: { proofreading: { locked: true, value: false, hidden: true } } });
    useSettingsStore.setState({ proofreading: true, proofreadingPlugins: { lt: true } });
    expect(checkerAccess(currentPolicyView(), settings(), 'lt').on).toBe(false);
  });

  it('checks nothing until the policy has loaded', () => {
    useSettingsStore.setState({ proofreading: true });
    usePolicyStore.setState({ loaded: false });
    expect(checkerAccess(currentPolicyView(), settings(), 'lt').on).toBe(false);
    usePolicyStore.setState({ loaded: true, partial: true });
    expect(checkerAccess(currentPolicyView(), settings(), 'lt').on).toBe(false);
    usePolicyStore.setState({ partial: false, subjectPending: true });
    expect(checkerAccess(currentPolicyView(), settings(), 'lt').on).toBe(false);
    usePolicyStore.setState({ subjectPending: false });
    expect(checkerAccess(currentPolicyView(), settings(), 'lt').on).toBe(true);
  });
});
