// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A company calendar may live on the intranet: fetchPublicUrl lets the one
// host the admin entered resolve to an intranet address, and only when that
// host itself names the intranet (an intranet address, .local/.internal, a
// single-label name). Loopback, link-local and metadata addresses stay
// refused for it, a public name gets no exception at all, and the address is
// still pinned at connect time.

const lookup = vi.fn();
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: { ...actual, lookup: (...args: unknown[]) => lookup(...args) },
    lookup: (...args: unknown[]) => lookup(...args),
  };
});

describe('what counts as the intranet', () => {
  it('takes intranet addresses and names, never loopback, link-local, metadata or public names', async () => {
    const { isIntranetAddress, isIntranetHostName } = await import('@/lib/security/url-guard');
    for (const ip of ['10.1.2.3', '172.16.0.9', '192.168.178.20', '100.64.1.1', 'fd12:3456::1', '::ffff:10.0.0.1']) {
      expect(isIntranetAddress(ip), ip).toBe(true);
    }
    for (const ip of ['127.0.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00:ec2::254', '::ffff:127.0.0.1', '8.8.8.8', '224.0.0.1']) {
      expect(isIntranetAddress(ip), ip).toBe(false);
    }
    for (const host of ['calendar', 'cal.corp.internal', 'nas.local', 'srv.localdomain', '10.0.0.5', '[fd12::1]']) {
      expect(isIntranetHostName(host), host).toBe(true);
    }
    for (const host of ['cal.example.org', 'localhost', 'app.localhost', '127.0.0.1', '169.254.169.254', '']) {
      expect(isIntranetHostName(host), host).toBe(false);
    }
  });
});

describe('fetchPublicUrl with allowPrivateHost', () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end('BEGIN:VCALENDAR\nEND:VCALENDAR\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    lookup.mockReset();
    hits = 0;
  });

  it('lets an intranet name through to an intranet address', async () => {
    lookup.mockResolvedValue([{ address: '10.255.255.1', family: 4 }]);
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');
    // Nothing answers there: the connection is tried (the guard lets it
    // through) and runs out of time.
    const error = await fetchPublicUrl('http://calendar:8080/team.ics', { signal: AbortSignal.timeout(300) }, { allowPrivateHost: 'calendar' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DisallowedUrlError);
    expect(lookup).toHaveBeenCalled();
  });

  it('refuses loopback and metadata addresses even for the admin\'s intranet host', async () => {
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(fetchPublicUrl(`http://calendar:${port}/team.ics`, {}, { allowPrivateHost: 'calendar' }))
      .rejects.toBeInstanceOf(DisallowedUrlError);
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(fetchPublicUrl('http://cal.corp.internal/latest/meta-data/', {}, { allowPrivateHost: 'cal.corp.internal' }))
      .rejects.toBeInstanceOf(DisallowedUrlError);
    await expect(fetchPublicUrl(`http://127.0.0.1:${port}/team.ics`, {}, { allowPrivateHost: '127.0.0.1' }))
      .rejects.toBeInstanceOf(DisallowedUrlError);
    expect(hits).toBe(0);
  });

  it('gives a public host no exception, whatever its DNS points at', async () => {
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');
    lookup.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
    await expect(fetchPublicUrl('http://partner.example.org/cal.ics', {}, { allowPrivateHost: 'partner.example.org' }))
      .rejects.toBeInstanceOf(DisallowedUrlError);
    // Another intranet name than the admin's stays refused.
    await expect(fetchPublicUrl('http://other.corp.internal/a.ics', {}, { allowPrivateHost: 'cal.corp.internal' }))
      .rejects.toBeInstanceOf(DisallowedUrlError);
    expect(hits).toBe(0);
  });
});
