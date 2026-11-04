import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// In the desktop app a plugin's confirm or alert is a window of its own. The host
// names the plugin there, the plugin's text stays text, and the ⋮ menu still
// turns the plugin off. Prompts stay in the page.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: { name?: string }) => (values?.name ? `${key}:${values.name}` : key),
}));
vi.mock('../plugin-iframe-slot', () => ({ PluginIframeSlot: () => null }));

import { PluginDialogHost } from '../plugin-dialog-host';
import { awaitDialog, awaitPrompt, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';
import { usePluginStore } from '@/stores/plugin-store';
import type { BulwarkDesktopBridge, DesktopDialogWindowAnswer, DesktopDialogWindowRequest } from '@/lib/desktop/types';

type Show = (request: DesktopDialogWindowRequest) => Promise<DesktopDialogWindowAnswer>;
let answer: (value: DesktopDialogWindowAnswer) => void;
let show: ReturnType<typeof vi.fn<Show>>;
let disablePlugin: ReturnType<typeof vi.fn>;

beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
  show = vi.fn<Show>(() => new Promise((resolve) => (answer = resolve)));
  window.bulwarkDesktop = { version: 1, platform: 'win32', dialogs: { confirm: vi.fn(), show, cancel: vi.fn() } } as unknown as BulwarkDesktopBridge;
  disablePlugin = vi.fn();
  usePluginStore.setState({ plugins: [{ id: 'elw', name: 'External Link Warning' }] as never, disablePlugin } as never);
});

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

const LINK = {
  pluginId: 'elw',
  kind: 'confirm' as const,
  title: 'Open external link?',
  message: 'You\'re about to visit **github.com**.\n<img src=x onerror=alert(1)>',
  confirmLabel: 'Continue',
};

describe('plugin dialogs in the desktop app', () => {
  it('asks in a window with the plugin named in the host\'s line and its text as text', async () => {
    render(<PluginDialogHost />);
    let result: Promise<boolean>;
    act(() => { result = awaitDialog(LINK); });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toMatchObject({
      title: 'Open external link?',
      source: 'from_plugin:External Link Warning',
      message: [{ text: 'You\'re about to visit ' }, { text: 'github.com', bold: true }, { text: '.\n<img src=x onerror=alert(1)>' }],
      buttons: [{ label: 'cancel', variant: 'secondary' }, { label: 'Continue', variant: 'primary' }],
      defaultIndex: 1,
      menu: { label: 'plugin_menu:External Link Warning', items: [{ id: 'turn-off', label: 'turn_off:External Link Warning', destructive: true }] },
    });

    await act(async () => answer({ button: 1 }));
    await expect(result!).resolves.toBe(true);
    expect(head()).toBeNull();
  });

  it('Cancel or Escape is no; "Turn off" in the menu turns the plugin off', async () => {
    render(<PluginDialogHost />);
    let result: Promise<boolean>;
    act(() => { result = awaitDialog(LINK); });
    await act(async () => answer(null));
    await expect(result!).resolves.toBe(false);

    act(() => { result = awaitDialog(LINK); });
    await act(async () => answer({ menu: 'turn-off' }));
    await expect(result!).resolves.toBe(false);
    expect(disablePlugin).toHaveBeenCalledWith('elw');
  });

  it('an alert has one button, and a destructive confirm starts on Cancel', async () => {
    render(<PluginDialogHost />);
    act(() => { void awaitDialog({ pluginId: 'elw', kind: 'alert', title: 'Done', message: '' }); });
    expect(show.mock.calls[0][0]).toMatchObject({ buttons: [{ label: 'ok', variant: 'primary' }], defaultIndex: 0 });
    await act(async () => answer({ button: 0 }));

    act(() => { void awaitDialog({ ...LINK, danger: true }); });
    expect(show.mock.calls[1][0]).toMatchObject({ buttons: [{}, { variant: 'destructive' }], defaultIndex: 0 });
  });

  it('a prompt stays in the page', () => {
    render(<PluginDialogHost />);
    act(() => { void awaitPrompt({ pluginId: 'elw', kind: 'prompt', title: 'Name?', message: '', fields: [{ name: 'n', label: 'Name' }] }); });
    expect(show).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Name?' })).toBeTruthy();
  });

  it('a plugin that goes takes its window with it', () => {
    render(<PluginDialogHost />);
    act(() => { void awaitDialog(LINK); });
    const cancel = window.bulwarkDesktop!.dialogs!.cancel as ReturnType<typeof vi.fn>;
    act(() => resolveHead(false));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
