import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #1687: a server entry that is only an extra account is not offered on the
// first sign-in, and is when adding an account.

const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({
    appName: 'Webmail',
    isLoading: false,
    error: null,
    jmapServerUrl: '',
    jmapServers: [
      { id: 'main', label: 'Family', url: 'https://mail.family.test', domains: [] },
      { id: 'work', label: 'Work', url: 'https://mail.work.test', domains: [] },
      { id: 'extern', label: 'External account', url: 'https://proxy.family.test', domains: ['gmx.test'], extraAccountOnly: true },
    ],
    jmapServerAutoPickByDomain: true,
    oauthEnabled: false,
    oauthOnly: false,
    allowCustomJmapEndpoint: false,
    loginShowHeading: true,
    loginShowSubtitle: true,
  }),
}));

const { default: LoginPage } = await import('../page');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

const options = async () => {
  await waitFor(() => expect(document.getElementById('jmap-server-select')).not.toBeNull(), { timeout: 10000 });
  return [...(document.getElementById('jmap-server-select') as HTMLSelectElement).options].map((o) => o.value);
};

describe('a server that is only an extra account', () => {
  it('is not offered on the first sign-in', async () => {
    search.value = '';
    render(<LoginPage />);
    expect(await options()).toEqual(['main', 'work']);
  }, 30_000);

  it('is offered when adding an account', async () => {
    search.value = 'mode=add-account';
    render(<LoginPage />);
    expect(await options()).toEqual(['main', 'work', 'extern']);
  }, 30_000);
});
