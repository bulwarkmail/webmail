import { cleanup, render, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

const createSlotInstance = vi.fn((..._args: unknown[]) => ({ destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn() }));
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: (...args: unknown[]) => createSlotInstance(...args),
}));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

const { PluginTaskView, usePluginTaskView } = await import('../plugin-task-view');
const registry = await import('@/lib/plugin-sandbox/registry');

function offer(id: string, opts: { slot?: string; fill?: boolean; permissions?: InstalledPlugin['permissions'] } = {}) {
  const permissions = opts.permissions ?? ['ui:tasks', 'tasks:read'];
  const plugin: InstalledPlugin = {
    id, name: id, version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions, grantedPermissions: permissions, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  registry.register({
    plugin,
    code: '',
    tier: 'untrusted',
    background: { evaluateShouldShow: vi.fn(async () => true) } as never,
    slotOffers: [{ name: (opts.slot ?? 'calendar-task-view') as never, order: 100, hasShouldShow: false, ...(opts.fill ? { fill: true } : {}) }],
    hookDisposables: [],
  });
}

/** The task view's list area as calendar-app draws it. */
function TaskArea({ calendarIds = ['c1', 'c2'] }: { calendarIds?: string[] }) {
  const view = usePluginTaskView();
  if (!view) return <div data-testid="bulwark-task-list" />;
  return <PluginTaskView pluginId={view.pluginId} fill={view.fill} filter="pending" calendarIds={calendarIds} />;
}

beforeEach(() => { createSlotInstance.mockClear(); });

afterEach(() => {
  cleanup();
  for (const p of registry.all()) registry.deregister(p.plugin.id);
});

describe('calendar-task-view', () => {
  it('leaves Bulwark\'s list while no plugin offers the slot', () => {
    offer('other', { slot: 'task-detail-section' });
    const { getByTestId, container } = render(<TaskArea />);
    expect(createSlotInstance).not.toHaveBeenCalled();
    expect(getByTestId('bulwark-task-list')).toBeInTheDocument();
    expect(container.querySelector('[data-plugin-task-view]')).toBeNull();
  });

  it('draws the first plugin offering it, filled, with the toolbar\'s filter and the shown calendars', async () => {
    offer('follow-ups', { fill: true });
    offer('second');
    const { container, queryByTestId } = render(<TaskArea />);
    expect(queryByTestId('bulwark-task-list')).toBeNull();
    expect(container.querySelectorAll('[data-plugin-task-view]')).toHaveLength(1);
    expect(container.querySelector('[data-plugin-task-view]')).toHaveAttribute('data-plugin-task-view', 'follow-ups');
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalledTimes(1));
    const opts = createSlotInstance.mock.calls[0][0] as { slot: string; extraProps: Record<string, unknown>; fill?: boolean };
    expect(opts.slot).toBe('calendar-task-view');
    expect(opts.fill).toBe(true);
    expect(opts.extraProps).toEqual({ filter: 'pending', calendarIds: ['c1', 'c2'] });
    expect(container.querySelector('[data-plugin-iframe-fill]')).not.toBeNull();
  });

  it('hands the calendars only to a plugin that reads tasks', async () => {
    offer('looks', { permissions: ['ui:tasks'] });
    render(<TaskArea />);
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const opts = createSlotInstance.mock.calls[0][0] as { extraProps: Record<string, unknown> };
    expect(opts.extraProps).toEqual({ filter: 'pending' });
  });

  it('lets the area scroll for a plugin that does not fill it', async () => {
    offer('plain');
    const { container } = render(<TaskArea />);
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    expect(container.querySelector('[data-plugin-task-view]')?.className).toContain('overflow-y-auto');
  });
});
