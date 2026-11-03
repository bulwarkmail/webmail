import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth-store';
import { TITLE_UNTIL_LOADED, useProTabStore, type ProTab } from '@/stores/pro-tab-store';
import { useRestoredTabTitles } from '../use-restored-tab-titles';

const stored = (id: string, title = TITLE_UNTIL_LOADED): ProTab => ({
  id, kind: 'email', labelKey: '', title, closeable: true, paneId: 'main',
  emailData: { accountId: 'j', emailId: `m-${id}`, mailboxId: null, title },
});

const getEmail = vi.fn(async (id: string) => ({ subject: id === 'm-empty' ? '' : `Subject of ${id}` }));

function current(id: string) {
  return useProTabStore.getState().tabs.find((tab) => tab.id === id);
}

beforeEach(() => {
  getEmail.mockClear();
  useAuthStore.setState({ client: { getEmail } as never });
});

describe('tabs restored without their subjects', () => {
  it('get them back without being opened, also an empty one', async () => {
    const tabs = [stored('a'), stored('empty'), stored('known', 'Known')];
    useProTabStore.setState({ tabs });
    renderHook(() => useRestoredTabTitles(tabs));
    await waitFor(() => expect(current('a')?.title).toBe('Subject of m-a'));
    expect(current('a')?.emailData?.title).toBe('Subject of m-a');
    await waitFor(() => expect(current('empty')?.title).toBe('no_subject'));
    expect(getEmail).toHaveBeenCalledTimes(2);
  });

  it('wait for a client, and keep their mark if the message can\'t be read', async () => {
    const tabs = [stored('a')];
    useProTabStore.setState({ tabs });
    useAuthStore.setState({ client: null });
    const { rerender } = renderHook(() => useRestoredTabTitles(tabs));
    expect(getEmail).not.toHaveBeenCalled();
    getEmail.mockRejectedValueOnce(new Error('offline'));
    useAuthStore.setState({ client: { getEmail } as never });
    rerender();
    await waitFor(() => expect(getEmail).toHaveBeenCalled());
    expect(current('a')?.title).toBe(TITLE_UNTIL_LOADED);
  });
});
