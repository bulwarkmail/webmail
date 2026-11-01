import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

const createSlotInstance = vi.fn((..._args: unknown[]) => ({ destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn() }));
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: (...args: unknown[]) => createSlotInstance(...args),
}));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

const { PluginSidePanel } = await import('../plugin-side-panels');
const { MvSidePanel } = await import('@/components/layout/mv-side-panel');
const registry = await import('@/lib/plugin-sandbox/registry');
const { dispatchApiCall } = await import('@/lib/plugin-sandbox/host-api');
const { clearSidePanel } = await import('@/lib/plugin-sandbox/side-panels');
const { useCalendarStore } = await import('@/stores/calendar-store');
const { useSettingsStore } = await import('@/stores/settings-store');

function offer(id: string, name: string, opts: { slot?: string; fill?: boolean } = {}) {
  const plugin: InstalledPlugin = {
    id, name, version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: ['ui:sidebar-widget'], grantedPermissions: ['ui:sidebar-widget'], entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  registry.register({
    plugin,
    code: '',
    tier: 'untrusted',
    background: { evaluateShouldShow: vi.fn(async () => true) } as never,
    slotOffers: [{ name: (opts.slot ?? 'side-panel') as never, order: 100, hasShouldShow: false, ...(opts.fill ? { fill: true } : {}) }],
    hookDisposables: [],
  });
  return plugin;
}

beforeEach(() => {
  createSlotInstance.mockClear();
  localStorage.clear();
});

afterEach(() => {
  for (const p of registry.all()) {
    clearSidePanel(p.plugin.id);
    registry.deregister(p.plugin.id);
  }
});

describe('PluginSidePanel (default layout)', () => {
  it('draws nothing when no plugin offers a side panel', () => {
    offer('w', 'Widget', { slot: 'sidebar-widget' });
    const { container } = render(<PluginSidePanel />);
    expect(container.firstChild).toBeNull();
  });

  it('gives each plugin a button in the rail that opens and closes its panel, filled by the frame', async () => {
    offer('fu', 'Follow-ups', { fill: true });
    const { container } = render(<PluginSidePanel />);
    const button = screen.getByRole('button', { name: 'Follow-ups' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('[data-plugin-side-panel]')).toBeNull();

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('complementary', { name: 'Follow-ups' })).toBeInTheDocument();
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const opts = createSlotInstance.mock.calls[0][0] as { slot: string; extraProps: Record<string, unknown>; fill?: boolean };
    expect(opts.slot).toBe('side-panel');
    expect(opts.extraProps).toEqual({ focusRequest: 0 });
    expect(container.querySelector('[data-plugin-iframe-fill]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(container.querySelector('[data-plugin-side-panel]')).toBeNull();
  });

  it('remembers the open panel in this browser', () => {
    offer('fu', 'Follow-ups');
    const first = render(<PluginSidePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Follow-ups' }));
    first.unmount();

    const { container } = render(<PluginSidePanel />);
    expect(container.querySelector('[data-plugin-side-panel="fu"]')).not.toBeNull();
  });

  it('names the button and panel as the plugin set them, and by its name again after null', async () => {
    const plugin = offer('fu', 'Follow-ups');
    render(<PluginSidePanel />);
    await act(async () => { await dispatchApiCall(plugin, 'ui.setSidePanel', [{ title: 'Upcoming for me', icon: 'flag' }]); });
    expect(screen.getByRole('button', { name: 'Upcoming for me' })).toBeInTheDocument();

    await expect(dispatchApiCall(plugin, 'ui.setSidePanel', [{ title: 'x'.repeat(41) }])).rejects.toThrow(/at most 40/);
    await expect(dispatchApiCall(plugin, 'ui.setSidePanel', [{ icon: 'no icon' }])).rejects.toThrow(/icon/);
    await act(async () => { await dispatchApiCall(plugin, 'ui.setSidePanel', [null]); });
    expect(screen.getByRole('button', { name: 'Follow-ups' })).toBeInTheDocument();

    const noPerm = { ...plugin, id: 'other', permissions: [], grantedPermissions: [] };
    await expect(dispatchApiCall(noPerm, 'ui.setSidePanel', [{ title: 'Mine' }])).rejects.toThrow(/lacks permission "ui:sidebar-widget"/);
  });

  it('leaves the button out with rail: false, the panel opened on the plugin\'s request only', async () => {
    const plugin = offer('fu', 'Follow-ups');
    const { container } = render(<PluginSidePanel />);
    await act(async () => { await dispatchApiCall(plugin, 'ui.setSidePanel', [{ title: 'Upcoming for me', icon: 'flag', rail: false }]); });
    expect(screen.queryByRole('button', { name: 'Upcoming for me' })).toBeNull();
    expect(container.querySelector('[data-plugin-side-rail]')).toBeNull();

    await act(async () => { await dispatchApiCall(plugin, 'ui.setPanel', ['side-panel', 'toggle']); });
    expect(screen.getByRole('complementary', { name: 'Upcoming for me' })).toBeInTheDocument();

    await expect(dispatchApiCall(plugin, 'ui.setSidePanel', [{ rail: 'no' }])).rejects.toThrow(/rail/);
  });

  it('opens on the plugin\'s request with a new focusRequest, and answers null without a panel on screen', async () => {
    const plugin = offer('fu', 'Follow-ups');
    const { container, unmount } = render(<PluginSidePanel />);
    let answer: unknown;
    await act(async () => { answer = await dispatchApiCall(plugin, 'ui.setPanel', ['side-panel', 'open']); });
    expect(answer).toBe(true);
    expect(container.querySelector('[data-plugin-side-panel="fu"]')).not.toBeNull();
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    expect((createSlotInstance.mock.calls[0][0] as { extraProps: unknown }).extraProps).toEqual({ focusRequest: 1 });

    await act(async () => { answer = await dispatchApiCall(plugin, 'ui.setPanel', ['side-panel', 'toggle']); });
    expect(answer).toBe(false);
    expect(container.querySelector('[data-plugin-side-panel]')).toBeNull();

    unmount();
    await expect(dispatchApiCall(plugin, 'ui.setPanel', ['side-panel', 'open'])).resolves.toBeNull();
  });
});

describe('MvSidePanel with plugin panels', () => {
  beforeEach(() => {
    useCalendarStore.setState({ supportsCalendar: true, calendars: [], events: [] } as never);
    useSettingsStore.setState({ enableCalendarTasks: false } as never);
  });

  it('adds the plugins\' buttons to its rail, one panel open at a time', () => {
    offer('fu', 'Follow-ups');
    const { container } = render(<MvSidePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'calendar' }));
    expect(container.querySelector('[data-mv-side-panel="calendar"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Follow-ups' }));
    expect(container.querySelector('[data-mv-side-panel]')).toBeNull();
    expect(container.querySelector('[data-plugin-side-panel="fu"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'calendar' }));
    expect(container.querySelector('[data-plugin-side-panel]')).toBeNull();
    expect(container.querySelector('[data-mv-side-panel="calendar"]')).not.toBeNull();
  });

  it('draws no rail for a plugin panel without a button alone, and opens it on request', async () => {
    useCalendarStore.setState({ supportsCalendar: false } as never);
    const plugin = offer('fu', 'Follow-ups');
    const { container } = render(<MvSidePanel />);
    await act(async () => { await dispatchApiCall(plugin, 'ui.setSidePanel', [{ rail: false }]); });
    expect(container.querySelector('[data-mv-side-rail]')).toBeNull();
    await act(async () => { await dispatchApiCall(plugin, 'ui.setPanel', ['side-panel', 'open']); });
    expect(container.querySelector('[data-plugin-side-panel="fu"]')).not.toBeNull();
  });

  it('shows the rail for a plugin panel alone', () => {
    useCalendarStore.setState({ supportsCalendar: false } as never);
    offer('fu', 'Follow-ups');
    render(<MvSidePanel />);
    expect(screen.getByRole('button', { name: 'Follow-ups' })).toBeInTheDocument();
  });
});
