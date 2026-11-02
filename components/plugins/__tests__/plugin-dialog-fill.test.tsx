import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// A plugin dialog that asks to be filled (api.ui.openDialog({ fill: true })):
// its frame takes the dialog's height, which follows what the window shows,
// so a chat's input stays in view on a phone with the keyboard up.

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('../plugin-iframe-slot', () => ({
  PluginIframeSlot: ({ fill }: { fill?: boolean }) => <div data-testid="custom-frame" data-fill={fill ? 'true' : 'false'} />,
}));

import { PluginDialogHost } from '../plugin-dialog-host';
import { awaitCustomDialog, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';
import { isFillableSlot } from '@/lib/plugin-sandbox/slot-layout';

let listeners: (() => void)[] = [];
const viewport = { height: 667, addEventListener: (_: string, fn: () => void) => { listeners.push(fn); }, removeEventListener: () => {} };

beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
  listeners = [];
  vi.stubGlobal('visualViewport', viewport);
  viewport.height = 667;
});
afterEach(() => vi.unstubAllGlobals());

const box = () => document.querySelector<HTMLElement>('[data-plugin-dialog]')!;

describe('a plugin dialog that fills', () => {
  it('fills the dialog, which fits the visible window and follows the keyboard', () => {
    expect(isFillableSlot('plugin-dialog')).toBe(true);
    render(<PluginDialogHost />);
    act(() => { void awaitCustomDialog({ pluginId: 'ai', title: 'AI assistant', message: '', slot: 'plugin-dialog', fill: true }); });
    expect(screen.getByTestId('custom-frame').dataset.fill).toBe('true');
    // 667 px window: 90 % less the margin, at most 640.
    expect(box().style.height).toBe('584px');
    // The keyboard comes up: 360 px left.
    act(() => { viewport.height = 360; for (const fn of listeners) fn(); });
    expect(box().style.height).toBe('308px');
    act(() => resolveHead(null));
  });

  it('grows with its content as before without fill', () => {
    render(<PluginDialogHost />);
    act(() => { void awaitCustomDialog({ pluginId: 'ai', title: 'AI assistant', message: '', slot: 'plugin-dialog' }); });
    expect(screen.getByTestId('custom-frame').dataset.fill).toBe('false');
    expect(box().style.height).toBe('');
    expect(box().style.maxHeight).toBe('90vh');
    act(() => resolveHead(null));
  });

  it('is what api.ui.openDialog asks for with fill: true', async () => {
    const { dispatchApiCall } = await import('@/lib/plugin-sandbox/host-api');
    const plugin = { id: 'ai', name: 'AI', permissions: [], managed: true } as never;
    void dispatchApiCall(plugin, 'ui.openDialog', [{ slot: 'plugin-dialog', title: 'AI assistant', fill: true }]);
    await vi.waitFor(() => expect(head()?.fill).toBe(true));
    resolveHead(null);
    void dispatchApiCall(plugin, 'ui.openDialog', [{ slot: 'plugin-dialog', title: 'AI assistant' }]);
    await vi.waitFor(() => expect(head()).toBeTruthy());
    expect(head()?.fill).toBeUndefined();
    resolveHead(null);
  }, 30_000);
});
