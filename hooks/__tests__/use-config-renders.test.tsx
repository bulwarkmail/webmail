import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// Once the config is fetched, a component that reads it draws once: every
// avatar of every list row reads it, and each one used to set its own copy
// in an effect after mounting, which drew it a second time.

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/stores/policy-store', () => ({
  usePolicyStore: { getState: () => ({ fetchPolicy: vi.fn() }) },
}));

const config = createConfig({ appName: 'Rath Mail', faviconUrl: '' });

beforeEach(() => {
  vi.resetModules();
  mocks.apiFetch.mockReset();
  vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useConfig after the config is fetched', () => {
  it('draws each reader once, all with the same config', async () => {
    mocks.apiFetch.mockResolvedValueOnce(Response.json(config));
    const { fetchConfig, useConfig } = await import('../use-config');
    await fetchConfig();

    const renders: number[] = [0, 0, 0];
    const seen: unknown[] = [];
    function Reader({ i }: { i: number }) {
      const c = useConfig();
      renders[i]++;
      seen[i] = c;
      return <span>{c.appName}</span>;
    }
    const { getAllByText } = render(<><Reader i={0} /><Reader i={1} /><Reader i={2} /></>);
    expect(getAllByText('Rath Mail')).toHaveLength(3);
    // Give a late effect the chance to draw again.
    await new Promise((r) => setTimeout(r, 20));
    expect(renders).toEqual([1, 1, 1]);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
    // The fetched values, not the fallbacks.
    expect((seen[0] as { faviconUrl: string; isLoading: boolean }).faviconUrl).toBe('');
    expect((seen[0] as { isLoading: boolean }).isLoading).toBe(false);
  });

  it('still fills in a reader that mounted before the config came', async () => {
    let answer: (r: Response) => void = () => {};
    mocks.apiFetch.mockReturnValueOnce(new Promise<Response>((r) => { answer = r; }));
    const { useConfig } = await import('../use-config');
    function Reader() {
      const c = useConfig();
      return <span>{c.isLoading ? 'loading' : c.appName}</span>;
    }
    const { findByText, getByText } = render(<Reader />);
    expect(getByText('loading')).toBeTruthy();
    answer(Response.json(config));
    expect(await findByText('Rath Mail')).toBeTruthy();
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));
  });
});
