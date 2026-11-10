import { describe, it, expect, vi } from 'vitest';

const accounts = [
  { id: 'a@mail.example', username: 'a', serverUrl: 'https://mail.example', cookieSlot: 0 },
  { id: 'b@mail.example', username: 'b', serverUrl: 'https://mail.example', cookieSlot: 1 },
];

vi.mock('@/stores/account-store', () => ({
  useAccountStore: {
    getState: () => ({
      activeAccountId: 'a@mail.example',
      getAccountById: (id: string) => accounts.find((acc) => acc.id === id),
      getActiveAccount: () => accounts[0],
    }),
  },
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({ activeAccountId: null }),
  },
}));

import { getActiveAccountSlotHeaders, getAccountSlotHeadersFor } from '@/lib/auth/active-account-slot';

describe('getAccountSlotHeadersFor', () => {
  it('resolves the requested account\'s own slot, not whichever account is active', () => {
    // Account "a" is active (slot 0), but we're asking about account "b" (slot 1) -
    // e.g. while scanning every configured account's calendars in the background.
    expect(getActiveAccountSlotHeaders()).toEqual({ 'X-JMAP-Cookie-Slot': '0' });
    expect(getAccountSlotHeadersFor('b', 'https://mail.example')).toEqual({ 'X-JMAP-Cookie-Slot': '1' });
    expect(getAccountSlotHeadersFor('a', 'https://mail.example')).toEqual({ 'X-JMAP-Cookie-Slot': '0' });
  });

  it('falls back to the active slot for an account not in the multi-account store', () => {
    expect(getAccountSlotHeadersFor('unknown', 'https://mail.example')).toEqual({ 'X-JMAP-Cookie-Slot': '0' });
  });
});
