// The answers a list row borrows its sender logo from (lib/receipt-answers.ts) are kept per login
// and JMAP account, so a row only ever borrows the answer of its own message, however a server builds
// its blob ids (two accounts on servers whose blob ids are not tied to the account can repeat one).
// A tab adds only its new answer to what is stored, so it cannot bring back answers another tab
// removed. A full sign-out, the wipe of one account and the app lock remove what is stored.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Identity } from '@/lib/jmap/types';
import { parseAuthenticationResults } from '@/lib/email-headers';

// Each case loads the hook and its stores afresh, as a page load does; that takes a while.
vi.setConfig({ testTimeout: 30_000 });

const STORED = 'bulwark-receipt-checked';
const PASS = 'mx.example.org; dkim=pass header.d=airline.example; spf=pass smtp.mailfrom=bounce@airline.example; dmarc=pass header.from=airline.example';
const row = (blobId: string, extra: Partial<Email> = {}) => ({
  from: [{ email: 'bookings@airline.example' }], blobId, size: 1200,
  authenticationResults: parseAuthenticationResults([PASS]),
  ...extra,
}) as unknown as Email;
/** The same message as the reader gets it: the full fetch has decided the receipt flag. */
const opened = (blobId: string, onReceipt: boolean, extra: Partial<Email> = {}) => row(blobId, { authenticationResultsOnReceipt: onReceipt, ...extra });
const stored = () => JSON.parse(window.localStorage.getItem(STORED) ?? '[]') as string[];

async function load() {
  const [{ useBrandDomain }, { useAuthStore }, { useEmailStore }] = await Promise.all([
    import('../use-brand-domain'), import('@/stores/auth-store'), import('@/stores/email-store'),
  ]);
  useAuthStore.setState({ identities: [{ id: 'i1', name: 'Alice', email: 'alice@example.org' } as unknown as Identity] });
  const logo = (email: Email) => renderHook(() => useBrandDomain(email)).result.current;
  return { logo, useAuthStore, useEmailStore, useBrandDomain };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe('answers per login and account', () => {
  it('lends nothing to a row of another login with the same blob id', async () => {
    const { logo } = await load();
    logo(opened('E-AAEBAQ', true));
    expect(logo(row('E-AAEBAQ'))).toBe('airline.example');
    // Another signed-in login's row, as a list that mixes accounts stamps it.
    expect(logo(row('E-AAEBAQ', { sourceClientAccountId: 'second-login', sourceAccountId: 'acc-2' }))).toBeUndefined();
  });

  it('lends nothing to a row of another account of the same login', async () => {
    const { logo } = await load();
    logo(opened('E-1', true, { sourceClientAccountId: 'login-a', sourceAccountId: 'acc-1' }));
    expect(logo(row('E-1', { sourceClientAccountId: 'login-a', sourceAccountId: 'acc-1' }))).toBe('airline.example');
    expect(logo(row('E-1', { sourceClientAccountId: 'login-a', sourceAccountId: 'shared-9' }))).toBeUndefined();
  });

  it('looks a row that names no login up under the login on screen', async () => {
    const { logo, useAuthStore, useEmailStore, useBrandDomain } = await load();
    useAuthStore.setState({ activeAccountId: 'login-a' });
    const reader = renderHook(({ email }) => useBrandDomain(email), { initialProps: { email: opened('E-2', true) } });
    // Another login is opened while the message is still on screen.
    act(() => useEmailStore.setState({ viewingAccountId: 'login-b' }));
    reader.rerender({ email: opened('E-2', true) });
    expect(logo(row('E-2'))).toBeUndefined();
    expect(stored()).toEqual(['login-a||E-2|1200']);
    act(() => useEmailStore.setState({ viewingAccountId: null }));
    expect(logo(row('E-2'))).toBe('airline.example');
  });

  it('stores the login, the account, the blob id and the size of a message that passed, nothing else', async () => {
    const { logo } = await load();
    logo(opened('Gbbb', true, { sourceClientAccountId: 'login-a', sourceAccountId: 'acc-1', subject: 'Your flight', preview: 'secret' } as Partial<Email>));
    logo(opened('Gccc', false, { sourceClientAccountId: 'login-a', sourceAccountId: 'acc-1' }));
    expect(stored()).toEqual(['login-a|acc-1|Gbbb|1200']);
  });
});

describe('what a tab writes', () => {
  it('does not write its old answers back after another tab emptied the storage', async () => {
    const { logo } = await load();
    logo(opened('Gold', true));
    // Another tab's full sign-out or lock empties the storage.
    window.localStorage.removeItem(STORED);
    // This tab, still open a moment longer, records one more answer.
    logo(opened('Gnew', true));
    expect(stored().join(' ')).not.toContain('Gold');
    expect(stored().join(' ')).toContain('Gnew');
  });

  it('keeps what another tab stored in the meantime', async () => {
    const { logo } = await load();
    window.localStorage.setItem(STORED, JSON.stringify(['login-x||Gother|5']));
    logo(opened('Gmine', true));
    expect(stored()).toEqual(['login-x||Gother|5', '||Gmine|1200']);
  });
});

describe('what removes the stored answers', () => {
  it('a full sign-out, also in a tab that never loaded them, and the wipe of one account', async () => {
    window.localStorage.setItem(STORED, JSON.stringify(['login-a|acc-1|Gbbb|1200']));
    const { purgeSignedOutData, ACCOUNT_STORAGE_KEYS } = await import('@/lib/sign-out-cleanup');
    expect(ACCOUNT_STORAGE_KEYS).toContain(STORED);
    purgeSignedOutData();
    expect(window.localStorage.getItem(STORED)).toBeNull();
  });

  it('the app lock', async () => {
    window.localStorage.setItem(STORED, JSON.stringify(['login-a|acc-1|Gbbb|1200']));
    const { scrubBrowserStorage } = await import('@/lib/app-lock/scrub');
    await scrubBrowserStorage();
    expect(window.localStorage.getItem(STORED)).toBeNull();
  });
});
