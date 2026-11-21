import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountStore } from '@/stores/account-store';
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
  // One login, signed in: tabs stored without a login are its tabs.
  useAccountStore.setState({ accounts: [] });
  useAuthStore.setState({ client: { getEmail } as never, activeAccountId: 'login-a' });
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

  // Ids repeat across logins: a tab that names its login is read through
  // that login only, and one that names none is read only where a single
  // login can own it.
  describe('with two logins signed in', () => {
    const other = vi.fn(async (id: string) => ({ subject: `Other login's ${id}` }));
    const entry = (id: string) => ({ id, label: id, email: id, username: id, serverUrl: 'https://mail.example', isConnected: true }) as never;

    beforeEach(() => {
      other.mockClear();
      useAccountStore.setState({ accounts: [entry('login-a'), entry('login-b')] });
      useAuthStore.setState({
        getClientForAccount: ((id: string) => (id === 'login-a' ? { getEmail } : id === 'login-b' ? { getEmail: other } : undefined)) as never,
      });
    });
    afterEach(() => {
      useAccountStore.setState({ accounts: [] });
      useAuthStore.setState({ getClientForAccount: (() => undefined) as never });
    });

    it('a tab that names its login gets its subject from that login', async () => {
      const tab = stored('a');
      tab.emailData!.clientAccountId = 'login-b';
      useProTabStore.setState({ tabs: [tab] });
      renderHook(() => useRestoredTabTitles([tab]));
      await waitFor(() => expect(current('a')?.title).toBe("Other login's m-a"));
      expect(getEmail).not.toHaveBeenCalled();
    });

    it('a tab that names none is not read through the active login', async () => {
      const tabs = [stored('a')];
      useProTabStore.setState({ tabs });
      renderHook(() => useRestoredTabTitles(tabs));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getEmail).not.toHaveBeenCalled();
      expect(other).not.toHaveBeenCalled();
      expect(current('a')?.title).toBe(TITLE_UNTIL_LOADED);
    });
  });
});
