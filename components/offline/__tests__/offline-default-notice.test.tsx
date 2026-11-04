import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineNotice } from '@/lib/offline/offline-mode';
import { useToastStore } from '@/stores/toast-store';

// mail-26: the desktop app's "Bulwark keeps your mail on this device" notice
// stayed over the quick reply box until someone closed it.

const notifier = vi.hoisted(() => ({ show: null as ((notice: OfflineNotice) => void) | null }));
vi.mock('@/lib/offline/offline-mode', () => ({
  setOfflineNotifier: (fn: ((notice: OfflineNotice) => void) | null) => {
    notifier.show = fn;
  },
  startOfflineMode: () => () => {},
  confirmLoss: () => {},
  unsentCount: async () => ({ messages: 0, changes: 0 }),
}));

const { OfflineHost } = await import('../offline-host');

beforeEach(() => {
  useToastStore.getState().clearToasts();
});

afterEach(() => {
  cleanup();
});

describe('the notice that the desktop app keeps mail on this device', () => {
  it('goes away by itself, and still offers Settings', () => {
    render(<OfflineHost />);
    notifier.show!({ kind: 'default-on' });
    const [notice] = useToastStore.getState().toasts;
    expect(notice.title).toBe('default_on');
    expect(notice.duration).toBeGreaterThan(0);
    expect(notice.action?.label).toBe('open_settings');
  });
});
