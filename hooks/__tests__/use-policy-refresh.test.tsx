import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLICY_REFRESH_MS, resetPolicyRefresh, usePolicyRefresh } from '@/hooks/use-policy-refresh';
import { usePolicyStore } from '@/stores/policy-store';

describe('usePolicyRefresh', () => {
  const fetchPolicy = vi.fn(async () => {});
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    resetPolicyRefresh();
    fetchPolicy.mockClear();
    usePolicyStore.setState({ loaded: true, fetching: false, fetchPolicy });
  });
  afterEach(() => vi.useRealTimers());

  it('fetches the policy every 15 minutes while the tab is visible', () => {
    const { unmount } = renderHook(() => usePolicyRefresh());
    expect(fetchPolicy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(POLICY_REFRESH_MS);
    expect(fetchPolicy).toHaveBeenCalledTimes(1);
    unmount();
    vi.advanceTimersByTime(POLICY_REFRESH_MS);
    expect(fetchPolicy).toHaveBeenCalledTimes(1);
  });

  it('fetches when the tab comes back, at most once a minute', () => {
    renderHook(() => usePolicyRefresh());
    vi.advanceTimersByTime(2 * 60 * 1000);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(fetchPolicy).toHaveBeenCalledTimes(1);
  });

  it('shares one timer between several banners', () => {
    renderHook(() => usePolicyRefresh());
    renderHook(() => usePolicyRefresh());
    vi.advanceTimersByTime(POLICY_REFRESH_MS);
    expect(fetchPolicy).toHaveBeenCalledTimes(1);
  });
});
