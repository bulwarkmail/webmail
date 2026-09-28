import { expect, it, vi } from 'vitest';

// A security fetch still running for the previous account must not fill the
// page of the account switched to.

let release!: () => void;
vi.mock('@/lib/stalwart/jmap-passthrough', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/stalwart/jmap-passthrough')>();
  return {
    ...actual,
    stalwartJmap: vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return [
        ['x:AccountPassword/get', { list: [{ otpAuth: { otpUrl: 'otpauth://totp/a' } }] }, '0'],
        ['x:AppPassword/query', { ids: [] }, '1'],
        ['x:ApiKey/query', { ids: [] }, '2'],
      ];
    }),
  };
});

import { useAccountSecurityStore } from '@/stores/account-security-store';
import { useAuthStore } from '@/stores/auth-store';
import { clearAllStores } from '@/lib/account-state-manager';

it('drops an auth-info answer that arrives after the stores were cleared', async () => {
  useAuthStore.setState({ client: { getAccountId: () => 'acc-a' } as never });
  const pending = useAccountSecurityStore.getState().fetchAuthInfo();

  clearAllStores(); // switch to another account
  release();
  await pending;

  expect(useAccountSecurityStore.getState().otpEnabled).toBe(false);
});
