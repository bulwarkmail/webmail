import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import type { InstalledPlugin } from '@/lib/plugin-types';

const evaluateShouldShow = vi.fn(async () => true);
let activePlugin: InstalledPlugin;
let hasShouldShow = false;

vi.mock('@/lib/plugin-sandbox/registry', () => ({
  get: () => ({
    plugin: activePlugin,
    code: '',
    tier: 'untrusted',
    background: { evaluateShouldShow },
    slotOffers: [
      { name: 'email-banner', hasShouldShow, order: 100 },
      { name: 'composer-sidebar-right', hasShouldShow: false, order: 100, fill: true },
      { name: 'toolbar-actions', hasShouldShow: false, order: 100 },
    ],
  }),
}));

const createSlotInstance = vi.fn(() => ({ destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn() }));
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: (...args: unknown[]) => createSlotInstance(...(args as [])),
}));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

import { PluginIframeSlot } from '../plugin-iframe-slot';

function plugin(perms: string[]): InstalledPlugin {
  return {
    id: 'p1', name: 'P', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const EMAIL = { id: 'm1', text: 'confidential body' };

beforeEach(() => {
  vi.clearAllMocks();
  hasShouldShow = false;
});

describe('PluginIframeSlot', () => {
  it('lets a panel frame fill its panel instead of growing with its content', async () => {
    activePlugin = plugin(['ui:composer-sidebar']);
    const { container } = render(<PluginIframeSlot pluginId="p1" slot="composer-sidebar-right" extraProps={{}} fill />);

    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const opts = (createSlotInstance.mock.calls[0] as unknown[])[0] as { fill?: boolean };
    expect(opts.fill).toBe(true);
    const wrapper = container.querySelector('[data-plugin-iframe-slot]') as HTMLElement;
    expect(wrapper.dataset.pluginIframeFill).toBe('true');
    expect(wrapper.style.flex).toBe('1 1 0%');
  });

  it('keeps a filling frame at its minimum height when it is given one', async () => {
    activePlugin = plugin(['ui:composer-sidebar']);
    const { container } = render(<PluginIframeSlot pluginId="p1" slot="composer-sidebar-right" extraProps={{}} fill minFillHeight={280} />);
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    expect((container.querySelector('[data-plugin-iframe-slot]') as HTMLElement).style.minHeight).toBe('280px');
  });

  it('mounts a banner-only plugin without the opened message', async () => {
    activePlugin = plugin(['ui:email-banner']);
    render(<PluginIframeSlot pluginId="p1" slot="email-banner" extraProps={{ email: EMAIL }} />);

    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const opts = (createSlotInstance.mock.calls[0] as unknown[])[0] as { extraProps: Record<string, unknown> };
    expect(opts.extraProps.email).toBeUndefined();
  });

  it('does not show the message to shouldShow either', async () => {
    activePlugin = plugin(['ui:email-banner']);
    hasShouldShow = true;
    render(<PluginIframeSlot pluginId="p1" slot="email-banner" extraProps={{ email: EMAIL }} />);

    await waitFor(() => expect(evaluateShouldShow).toHaveBeenCalled());
    expect((evaluateShouldShow.mock.calls[0] as unknown[])[1]).toEqual({});
  });

  it('hands the message to a plugin that may read mail', async () => {
    activePlugin = plugin(['ui:email-banner', 'email:read']);
    render(<PluginIframeSlot pluginId="p1" slot="email-banner" extraProps={{ email: EMAIL }} />);

    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const opts = (createSlotInstance.mock.calls[0] as unknown[])[0] as { extraProps: Record<string, unknown> };
    expect(opts.extraProps.email).toEqual(EMAIL);
  });
});

describe('PluginIframeSlot with nothing to show yet', () => {
  type SlotOptions = { onResize: (height: number, width?: number) => void };
  const reportSize = (height: number, width?: number) => act(() => {
    ((createSlotInstance.mock.calls[0] as unknown[])[0] as SlotOptions).onResize(height, width);
  });

  it.each([
    ['block', 'email-banner', ['ui:email-banner']],
    ['inline', 'toolbar-actions', ['ui:toolbar']],
  ] as const)('keeps a %s frame rendered and out of the Tab order until it reports a height', async (_kind, slot, perms) => {
    activePlugin = plugin([...perms]);
    const { container } = render(<PluginIframeSlot pluginId="p1" slot={slot} extraProps={{}} />);
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const wrapper = container.querySelector('[data-plugin-iframe-slot]') as HTMLElement;

    expect(wrapper).toHaveAttribute('inert');
    // Hidden, an isolated frame stops rendering and can never report the height that would unhide it.
    expect(wrapper.style.visibility).toBe('');

    reportSize(32, 100);
    expect(wrapper).not.toHaveAttribute('inert');
    expect(wrapper.style.height).toBe('32px');

    // Its content went away: nothing to land on again, still rendered.
    reportSize(0, 100);
    expect(wrapper).toHaveAttribute('inert');
    expect(wrapper.style.visibility).toBe('');
  });

  it('leaves a frame that fills its panel alone: its height never comes from the frame', async () => {
    activePlugin = plugin(['ui:composer-sidebar']);
    const { container } = render(<PluginIframeSlot pluginId="p1" slot="composer-sidebar-right" extraProps={{}} fill />);
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    expect(container.querySelector('[data-plugin-iframe-slot]')).not.toHaveAttribute('inert');
  });
});

describe('PluginIframeSlot re-renders', () => {
  it('does not ask shouldShow again or push props when a re-render brings equal props', async () => {
    activePlugin = plugin(['ui:email-banner', 'email:read']);
    hasShouldShow = true;
    // Callers that build props inline, like AppTopBannerSlot.
    const { rerender } = render(<PluginIframeSlot pluginId="p1" slot="email-banner" extraProps={{ email: EMAIL }} />);
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalledTimes(1));
    const instance = createSlotInstance.mock.results[0].value as { updateProps: ReturnType<typeof vi.fn> };
    const pushes = instance.updateProps.mock.calls.length;

    for (let i = 0; i < 5; i++) rerender(<PluginIframeSlot pluginId="p1" slot="email-banner" extraProps={{ email: EMAIL }} />);
    await new Promise((r) => setTimeout(r, 0));

    expect(evaluateShouldShow).toHaveBeenCalledTimes(1);
    expect(instance.updateProps.mock.calls.length).toBe(pushes);
    expect(createSlotInstance).toHaveBeenCalledTimes(1);
  });

  it('still passes on props whose values changed', async () => {
    activePlugin = plugin(['ui:email-banner', 'email:read']);
    const { rerender } = render(<PluginIframeSlot pluginId="p1" slot="email-banner" extraProps={{ email: EMAIL }} />);
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalledTimes(1));
    const instance = createSlotInstance.mock.results[0].value as { updateProps: ReturnType<typeof vi.fn> };

    const next = { id: 'm2', text: 'other' };
    rerender(<PluginIframeSlot pluginId="p1" slot="email-banner" extraProps={{ email: next }} />);

    await waitFor(() => expect(instance.updateProps).toHaveBeenLastCalledWith({ email: next }));
  });
});
