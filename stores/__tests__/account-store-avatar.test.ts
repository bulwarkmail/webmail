import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountStore } from '../account-store';
import { ACCOUNT_AVATAR_COLORS } from '@/lib/account-avatars';

const entry = (username: string) => ({
  username, serverUrl: 'https://mail.example.com', authMode: 'basic' as const,
  label: username, displayName: username, email: username, rememberMe: false,
  lastLoginAt: 0, isConnected: false, hasError: false, isDefault: false,
});

beforeEach(() => {
  // Without an HTTP/2 navigation the registry caps at five accounts (#1003).
  vi.spyOn(performance, 'getEntriesByType').mockImplementation(type =>
    type === 'resource' ? [{ nextHopProtocol: 'h2' } as PerformanceResourceTiming] : []);
  localStorage.clear();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
});

afterEach(() => vi.restoreAllMocks());

describe('new accounts get a ready-made avatar', () => {
  it('gives each of the first twelve accounts a colour of its own', () => {
    for (let i = 0; i < ACCOUNT_AVATAR_COLORS.length; i++) {
      useAccountStore.getState().addAccount(entry(`box${i}@example.com`));
    }
    const colours = useAccountStore.getState().accounts.map(a => a.avatarColor);
    expect(new Set(colours).size).toBe(ACCOUNT_AVATAR_COLORS.length);
    // Hashing the address used to hand the same hue to unrelated accounts.
    for (const colour of colours) expect(ACCOUNT_AVATAR_COLORS).toContain(colour as never);
  });

  it('keeps assigning past the palette instead of refusing an account', () => {
    for (let i = 0; i < ACCOUNT_AVATAR_COLORS.length + 3; i++) {
      useAccountStore.getState().addAccount(entry(`box${i}@example.com`));
    }
    const accounts = useAccountStore.getState().accounts;
    expect(accounts).toHaveLength(ACCOUNT_AVATAR_COLORS.length + 3);
    for (const account of accounts) expect(account.avatarColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('leaves an existing account untouched when it is added again', () => {
    const id = useAccountStore.getState().addAccount(entry('box@example.com'));
    const before = useAccountStore.getState().getAccountById(id)!.avatarColor;
    useAccountStore.getState().addAccount(entry('box@example.com'));
    expect(useAccountStore.getState().accounts).toHaveLength(1);
    expect(useAccountStore.getState().getAccountById(id)!.avatarColor).toBe(before);
  });
});
