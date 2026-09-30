import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/stalwart/jmap-passthrough', () => ({
  stalwartJmap: vi.fn(),
  requireResult: (responses: Array<[string, unknown, string]>, method: string) => {
    const match = responses.find((r) => r[0] === method);
    if (!match) throw new Error('missing ' + method);
    return match[1];
  },
}));

const fetchConfig = vi.fn();
vi.mock('@/hooks/use-config', () => ({
  fetchConfig: () => fetchConfig(),
}));

import { fetchPrincipalDisplayName } from '@/lib/stalwart/principal';
import { stalwartJmap } from '@/lib/stalwart/jmap-passthrough';

const mockedJmap = stalwartJmap as unknown as ReturnType<typeof vi.fn>;

const fakeClient = (opts: { stalwart?: boolean; accountId?: string } = {}) =>
  ({
    hasAccountCapability: (cap: string) => (opts.stalwart ?? true) && cap === 'urn:stalwart:jmap',
    getAccountId: () => opts.accountId ?? 'acc-1',
  }) as never;

describe('fetchPrincipalDisplayName (#900)', () => {
  beforeEach(() => {
    mockedJmap.mockReset();
    fetchConfig.mockReset();
    fetchConfig.mockResolvedValue({ stalwartFeaturesEnabled: true, stalwartJmapPassthroughEnabled: true });
  });

  it('skips the lookup when the JMAP passthrough is disabled server-side (#904)', async () => {
    fetchConfig.mockResolvedValue({ stalwartFeaturesEnabled: true, stalwartJmapPassthroughEnabled: false });

    expect(await fetchPrincipalDisplayName(fakeClient())).toBeNull();
    expect(mockedJmap).not.toHaveBeenCalled();
  });

  it('skips the lookup when Stalwart features are disabled entirely (#904)', async () => {
    fetchConfig.mockResolvedValue({ stalwartFeaturesEnabled: false, stalwartJmapPassthroughEnabled: true });

    expect(await fetchPrincipalDisplayName(fakeClient())).toBeNull();
    expect(mockedJmap).not.toHaveBeenCalled();
  });

  it('reads the live principal description via x:AccountSettings/get on the given slot', async () => {
    mockedJmap.mockResolvedValueOnce([
      ['x:AccountSettings/get', { list: [{ id: 'singleton', description: '  Renamed User  ' }] }, '0'],
    ]);

    const name = await fetchPrincipalDisplayName(fakeClient(), 2);

    expect(name).toBe('Renamed User');
    expect(mockedJmap).toHaveBeenCalledWith(
      [['x:AccountSettings/get', { accountId: 'acc-1', ids: ['singleton'] }, '0']],
      { slot: 2 },
    );
  });

  it('skips the lookup entirely on non-Stalwart servers', async () => {
    const name = await fetchPrincipalDisplayName(fakeClient({ stalwart: false }));

    expect(name).toBeNull();
    expect(mockedJmap).not.toHaveBeenCalled();
  });

  it('returns null for an empty description so callers keep their fallback', async () => {
    mockedJmap.mockResolvedValueOnce([
      ['x:AccountSettings/get', { list: [{ id: 'singleton', description: '' }] }, '0'],
    ]);

    expect(await fetchPrincipalDisplayName(fakeClient())).toBeNull();
  });

  it('swallows passthrough errors (e.g. forbidden for this user)', async () => {
    mockedJmap.mockRejectedValueOnce(new Error('forbidden'));

    await expect(fetchPrincipalDisplayName(fakeClient())).resolves.toBeNull();
  });
});
