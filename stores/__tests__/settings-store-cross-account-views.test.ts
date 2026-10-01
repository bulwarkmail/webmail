import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import { useSettingsStore } from '../settings-store';
import { useAccountStore } from '../account-store';

// An account whose stored settings predate the merged mailbox.
const STORED = { enableUnifiedMailbox: false, unifiedCrossAccount: false, enableCrossAllView: false, sendDelaySeconds: 30 };

function serverAnswers(settings: Record<string, unknown>) {
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ settings }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

describe('views spanning every account across an account switch', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    useSettingsStore.getState().disableSync();
    useSettingsStore.setState({
      enableUnifiedMailbox: true,
      unifiedCrossAccount: true,
      enableCrossAllView: true,
      sendDelaySeconds: 0,
    });
  });

  it('keeps the device\'s merged-mailbox choice when another of its logins loads its settings', async () => {
    useAccountStore.setState({ accounts: [{ id: 'a' }, { id: 'b' }] as never });
    serverAnswers(STORED);

    await useSettingsStore.getState().loadFromServer('b@example.com', 'https://mail-b.example.com');

    const s = useSettingsStore.getState();
    expect(s.enableUnifiedMailbox).toBe(true);
    expect(s.unifiedCrossAccount).toBe(true);
    expect(s.enableCrossAllView).toBe(true);
    // Everything else still follows the account.
    expect(s.sendDelaySeconds).toBe(30);
  });

  it('takes them from the server on a device\'s first login', async () => {
    useAccountStore.setState({ accounts: [{ id: 'a' }] as never });
    serverAnswers(STORED);

    await useSettingsStore.getState().loadFromServer('a@example.com', 'https://mail-a.example.com');

    expect(useSettingsStore.getState().enableUnifiedMailbox).toBe(false);
    expect(useSettingsStore.getState().unifiedCrossAccount).toBe(false);
  });
});
