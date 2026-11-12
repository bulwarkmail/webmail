import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email, Identity } from '@/lib/jmap/types';
import { parseAuthenticationResults } from '@/lib/email-headers';

// A list row carries a message's results but not what shows they were written on receipt, so it
// shows no sender logo by itself. Once the message has been shown in full and passed that check,
// its row shows the logo too, also after a reload. A message that failed the check, one never
// opened, and one from an imported file never get a logo this way; own-domain rows are as before.

// Each case loads the hook and its stores afresh, as a page load does; that takes a while.
vi.setConfig({ testTimeout: 30_000 });

const PASS = 'mx.example.org; dkim=pass header.d=airline.example; spf=pass smtp.mailfrom=bounce@airline.example; dmarc=pass header.from=airline.example';

const row = (blobId: string, extra: Partial<Email> = {}) => ({
  from: [{ email: 'bookings@airline.example' }], blobId, size: 1200,
  authenticationResults: parseAuthenticationResults([PASS]),
  ...extra,
}) as unknown as Email;
/** The same message as the reader gets it: the full fetch has decided the receipt flag. */
const opened = (blobId: string, onReceipt: boolean, extra: Partial<Email> = {}) => row(blobId, { authenticationResultsOnReceipt: onReceipt, ...extra });

/** The modules as a fresh page load has them (after vi.resetModules), with the user's identity. */
async function load() {
  const [{ useBrandDomain }, answers, { useAuthStore }] = await Promise.all([
    import('../use-brand-domain'), import('@/lib/receipt-answers'), import('@/stores/auth-store'),
  ]);
  useAuthStore.setState({ identities: [{ id: 'i1', name: 'Alice', email: 'alice@example.org' } as unknown as Identity] });
  const logo = (email: Email) => renderHook(() => useBrandDomain(email)).result.current;
  return { useBrandDomain, logo, answers };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe('a list row of a message shown in full before', () => {
  it('shows no logo until the message passed the check when shown, then shows it', async () => {
    const { useBrandDomain, logo } = await load();
    const listed = renderHook(() => useBrandDomain(row('blob-1')));
    expect(listed.result.current).toBeUndefined();
    // The reader shows the message.
    expect(logo(opened('blob-1', true))).toBe('airline.example');
    // The row already on screen follows.
    expect(listed.result.current).toBe('airline.example');
    // And a row fetched again later.
    expect(logo(row('blob-1'))).toBe('airline.example');
  });

  it('keeps showing it after a reload', async () => {
    const first = await load();
    first.logo(opened('blob-2', true));
    expect(window.localStorage.getItem('bulwark-receipt-checked')).toContain('blob-2|1200');
    vi.resetModules();
    const { logo } = await load();
    expect(logo(row('blob-2'))).toBe('airline.example');
  });

  it('borrows nothing for a message that failed the check, was never shown, or is another message', async () => {
    const { logo } = await load();
    // Shown in full: the results header had no receipt line above it.
    expect(logo(opened('blob-3', false))).toBeUndefined();
    expect(logo(row('blob-3'))).toBeUndefined();
    // The same with the headers in message order, as a conversation has them.
    const lone = [{ name: 'Authentication-Results', value: PASS }, { name: 'From', value: '<bookings@airline.example>' }];
    expect(logo(row('blob-4', { headers: lone as unknown as Email['headers'] }))).toBeUndefined();
    expect(logo(row('blob-4'))).toBeUndefined();
    // Never shown.
    expect(logo(row('blob-5'))).toBeUndefined();
    // Another message: same blob id but not the same size is not the message that was checked.
    logo(opened('blob-6', true));
    expect(logo(row('blob-6', { size: 999 }))).toBeUndefined();
    expect(window.localStorage.getItem('bulwark-receipt-checked') ?? '').not.toContain('blob-3');
  });

  it('never lends an answer to or from a message from an imported file', async () => {
    const { logo } = await load();
    expect(logo(opened('blob-7', true, { keywords: { $imported: true } }))).toBeUndefined();
    expect(logo(row('blob-7'))).toBeUndefined();
    logo(opened('blob-8', true));
    expect(logo(row('blob-8', { keywords: { $imported: true } }))).toBeUndefined();
  });

  it('leaves the own domain\'s rows as they were', async () => {
    const { logo } = await load();
    expect(logo({ from: [{ email: 'bob@example.org' }], blobId: 'blob-9', size: 10 } as unknown as Email)).toBe('example.org');
  });

  it('forgets every answer when everyone signs out', async () => {
    const { logo } = await load();
    logo(opened('blob-10', true));
    expect(logo(row('blob-10'))).toBe('airline.example');
    const { purgeSignedOutData } = await import('@/lib/sign-out-cleanup');
    act(() => purgeSignedOutData({ keepLocalStore: true }));
    expect(window.localStorage.getItem('bulwark-receipt-checked')).toBeNull();
    expect(logo(row('blob-10'))).toBeUndefined();
  });
});
