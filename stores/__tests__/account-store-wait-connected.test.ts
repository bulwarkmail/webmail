import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountStore, waitForConnectedAccount } from '../account-store';

/**
 * A tapped notification reopens the app and names a mailbox; the logins come
 * back one at a time, so that mailbox is often not connected yet when the
 * link is read. The wait must tell "late" from "never".
 */
function seed(accounts: Array<{ id: string; isConnected: boolean; hasError?: boolean }>) {
  useAccountStore.setState({
    accounts: accounts.map((a) => ({
      id: a.id,
      cookieSlot: 0,
      username: a.id,
      serverUrl: 'https://mail.example.org',
      displayName: a.id,
      email: a.id,
      avatarColor: '#123456',
      rememberMe: true,
      isConnected: a.isConnected,
      hasError: a.hasError ?? false,
      isDefault: false,
      lastLoginAt: 0,
      label: a.id,
      authMode: 'basic',
    })) as never,
  });
}

const connect = (id: string, patch: Record<string, unknown>) =>
  useAccountStore.setState((s) => ({
    accounts: s.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)),
  }));

describe('waitForConnectedAccount', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answers at once for a login already connected', async () => {
    seed([{ id: 'a', isConnected: true }]);
    await expect(waitForConnectedAccount('a')).resolves.toBe(true);
  });

  it('waits for a login that is still reconnecting', async () => {
    seed([{ id: 'a', isConnected: true }, { id: 'late', isConnected: false }]);
    const waiting = waitForConnectedAccount('late');
    connect('late', { isConnected: true });
    await expect(waiting).resolves.toBe(true);
  });

  it('gives up on a login this browser does not have', async () => {
    seed([{ id: 'a', isConnected: true }]);
    await expect(waitForConnectedAccount('stranger')).resolves.toBe(false);
  });

  it('gives up when the login fails to reconnect', async () => {
    seed([{ id: 'broken', isConnected: false }]);
    const waiting = waitForConnectedAccount('broken');
    connect('broken', { hasError: true });
    await expect(waiting).resolves.toBe(false);
  });

  it('gives up after the timeout rather than waiting forever', async () => {
    seed([{ id: 'stuck', isConnected: false }]);
    const waiting = waitForConnectedAccount('stuck', 5_000);
    vi.advanceTimersByTime(5_001);
    await expect(waiting).resolves.toBe(false);
  });
});
