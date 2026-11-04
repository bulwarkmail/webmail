import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string, values?: Record<string, string>) => (values?.name ? `${key}:${values.name}` : key) }));
vi.mock('../plugin-iframe-slot', () => ({ PluginIframeSlot: () => <div data-testid="custom-frame" /> }));

import { PluginDialogHost } from '../plugin-dialog-host';
import { awaitCustomDialog, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';
import { POPOVER_GAP } from '@/lib/plugin-sandbox/dialog-anchor';

// A custom dialog with an anchor: a popover beside the control the user
// clicked, naming the plugin in one line, closed by Escape or a click outside.

beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
});

const anchor = { left: 100, top: 50, right: 124, bottom: 74 };

describe('a plugin dialog beside its trigger', () => {
  it('stands below the trigger, names the plugin, and has no centred backdrop', () => {
    render(<PluginDialogHost />);
    act(() => { void awaitCustomDialog({ pluginId: 'follow-ups', title: 'Follow up', message: '', slot: 'plugin-dialog', width: 320, anchor }); });

    const dialog = screen.getByRole('dialog', { name: 'Follow up' });
    expect(dialog).toHaveAttribute('data-plugin-dialog-popover');
    expect(dialog.className).not.toMatch(/bg-black/);
    expect(screen.getByTestId('custom-frame')).toBeInTheDocument();
    expect(dialog.querySelector('[data-plugin-dialog-source]')).toHaveTextContent('from_plugin:follow-ups');
    expect(screen.getByRole('button', { name: 'plugin_menu:follow-ups' })).toBeInTheDocument();
    const panel = dialog.querySelector<HTMLElement>('[data-plugin-dialog="follow-ups"]')!;
    expect(panel.style.left).toBe('100px');
    expect(panel.style.top).toBe(`${74 + POPOVER_GAP}px`);
    expect(panel.style.width).toContain('320px');
  });

  it('closes with null on a click outside', async () => {
    render(<PluginDialogHost />);
    let result: Promise<unknown>;
    act(() => { result = awaitCustomDialog({ pluginId: 'follow-ups', title: 'Follow up', message: '', slot: 'plugin-dialog', anchor }); });
    await act(async () => { fireEvent.mouseDown(screen.getByRole('dialog')); });
    await expect(result!).resolves.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes with null on Escape', async () => {
    render(<PluginDialogHost />);
    let result: Promise<unknown>;
    act(() => { result = awaitCustomDialog({ pluginId: 'follow-ups', title: 'Follow up', message: '', slot: 'plugin-dialog', anchor }); });
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    await expect(result!).resolves.toBeNull();
  });

  it('is the centred dialog without an anchor', () => {
    render(<PluginDialogHost />);
    act(() => { void awaitCustomDialog({ pluginId: 'follow-ups', title: 'Follow up', message: '', slot: 'plugin-dialog' }); });
    const dialog = screen.getByRole('dialog', { name: 'Follow up' });
    expect(dialog).not.toHaveAttribute('data-plugin-dialog-popover');
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();
  });
});
