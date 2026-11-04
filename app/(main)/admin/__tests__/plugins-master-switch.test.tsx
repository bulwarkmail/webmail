import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';

// Usability 2026-11-04, settings-17 and settings-20: the switch that turns
// plugins on for users at all comes first, with a banner while it is off,
// and the switches that depend on it don't look on while it is off.

const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
const routes: Record<string, unknown> = {};
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    calls.push({ url, method, body: typeof raw === 'string' ? JSON.parse(raw) : {} });
    const data = method === 'GET'
      ? routes[url.split('?')[0]] ?? {}
      : url === '/api/admin/plugins' && method === 'POST' ? { plugin: { name: 'Send Checks' } } : { ok: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }),
  withBasePath: (p: string) => p,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../_pages/plugin-approvals-panel', () => ({ PluginApprovalsPanel: () => null }));
vi.mock('../_pages/use-extension-icons', () => ({ useExtensionIcons: () => () => null }));

import { PluginsPage } from '../_pages/plugins';
import { DEFAULT_FEATURE_GATES } from '@/lib/admin/types';

const writes = () => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  calls.length = 0;
  routes['/api/admin/plugins'] = [];
});
afterEach(() => {
  useAdminUnsavedStore.setState({ dirty: {}, pendingLeave: null, pendingScope: null });
});

describe('the plugins master switch', () => {
  it('leaves user uploads off unless the admin turns them on', () => {
    expect(DEFAULT_FEATURE_GATES.pluginsUploadEnabled).toBe(false);
  });

  it('comes first, with a banner while plugins are off, and its sub-switches off and disabled', async () => {
    routes['/api/admin/policy'] = { features: { pluginsEnabled: false, pluginsUploadEnabled: true, requirePluginApproval: true }, themePolicy: {} };
    render(<PluginsPage />);
    const banner = await screen.findByTestId('plugins-off-banner');
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings[1]).toBe('Plugins for users');
    await waitFor(() => expect(screen.getAllByRole('switch')[0].getAttribute('aria-checked')).toBe('false'));
    const [, uploads, approval] = screen.getAllByRole('switch');
    expect(uploads.getAttribute('aria-checked')).toBe('false');
    expect(uploads).toBeDisabled();
    expect(approval.getAttribute('aria-checked')).toBe('false');
    expect(approval).toBeDisabled();

    fireEvent.click(within(banner).getByRole('button', { name: 'Turn on' }));
    expect(screen.queryByTestId('plugins-off-banner')).toBeNull();
    // The stored values come back once plugins are on.
    expect(uploads.getAttribute('aria-checked')).toBe('true');
    expect(writes()).toEqual([]);
  });

  it('asks to turn plugins on for users after an upload while they are off', async () => {
    routes['/api/admin/policy'] = { features: { pluginsEnabled: false }, themePolicy: {} };
    render(<PluginsPage />);
    await screen.findByTestId('plugins-off-banner');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'p.zip')] } });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Turn on plugins for users too?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(writes()).toContainEqual(
      expect.objectContaining({ url: '/api/admin/policy', method: 'PUT', body: expect.objectContaining({ features: expect.objectContaining({ pluginsEnabled: true }) }) }),
    ));
  });

  it('doesn\'t ask when plugins are on', async () => {
    routes['/api/admin/policy'] = { features: { pluginsEnabled: true }, themePolicy: {} };
    render(<PluginsPage />);
    await waitFor(() => expect(screen.getAllByRole('switch')[0].getAttribute('aria-checked')).toBe('true'));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'p.zip')] } });
    await waitFor(() => expect(writes().map((c) => c.method)).toEqual(['POST']));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
