import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';

// Decision 5 (usability 2026-11-04): an admin's plugin is on for every user
// by default, users may turn it off unless the admin says "always", and the
// page says which of the three applies.

const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
const routes: Record<string, unknown> = {};
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: JSON.parse(String(init?.body ?? '{}')) });
    const data = method === 'GET' ? routes[url.split('?')[0]] ?? {} : { ok: true };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }),
  withBasePath: (p: string) => p,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../_pages/use-extension-icons', () => ({ useExtensionIcons: () => () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/components/plugins/plugin-iframe-slot', () => ({ PluginIframeSlot: () => null }));

import { ExtensionDetailPage } from '../_pages/extension-detail';

function serve(entry: Record<string, unknown>) {
  routes['/api/admin/plugins'] = [{
    id: 'send-checks', name: 'Send Checks', version: '1.0.0', enabled: true, author: 'x', description: '', type: 'hook',
    permissions: ['email:send'], ...entry,
  }];
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  useAdminUnsavedStore.setState({ dirty: {}, pendingLeave: null, pendingScope: null });
});

describe('what users get from an installed plugin', () => {
  it('says a new install is on for everyone and users can turn it off', async () => {
    serve({});
    render(<ExtensionDetailPage kind="plugin" id="send-checks" />);
    const choice = await screen.findByRole('combobox', { name: 'For users' });
    expect((choice as HTMLSelectElement).value).toBe('default-on');
    expect(screen.getByText(/Every user gets it turned on\. Anyone can turn it off/)).toBeTruthy();
    expect(screen.queryByText('Force on for everyone')).toBeNull();
  });

  it('shows a forced plugin as "always" and a default-off one as such', async () => {
    serve({ forceEnabled: true });
    const { unmount } = render(<ExtensionDetailPage kind="plugin" id="send-checks" />);
    expect(((await screen.findByRole('combobox', { name: 'For users' })) as HTMLSelectElement).value).toBe('always');
    unmount();
    serve({ defaultOff: true });
    render(<ExtensionDetailPage kind="plugin" id="send-checks" />);
    expect(((await screen.findByRole('combobox', { name: 'For users' })) as HTMLSelectElement).value).toBe('default-off');
  });

  it('saves the choice as forceEnabled and defaultOff', async () => {
    serve({});
    render(<ExtensionDetailPage kind="plugin" id="send-checks" />);
    const choice = await screen.findByRole('combobox', { name: 'For users' });
    fireEvent.change(choice, { target: { value: 'default-off' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toEqual([
      expect.objectContaining({ url: '/api/admin/plugins', body: { id: 'send-checks', defaultOff: true } }),
    ]));
  });

  it('names permissions in words, not only by id', async () => {
    serve({});
    render(<ExtensionDetailPage kind="plugin" id="send-checks" />);
    // The next-intl mock returns the key.
    expect(await screen.findByText('email_send.title')).toBeTruthy();
  });
});
