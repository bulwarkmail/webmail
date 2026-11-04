import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Usability 2026-11-04, settings-21: Quick install of a plugin says what it
// may do in every mailbox before anything is installed; themes stay one click.

const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
let policy: Record<string, unknown> = { features: { pluginsEnabled: true } };
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    calls.push({ url, method, body: typeof raw === 'string' ? JSON.parse(raw) : {} });
    const path = url.split('?')[0];
    const data = method !== 'GET' ? { warnings: [] }
      : path === '/api/admin/marketplace' ? { data: LISTINGS, meta: { page: 1, perPage: 12, total: 2 }, channel: 'stable', directoryUrl: 'https://dir.example' }
      : path === '/api/admin/policy' ? policy
      : path === '/api/admin/marketplace/updates' ? { installed: [], updates: [], yanked: [], deprecated: [], suspended: [], advisories: [], unknown: [], directoryUrl: '', channel: 'stable', error: null }
      : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }),
  withBasePath: (p: string) => p,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));

const base = {
  description: 'd', totalDownloads: 3, rating: { average: 0, count: 0 }, tags: [], featured: false, deprecated: false,
  bannerUrl: null, iconUrl: null, installed: false, installedVersion: null, latestVersion: '1.0.0',
  latest: { version: '1.0.0', channel: 'stable' },
};
const LISTINGS = [
  { ...base, slug: 'send-checks', name: 'Send Checks', type: 'plugin', pluginType: 'hook', permissions: ['email:send', 'email:read'], author: { displayName: 'Bulwark Team' } },
  { ...base, slug: 'bolt', name: 'Bolt', type: 'theme', pluginType: null, permissions: [], author: { displayName: 'Someone' } },
];

import { MarketplacePage } from '../_pages/marketplace';

const installs = () => calls.filter((c) => c.url === '/api/admin/marketplace' && c.method === 'POST');

beforeEach(() => {
  calls.length = 0;
  policy = { features: { pluginsEnabled: true } };
});

describe('Quick install', () => {
  it('shows a plugin\'s publisher and permissions before installing it', async () => {
    render(<MarketplacePage />);
    const card = (await screen.findByText('Send Checks')).closest('.group') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /Quick install/ }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Install Send Checks?')).toBeTruthy();
    expect(within(dialog).getByText(/By Bulwark Team\./)).toBeTruthy();
    // The next-intl mock returns keys: the user-facing permission titles.
    expect(within(dialog).getByText('email_send.title')).toBeTruthy();
    expect(within(dialog).getByText('email_read.title')).toBeTruthy();
    expect(installs()).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(installs()).toEqual([expect.objectContaining({ body: { slug: 'send-checks', version: '1.0.0', type: 'plugin' } })]));
  });

  it('installs nothing on Cancel', async () => {
    render(<MarketplacePage />);
    const card = (await screen.findByText('Send Checks')).closest('.group') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /Quick install/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(installs()).toEqual([]);
  });

  it('installs a theme with one click', async () => {
    render(<MarketplacePage />);
    const card = (await screen.findByText('Bolt')).closest('.group') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /Quick install/ }));
    await waitFor(() => expect(installs()).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('names the plugin type in words', async () => {
    render(<MarketplacePage />);
    const card = (await screen.findByText('Send Checks')).closest('.group') as HTMLElement;
    expect(within(card).getByText('Works in the background')).toBeTruthy();
    expect(within(card).queryByText('hook')).toBeNull();
  });

  it('asks to turn plugins on for users when they are off', async () => {
    policy = { features: { pluginsEnabled: false } };
    render(<MarketplacePage />);
    const card = (await screen.findByText('Send Checks')).closest('.group') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /Quick install/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Install' }));
    const question = await screen.findByText('Turn on plugins for users too?');
    fireEvent.click(within(question.closest('[role="alertdialog"]') as HTMLElement).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      url: '/api/admin/policy', method: 'PUT', body: expect.objectContaining({ features: { pluginsEnabled: true } }),
    })));
  });
});
