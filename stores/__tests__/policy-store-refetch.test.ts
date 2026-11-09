import { beforeEach, describe, expect, it, vi } from 'vitest';

// Open tabs fetch the policy again every 15 minutes (hooks/use-policy-refresh.ts).
// A refetch that brings nothing new keeps the resolved objects, so the
// components and effects that read the policy don't run again; a changed
// policy lands as before.

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: fetchMock }));

import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';

const withText = (text: string) => ({
  ...DEFAULT_POLICY,
  organisation: { announcement: { id: 'a', text: { en: text } } },
});
const ok = (policy: object) => new Response(JSON.stringify(policy));

beforeEach(() => {
  fetchMock.mockReset();
  localStorage.clear();
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, rawPolicy: { ...DEFAULT_POLICY }, loaded: false, fetching: false, source: 'none', partial: false });
});

describe('policy refetch', () => {
  it('keeps the same policy object when nothing changed', async () => {
    fetchMock.mockResolvedValueOnce(ok(withText('one')));
    await usePolicyStore.getState().fetchPolicy();
    const first = usePolicyStore.getState().policy;

    fetchMock.mockResolvedValueOnce(ok(withText('one')));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().policy).toBe(first);
  });

  it('takes a changed policy', async () => {
    fetchMock.mockResolvedValueOnce(ok(withText('one')));
    await usePolicyStore.getState().fetchPolicy();

    fetchMock.mockResolvedValueOnce(ok(withText('two')));
    await usePolicyStore.getState().fetchPolicy();
    expect(usePolicyStore.getState().policy.organisation?.announcement.text).toEqual({ en: 'two' });
  });
});
