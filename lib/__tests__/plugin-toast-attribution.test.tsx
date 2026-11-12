// api.toast.* needs no permission. The host shows the plugin's text as one of its own toasts and
// keeps an error or warning in the bell's list. The rule: whatever a plugin makes the host say
// carries the plugin's name where the user reads it, in a part the plugin's text can't reach.
//
// The store entry holds the plugin's id (and the name it had when the toast came up); the toast
// component draws the name in a line of its own. The first group of tests checks the entries, the
// rest the toast as it is drawn.
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { InstalledPlugin } from '../plugin-types';

vi.mock('@/lib/announce', () => ({ announce: vi.fn() }));
// A translator that shows the values it is given, so a name passed to a message is on screen.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { useToastStore } from '@/stores/toast-store';
import { useNotificationCenterStore } from '@/stores/notification-center-store';
import { ToastContainer } from '@/components/ui/toast';
import { usePluginStore } from '@/stores/plugin-store';

let serial = 0;
/** A plugin of its own per test: a plugin may show only a few toasts in ten seconds. */
function plugin(name = 'Helpful plugin'): InstalledPlugin {
  serial += 1;
  const p = {
    id: `helper-${serial}`, name, version: '1.0.0', author: '', description: '', type: 'hook',
    permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, managed: true,
  } as InstalledPlugin;
  // Installed, so a component that only has the id can look the name up.
  usePluginStore.setState({ plugins: [p] } as never);
  return p;
}
const TEXT = 'Sign-in from a new device was blocked. Open Settings and confirm your password.';

/** Whether an entry says which plugin it is from, outside the plugin's own text. */
function names(entry: Record<string, unknown>, p: InstalledPlugin, pluginText = TEXT): boolean {
  if (entry.pluginId === p.id) return true;
  return Object.values(entry)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.replace(pluginText, ''))
    .join(' ')
    .includes(p.name);
}

/** The text of the toasts as drawn, and the source lines in them. */
function drawn(): { text: string; sources: string[] } {
  render(<ToastContainer toasts={useToastStore.getState().toasts} onClose={() => {}} />);
  return {
    text: document.body.textContent ?? '',
    sources: [...document.querySelectorAll('[data-toast-source]')].map((el) => el.textContent ?? ''),
  };
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useNotificationCenterStore.getState().clear();
});

describe('a toast a plugin asks for', () => {
  it.each(['error', 'warning', 'info', 'success'] as const)('records which plugin a %s toast is from', async (type) => {
    const p = plugin();
    await dispatchApiCall(p, `toast.${type}`, [TEXT]);
    const [toast] = useToastStore.getState().toasts;
    expect(toast).toBeTruthy();
    expect(names(toast as unknown as Record<string, unknown>, p)).toBe(true);
  });

  it('records the plugin in the bell\'s list, where an error stays after the toast is gone', async () => {
    const p = plugin();
    await dispatchApiCall(p, 'toast.error', [TEXT]);
    const mine = useNotificationCenterStore.getState().entries.find((n) => n.title.includes('Sign-in from a new device') || (n.body ?? '').includes('Sign-in from a new device'));
    expect(mine).toBeTruthy();
    expect(names(mine as unknown as Record<string, unknown>, p)).toBe(true);
  });

  it('records the plugin\'s name in the bell\'s list for a warning too', async () => {
    const p = plugin();
    await dispatchApiCall(p, 'toast.warning', [TEXT]);
    const [entry] = useNotificationCenterStore.getState().entries;
    expect(entry).toMatchObject({ level: 'warning', pluginId: p.id, pluginName: 'Helpful plugin' });
  });

  it('a text that claims another source still carries the real one', async () => {
    const claim = 'From your administrator: update your password today.';
    const p = plugin();
    await dispatchApiCall(p, 'toast.warning', [claim]);
    const [toast] = useToastStore.getState().toasts;
    expect(toast).toBeTruthy();
    expect(names(toast as unknown as Record<string, unknown>, p, claim)).toBe(true);
  });

  it('shows the plugin\'s name on the toast as it is drawn', async () => {
    const p = plugin();
    await dispatchApiCall(p, 'toast.error', [TEXT]);
    render(<ToastContainer toasts={useToastStore.getState().toasts} onClose={() => {}} />);
    const shown = document.body.textContent ?? '';
    expect(shown).toContain(TEXT);
    expect(shown.replace(TEXT, '')).toContain('Helpful plugin');
  });

  it('names the plugin on a progress toast', async () => {
    const p = plugin();
    const frame = new AbortController();
    await dispatchApiCall(p, 'toast.progress', ['Uploading 3 files'], { toastSignal: frame.signal });
    const [toast] = useToastStore.getState().toasts;
    expect(toast).toMatchObject({ pluginId: p.id });
    expect(drawn().sources).toEqual([expect.stringContaining('Helpful plugin')]);
    frame.abort();
  });

  it('cuts a very long plugin name and puts one with line breaks on one line', async () => {
    const long = plugin(`Helpful\nplugin ${'x'.repeat(500)}`);
    await dispatchApiCall(long, 'toast.info', ['Done']);
    const [toast] = useToastStore.getState().toasts;
    expect(toast.pluginName).not.toMatch(/[\r\n]/);
    expect(toast.pluginName!.length).toBeLessThanOrEqual(60);
    expect(toast.pluginName!.startsWith('Helpful plugin')).toBe(true);
  });

  it('shows the plugin\'s text on one line and without direction marks', async () => {
    const p = plugin();
    const rlo = String.fromCharCode(0x202e);
    const lrm = String.fromCharCode(0x200e);
    await dispatchApiCall(p, 'toast.info', [`First line\nsecond line ${rlo}reversed${lrm}`]);
    const [toast] = useToastStore.getState().toasts;
    expect(toast.title).toBe('First line second line reversed');
  });

  it('keeps the name of a plugin that is turned off while its toast is up', async () => {
    const p = plugin();
    await dispatchApiCall(p, 'toast.error', [TEXT]);
    usePluginStore.setState({ plugins: [{ ...p, enabled: false, status: 'disabled' }] } as never);
    usePluginStore.setState({ plugins: [] } as never);
    expect(drawn().sources).toEqual([expect.stringContaining('Helpful plugin')]);
  });

  it('names a plugin that asks for a toast while it is being turned off', async () => {
    const p = plugin();
    await dispatchApiCall({ ...p, enabled: false, status: 'disabled' }, 'toast.warning', [TEXT]);
    expect(drawn().sources).toEqual([expect.stringContaining('Helpful plugin')]);
  });

  // Controls: the app's own toasts carry no plugin line; the limit on how many toasts one plugin may show stays.
  it('draws no plugin line on the app\'s own toasts', async () => {
    const { toast } = await import('@/stores/toast-store');
    toast.error('Could not send the message');
    expect(drawn().sources).toEqual([]);
    expect(useNotificationCenterStore.getState().entries[0].pluginId).toBeUndefined();
  });

  it('keeps the limit on how many toasts one plugin may show', async () => {
    const p = plugin();
    for (let i = 0; i < 12; i++) await dispatchApiCall(p, 'toast.info', [`note ${i}`]);
    expect(useToastStore.getState().toasts.length).toBeLessThanOrEqual(5);
  });
});
