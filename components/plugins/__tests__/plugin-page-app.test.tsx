import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
let mountainView = false;
vi.mock('@/hooks/use-mountain-view-shell', () => ({ useMountainViewShell: () => mountainView }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
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
const { dispatchApiCall } = await import('@/lib/plugin-sandbox/host-api');
const { clearSidePanel } = await import('@/lib/plugin-sandbox/side-panels');
const { PluginSidePanel } = await import('../plugin-side-panels');

function activate(id: string, slots: string[], fill = false) {
  const permissions = ['ui:app-page', 'ui:sidebar-widget'];
  const plugin: InstalledPlugin = {
    id, name: 'Kanban', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions, grantedPermissions: permissions, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  registry.register({
    plugin, code: '', tier: 'untrusted',
    background: { evaluateShouldShow: vi.fn(async () => true) } as never,
    slotOffers: slots.map((name) => ({ name: name as never, order: 100, hasShouldShow: false, fill })),
    hookDisposables: [],
  });
  return plugin;
}

beforeEach(() => {
  createSlotInstance.mockClear();
  localStorage.clear();
  mountainView = false;
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: {} as never });
  usePluginStore.setState({ initialized: true, initializePlugins: vi.fn().mockResolvedValue(undefined) });
});
afterEach(() => {
  for (const p of registry.all()) {
    clearSidePanel(p.plugin.id);
    registry.deregister(p.plugin.id);
  }
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

// The side-panel slot beside a plugin page, as beside the mail (the
// follow-ups plugin's "Upcoming for me" opened from a toolbar button).
describe('plugin side panels on a plugin page', () => {
  function showPage() {
    const plugin = activate('kanban', ['app-page', 'side-panel'], true);
    act(() => pages.setPluginPages('kanban', 'Kanban', [{ id: 'board', title: 'Board' }]));
    return plugin;
  }

  it('answers togglePanel("side-panel") and draws the panel beside the page, which narrows', async () => {
    const plugin = showPage();
    const { container } = render(<PluginPageApp linkSegments={['kanban', 'board']} />);
    await act(async () => { await dispatchApiCall(plugin, 'ui.setSidePanel', [{ title: 'Upcoming for me', icon: 'flag', rail: false }]); });
    expect(container.querySelector('[data-plugin-side-panel]')).toBeNull();

    let answer: unknown;
    await act(async () => { answer = await dispatchApiCall(plugin, 'ui.setPanel', ['side-panel', 'toggle']); });
    expect(answer).toBe(true);
    const panel = screen.getByRole('complementary', { name: 'Upcoming for me' });
    expect(panel).toHaveClass('w-[300px]', 'shrink-0');
    // Beside the page's column, in the same row: the page gives up the width.
    const page = container.querySelector('[data-plugin-page="kanban/board"]')!;
    const row = panel.parentElement!;
    expect(row).toHaveClass('flex');
    expect(row.contains(page)).toBe(true);
    expect(page.contains(panel)).toBe(false);
    expect(Array.from(row.children).indexOf(panel)).toBeGreaterThan(0);
    await waitFor(() => expect(createSlotInstance.mock.calls.some((c) => (c[0] as { slot: string }).slot === 'side-panel')).toBe(true));

    await act(async () => { answer = await dispatchApiCall(plugin, 'ui.setPanel', ['side-panel', 'toggle']); });
    expect(answer).toBe(false);
    expect(container.querySelector('[data-plugin-side-panel]')).toBeNull();
  });

  it('keeps one open state with the mail view, both ways', async () => {
    const plugin = showPage();
    // Opened beside the mail (the mail view's PluginSidePanel) ...
    const mail = render(<PluginSidePanel />);
    await act(async () => { await dispatchApiCall(plugin, 'ui.setPanel', ['side-panel', 'open']); });
    mail.unmount();

    // ... it stays open on the plugin page ...
    const onPage = render(<PluginPageApp linkSegments={['kanban', 'board']} />);
    expect(onPage.container.querySelector('[data-plugin-side-panel="kanban"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onPage.container.querySelector('[data-plugin-side-panel]')).toBeNull();
    onPage.unmount();

    // ... and closed there, it is closed back in the mail.
    const back = render(<PluginSidePanel />);
    expect(back.container.querySelector('[data-plugin-side-panel]')).toBeNull();
  });

  it('puts it in Mountain View\'s side panel beside the card', async () => {
    mountainView = true;
    useAuthStore.setState({ client: { supportsContacts: () => false } as never });
    const plugin = showPage();
    const { container } = render(<PluginPageApp linkSegments={['kanban', 'board']} />);
    await act(async () => { await dispatchApiCall(plugin, 'ui.setPanel', ['side-panel', 'open']); });
    const panel = container.querySelector('[data-plugin-side-panel="kanban"]')!;
    expect(panel).not.toBeNull();
    const card = container.querySelector('[data-mv-card]')!;
    expect(card.contains(panel)).toBe(false);
    expect(card.parentElement).toBe(panel.parentElement);
  });
});
