import 'fake-indexeddb/auto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { useOfflineStore } from '@/lib/offline/state';
import { setStoreBackend, type StoreBackend } from '@/lib/store/client/api';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useToastStore } from '@/stores/toast-store';
import { useKeepFileOffline } from '../use-keep-file-offline';

const FILE = { id: 'f1' };
const client = { getAccountId: () => 'j' } as never;
const area = vi.fn(async (_account: string, _name: string, _params?: unknown): Promise<unknown> => ({ files: [] }));

function setDevices(devices: Partial<typeof DEFAULT_ORGANISATION_POLICY.devices>) {
  usePolicyStore.setState({
    loaded: true, source: 'server', subject: { email: 'a@example.org', groups: [] },
    policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, ...devices } } },
  } as never);
}

beforeEach(() => {
  area.mockClear();
  area.mockImplementation(async () => ({ files: [] }));
  setStoreBackend({ supported: () => true, area } as unknown as StoreBackend);
  useAuthStore.setState({ activeAccountId: 'acc' });
  useOfflineStore.setState({ enabled: ['acc'], choices: { acc: { on: true } } });
  useToastStore.setState({ toasts: [] } as never);
  setDevices({});
});

afterEach(() => { setStoreBackend(null); });

describe('Keep offline in the Files app', () => {
  it('is offered for a plain file, not for a folder', () => {
    const { result } = renderHook(() => useKeepFileOffline(client));
    expect(result.current.canKeepOffline(FILE)).toBe(true);
    expect(result.current.canKeepOffline({ ...FILE, isDirectory: true })).toBe(false);
  });

  it('isn\'t offered when the organisation forbids keeping files', () => {
    setDevices({ noOfflineAttachments: true });
    const { result } = renderHook(() => useKeepFileOffline(client));
    expect(result.current.canKeepOffline(FILE)).toBe(false);
  });

  it('isn\'t offered when the user keeps no attachments', () => {
    useOfflineStore.setState({ choices: { acc: { on: true, attachments: false } } });
    const { result } = renderHook(() => useKeepFileOffline(client));
    expect(result.current.canKeepOffline(FILE)).toBe(false);
  });

  it('says so when the store has no row for the file yet', async () => {
    area.mockImplementation(async (_account, name) => {
      if (name === 'files.pin') throw new Error('No file f1');
      return { files: [] };
    });
    const { result } = renderHook(() => useKeepFileOffline(client));
    await act(async () => { await result.current.toggleKeptOffline(FILE); });
    await waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.title)).toContain('pin_not_ready'));
  });
});
