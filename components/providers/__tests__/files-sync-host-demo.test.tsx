/**
 * Files on this computer with the demo's client, which has no JMAP session: the host stays
 * out of its way and the page goes on showing mail. It used to call getSessionSnapshot on it
 * and take the whole app down before the mail list drew.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoJMAPClient } from '@/lib/demo/demo-client';
import { resetFilesControlsForTests } from '@/lib/files-sync/controls';
import { FakeDisk } from '@/lib/files-sync/__tests__/helpers/fake-disk';
import type { JMAPClient } from '@/lib/jmap/client';
import { useAuthStore } from '@/stores/auth-store';
import { useFilesSyncStore } from '@/stores/files-sync-store';
import { FilesSyncHost } from '../files-sync-host';

const initialAuth = useAuthStore.getState();

afterEach(() => {
  delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  resetFilesControlsForTests();
  useAuthStore.setState(initialAuth, true);
});

describe('the files sync host in the demo', () => {
  it('starts without the demo accounts and leaves the mail on screen', async () => {
    const controls = new FakeDisk();
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', files: { claim: () => controls } };
    const work = new DemoJMAPClient('work') as unknown as JMAPClient;
    const personal = new DemoJMAPClient('personal') as unknown as JMAPClient;
    useAuthStore.setState({
      isAuthenticated: true,
      isDemoMode: true,
      client: work,
      activeAccountId: 'demo-work',
      getAllConnectedClients: () => new Map([['demo-work', work], ['demo-personal', personal]]),
    });

    render(<><p>Inbox</p><FilesSyncHost /></>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

    expect(screen.getByText('Inbox')).toBeTruthy();
    // Running, for when a real account signs in, but with nothing of the demo's.
    expect(useFilesSyncStore.getState().controller).not.toBeNull();
    expect(useFilesSyncStore.getState().accounts).toEqual([]);
  });
});
