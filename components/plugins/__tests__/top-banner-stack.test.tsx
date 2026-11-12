// The plugins' top banners together take at most 30 % of the window's height. The first banner
// always shows; the rest wait behind a host-drawn control that names their plugins and shows them
// all on request. One plugin gets one frame per slot, and a slot that isn't made to fill its
// panel never does, whatever the registry holds.
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));

// Each banner reports the height given here, as the real frame does once it has drawn.
const reported = vi.hoisted(() => ({ heights: {} as Record<string, number> }));
vi.mock('@/components/plugins/plugin-iframe-slot', () => ({
  PluginIframeSlot: ({ pluginId, slot, fill, onHeightChange }: { pluginId: string; slot: string; fill?: boolean; onHeightChange?: (h: number) => void }) => {
    React.useEffect(() => { onHeightChange?.(reported.heights[pluginId] ?? 0); });
    return <div data-plugin-iframe-slot={`${pluginId}:${slot}`} data-plugin-iframe-fill={fill || undefined} />;
  },
}));

import { PluginSlot } from '@/components/plugins/plugin-slot';
import { register, deregister, type ActivePlugin } from '@/lib/plugin-sandbox/registry';
import type { SlotName } from '@/lib/plugin-types';

const registered: string[] = [];
function offer(pluginId: string, slots: Array<{ name: SlotName; fill?: boolean }>) {
  register({
    plugin: { id: pluginId, name: `Plugin ${pluginId}` },
    code: '', tier: 'untrusted', background: {},
    slotOffers: slots.map((s) => ({ name: s.name, order: 100, hasShouldShow: false, ...(s.fill ? { fill: true } : {}) })),
    hookDisposables: [],
  } as unknown as ActivePlugin);
  registered.push(pluginId);
}

function banners(): string[] {
  return [...document.querySelectorAll('[data-plugin-iframe-slot$=":app-top-banner"]')].map((el) => el.getAttribute('data-plugin-iframe-slot')!.split(':')[0]);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  reported.heights = {};
});
afterEach(() => {
  cleanup();
  for (const id of registered.splice(0)) deregister(id);
});

describe('the plugins\' top banners together', () => {
  it('take at most 30 % of the window and name the plugins of the rest', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      offer(id, [{ name: 'app-top-banner' }]);
      reported.heights[id] = 120;
    }
    render(<PluginSlot name="app-top-banner" />);

    // 30 % of 844 px is 253 px: two banners of 120 px.
    expect(banners()).toEqual(['a', 'b']);
    const more = screen.getByRole('button', { name: /^banners_more 3 Plugin c, Plugin d, Plugin e$/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    expect(banners()).toEqual(['a', 'b', 'c', 'd', 'e']);
    fireEvent.click(screen.getByRole('button', { name: 'banners_fewer' }));
    expect(banners()).toEqual(['a', 'b']);
  });

  it('shows the first banner however small the window', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
    offer('a', [{ name: 'app-top-banner' }]);
    offer('b', [{ name: 'app-top-banner' }]);
    reported.heights = { a: 120, b: 40 };
    render(<PluginSlot name="app-top-banner" />);
    expect(banners()).toEqual(['a']);
    expect(screen.getByRole('button', { name: /^banners_more 1 Plugin b$/ })).toBeTruthy();
  });

  it('shows thin banners together without the control', () => {
    for (const id of ['a', 'b', 'c']) {
      offer(id, [{ name: 'app-top-banner' }]);
      reported.heights[id] = 40;
    }
    render(<PluginSlot name="app-top-banner" />);
    expect(banners()).toEqual(['a', 'b', 'c']);
    expect(screen.queryByRole('button', { name: /^banners_more/ })).toBeNull();
  });

  it('draws one banner frame per plugin, however often its offer is listed', () => {
    act(() => offer('a', [{ name: 'app-top-banner' }, { name: 'app-top-banner' }, { name: 'app-top-banner' }]));
    render(<PluginSlot name="app-top-banner" />);
    expect(banners()).toEqual(['a']);
  });
});

describe('a slot that isn\'t made to fill its panel', () => {
  it('doesn\'t fill it, whatever the registry holds', () => {
    offer('a', [{ name: 'email-banner', fill: true }]);
    const { container } = render(<PluginSlot name="email-banner" />);
    expect(container.querySelector('[data-plugin-iframe-fill]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-plugin-slot="email-banner"]')!.className).not.toMatch(/\bh-full\b/);
  });

  // Control: a panel made to be filled still is.
  it('still fills a panel slot made for that', () => {
    offer('a', [{ name: 'side-panel', fill: true }]);
    const { container } = render(<PluginSlot name="side-panel" />);
    expect(container.querySelector('[data-plugin-iframe-fill]')).not.toBeNull();
  });
});
