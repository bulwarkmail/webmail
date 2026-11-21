import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';

// Removing a plugin deletes its settings and stored keys on the server. The admin's remove dialog
// says so; a theme has neither, and its dialog says nothing of them.

const routes: Record<string, unknown> = {};
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(async (url: string) => {
    const data = routes[url.split('?')[0]] ?? {};
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }),
  withBasePath: (p: string) => p,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../_pages/use-extension-icons', () => ({ useExtensionIcons: () => () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/components/plugins/plugin-iframe-slot', () => ({ PluginIframeSlot: () => null }));

import { ExtensionDetailPage } from '../_pages/extension-detail';

const SENTENCE = /Its settings and stored keys are deleted\./;

afterEach(() => {
  useAdminUnsavedStore.setState({ dirty: {}, pendingLeave: null, pendingScope: null });
});

describe('the remove dialog of an installed extension', () => {
  it('says that a plugin\'s settings and stored keys are deleted', async () => {
    routes['/api/admin/plugins'] = [{
      id: 'send-checks', name: 'Send Checks', version: '1.0.0', enabled: true, author: 'x', description: '', type: 'hook', permissions: ['email:send'],
    }];
    render(<ExtensionDetailPage kind="plugin" id="send-checks" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(SENTENCE);
    expect(dialog.textContent).toMatch(/removed for every user/);
  });

  it('says nothing of settings for a theme', async () => {
    routes['/api/admin/themes'] = [{ id: 'nord', name: 'Nord', version: '1.0.0', enabled: true, author: 'x', description: '' }];
    render(<ExtensionDetailPage kind="theme" id="nord" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/removed for every user/);
    expect(dialog.textContent).not.toMatch(SENTENCE);
  });
});
