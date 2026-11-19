// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// resolveCheckedAddress gives the mailbox migration's raw sockets (IMAP,
// ManageSieve) one checked address to connect to. Loopback, link-local and
// metadata addresses are always refused; an intranet address only for an
// intranet name the admin entered.

const lookup = vi.fn();
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: { ...actual, lookup: (...args: unknown[]) => lookup(...args) },
    lookup: (...args: unknown[]) => lookup(...args),
  };
});

const answer = (address: string) => [{ address, family: address.includes(':') ? 6 : 4 }];

describe('resolveCheckedAddress', () => {
  beforeEach(() => lookup.mockReset());

  it('returns the address a public name resolves to', async () => {
    lookup.mockResolvedValue(answer('93.184.216.34'));
    const { resolveCheckedAddress } = await import('@/lib/security/url-guard');
    await expect(resolveCheckedAddress('imap.example.com')).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('refuses loopback and link-local answers, with or without the admin flag', async () => {
    const { resolveCheckedAddress } = await import('@/lib/security/url-guard');
    for (const address of ['127.0.0.1', '169.254.169.254', '::1', 'fe80::1']) {
      lookup.mockResolvedValue(answer(address));
      await expect(resolveCheckedAddress('imap.example.com'), address).rejects.toMatchObject({ code: 'EBLOCKED' });
      await expect(resolveCheckedAddress('mail', { allowPrivateHost: true }), address).rejects.toMatchObject({ code: 'EBLOCKED' });
    }
    await expect(resolveCheckedAddress('localhost', { allowPrivateHost: true })).rejects.toMatchObject({ code: 'EBLOCKED' });
    await expect(resolveCheckedAddress('169.254.169.254', { allowPrivateHost: true })).rejects.toMatchObject({ code: 'EBLOCKED' });
  });

  it('allows an intranet host the admin entered', async () => {
    lookup.mockResolvedValue(answer('10.0.0.7'));
    const { resolveCheckedAddress } = await import('@/lib/security/url-guard');
    await expect(resolveCheckedAddress('mail.corp.internal', { allowPrivateHost: true })).resolves.toEqual({ address: '10.0.0.7', family: 4 });
    await expect(resolveCheckedAddress('10.0.0.7', { allowPrivateHost: true })).resolves.toMatchObject({ address: '10.0.0.7' });
  });

  it('refuses private addresses without the flag, and for a public name even with it', async () => {
    lookup.mockResolvedValue(answer('192.168.1.10'));
    const { resolveCheckedAddress } = await import('@/lib/security/url-guard');
    await expect(resolveCheckedAddress('mail.corp.internal')).rejects.toMatchObject({ code: 'EBLOCKED' });
    await expect(resolveCheckedAddress('imap.example.com')).rejects.toMatchObject({ code: 'EBLOCKED' });
    await expect(resolveCheckedAddress('imap.example.com', { allowPrivateHost: true })).rejects.toMatchObject({ code: 'EBLOCKED' });
    await expect(resolveCheckedAddress('10.0.0.7')).rejects.toMatchObject({ code: 'EBLOCKED' });
  });
});
