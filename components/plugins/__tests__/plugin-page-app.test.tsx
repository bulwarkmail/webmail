import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

// The app-page slot: a plugin's page at /apps/<pluginId>/<pageId>, inside the
// app's own frame.

const createSlotInstance = vi.fn((..._args: unknown[]) => ({ destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn() }));
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: (...args: unknown[]) => createSlotInstance(...args),
}));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));
vi.mock('@/components/layout/navigation-rail', () => ({
  NavigationRail: ({ orientation }: { orientation?: string }) => <nav data-testid={`rail-${orientation ?? 'vertical'}`} />,
}));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/apps/kanban/board',
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

const { PluginPageApp } = await import('../plugin-page-app');
const registry = await import('@/lib/plugin-sandbox/registry');
const pages = await import('@/lib/plugin-sandbox/pages');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { isFillableSlot } = await import('@/lib/plugin-sandbox/slot-layout');

function activate(id: string, slots: string[], fill = false) {
  const plugin: InstalledPlugin = {
    id, name: 'Kanban', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: ['ui:app-page'], grantedPermissions: ['ui:app-page'], entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  registry.register({
    plugin, code: '', tier: 'untrusted',
    background: { evaluateShouldShow: vi.fn(async () => true) } as never,
    slotOffers: slots.map((name) => ({ name: name as never, order: 100, hasShouldShow: false, fill })),
    hookDisposables: [],
  });
}

beforeEach(() => {
  createSlotInstance.mockClear();
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: {} as never });
  usePluginStore.setState({ initialized: true, initializePlugins: vi.fn().mockResolvedValue(undefined) });
});
afterEach(() => {
  for (const p of registry.all()) registry.deregister(p.plugin.id);
  pages.resetPages();
});

describe('plugin pages', () => {
  it('fills the content area with the plugin page and hands it the rest of the path', async () => {
    activate('kanban', ['app-page']);
    act(() => pages.setPluginPages('kanban', 'Kanban', [{ id: 'board', title: 'Board' }]));

    const { container } = render(<PluginPageApp linkSegments={['kanban', 'board', 'cards', '42']} />);

    expect(screen.getByTestId('rail-vertical')).toBeInTheDocument();
    expect(container.querySelector('[data-plugin-page="kanban/board"]')).not.toBeNull();
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const opts = createSlotInstance.mock.calls[0][0] as { slot: string; extraProps: Record<string, unknown>; plugin: { id: string } };
    expect(opts.slot).toBe('app-page');
    expect(opts.plugin.id).toBe('kanban');
    expect(opts.extraProps).toEqual({ pageId: 'board', path: 'cards/42' });
    expect(createSlotInstance.mock.calls[0][0]).toMatchObject({ fill: false });
  });

  it('gives an opted-in page the available height through the host and sandbox fill contract', async () => {
    activate('chat', ['app-page'], true);
    act(() => pages.setPluginPages('chat', 'Chat', [{ id: 'agent', title: 'Agent' }]));
    const { container } = render(<PluginPageApp linkSegments={['chat', 'agent']} />);

    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    expect(createSlotInstance.mock.calls[0][0]).toMatchObject({ slot: 'app-page', fill: true });
    expect(isFillableSlot('app-page')).toBe(true);
    expect(isFillableSlot('email-toolbar')).toBe(false);
    const page = container.querySelector('[data-plugin-page="chat/agent"]');
    expect(page).toHaveClass('flex', 'flex-col', 'min-h-0', 'overflow-hidden');
    expect(page?.querySelector('[data-plugin-iframe-fill]')).toHaveStyle({ flex: '1 1 0%', minHeight: 0 });
  });

  it('passes an empty path for the page itself', async () => {
    activate('kanban', ['app-page']);
    act(() => pages.setPluginPages('kanban', 'Kanban', [{ id: 'board', title: 'Board' }]));
    render(<PluginPageApp linkSegments={['kanban', 'board']} />);

    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    expect((createSlotInstance.mock.calls[0][0] as { extraProps: unknown }).extraProps).toEqual({ pageId: 'board', path: '' });
  });

  it('says the page is not available, with a way back to Mail, once the plugin is gone', () => {
    render(<PluginPageApp linkSegments={['kanban', 'board']} />);

    expect(screen.getByText('not_available_title')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'back_to_mail' })).toHaveAttribute('href', '/');
    expect(createSlotInstance).not.toHaveBeenCalled();
  });

  it('waits for the plugins to start before saying so', () => {
    usePluginStore.setState({ initialized: false });
    render(<PluginPageApp linkSegments={['kanban', 'board']} />);

    expect(screen.queryByText('not_available_title')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('loading');
  });

  it('does not mount another plugin page under a wrong page id', () => {
    activate('kanban', ['app-page']);
    act(() => pages.setPluginPages('kanban', 'Kanban', [{ id: 'board', title: 'Board' }]));
    render(<PluginPageApp linkSegments={['kanban', 'other']} />);

    expect(screen.getByText('not_available_title')).toBeInTheDocument();
  });
});
