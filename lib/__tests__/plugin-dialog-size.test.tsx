// api.ui.confirm, alert, prompt and openDialog need no permission. Title, message, button labels and
// the list of prompt fields go into the host's dialog, and the host renders all of it in its own
// document (one element per "**" piece of the message, three per field).
//
// The rule: what a plugin hands the host to draw is cut to a size a dialog can show, before the
// dialog is queued, so a plugin that passes a long text keeps working.
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import type { InstalledPlugin } from '../plugin-types';

vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({ createSlotInstance: vi.fn() }));

import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { awaitDialog, head, resetDialogLimits, resolveHead, type DialogRequest } from '../plugin-sandbox/host-dialog';
import { PluginDialogHost } from '@/components/plugins/plugin-dialog-host';

const MAX_TITLE = 1000;
const MAX_MESSAGE = 20_000;
const MAX_LABEL = 500;
const MAX_FIELDS = 100;

let serial = 0;
function plugin(): InstalledPlugin {
  serial += 1;
  return {
    id: `p${serial}`, name: 'P', version: '1.0.0', author: '', description: '', type: 'hook',
    permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, managed: true,
  };
}

/** The dialog a call queued, or null when the host refused the call. */
async function queued(method: string, options: unknown): Promise<DialogRequest | null> {
  const call = dispatchApiCall(plugin(), method, [options]);
  let refused = false;
  call.catch(() => { refused = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return refused ? null : head();
}

beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
});

describe('the size of what a plugin dialog draws', () => {
  it.each(['ui.confirm', 'ui.alert', 'ui.prompt'])('%s: a message of a megabyte is cut or refused', async (method) => {
    const dialog = await queued(method, { title: 't', message: 'a**'.repeat(350_000) });
    if (dialog) expect(dialog.message.length).toBeLessThanOrEqual(MAX_MESSAGE);
  });

  it.each(['ui.confirm', 'ui.alert', 'ui.prompt', 'ui.openDialog'])('%s: a title of megabytes is cut or refused', async (method) => {
    const dialog = await queued(method, { title: 'T'.repeat(2 * 1024 * 1024), message: 'm', slot: 'plugin-dialog' });
    if (dialog) expect(dialog.title.length).toBeLessThanOrEqual(MAX_TITLE);
  });

  it('ui.confirm: button labels are cut or refused', async () => {
    const dialog = await queued('ui.confirm', { title: 't', confirmLabel: 'Y'.repeat(100_000), cancelLabel: 'N'.repeat(100_000) });
    if (dialog) {
      expect((dialog.confirmLabel ?? '').length).toBeLessThanOrEqual(MAX_LABEL);
      expect((dialog.cancelLabel ?? '').length).toBeLessThanOrEqual(MAX_LABEL);
    }
  });

  it('ui.prompt: thousands of fields are cut or refused, and so are their labels', async () => {
    const fields = Array.from({ length: 20_000 }, (_, i) => ({ name: `f${i}`, label: 'L'.repeat(5000), placeholder: 'P'.repeat(5000) }));
    const dialog = await queued('ui.prompt', { title: 't', fields });
    if (dialog) {
      expect((dialog.fields ?? []).length).toBeLessThanOrEqual(MAX_FIELDS);
      for (const field of dialog.fields ?? []) {
        expect(field.label.length).toBeLessThanOrEqual(MAX_LABEL);
        expect((field.placeholder ?? '').length).toBeLessThanOrEqual(MAX_LABEL);
      }
    }
  });

  it('cuts rather than refuses: a long text still opens the dialog, with its start', async () => {
    const message = `Found 3 problems:\n${'- an IBAN in the text\n'.repeat(2000)}`;
    const dialog = await queued('ui.confirm', { title: 'Send anyway?', message });
    expect(dialog).toBeTruthy();
    expect(dialog!.message.startsWith('Found 3 problems:\n- an IBAN in the text')).toBe(true);
  });

  it('ui.openDialog: a width outside a sensible range is brought into it', async () => {
    for (const [width, inRange] of [[1e9, (w: number) => w <= 1200], [-50, (w: number) => w >= 280], [0, (w: number) => w >= 280]] as const) {
      while (head()) resolveHead(null);
      const dialog = await queued('ui.openDialog', { title: 't', slot: 'plugin-dialog', width });
      expect(dialog).toBeTruthy();
      expect(inRange(dialog!.width!)).toBe(true);
    }
    while (head()) resolveHead(null);
    expect((await queued('ui.openDialog', { title: 't', slot: 'plugin-dialog', width: Number.NaN }))!.width).toBeUndefined();
    while (head()) resolveHead(null);
    expect((await queued('ui.openDialog', { title: 't', slot: 'plugin-dialog', width: 640 }))!.width).toBe(640);
  });

  it('ui.prompt: a field\'s value and a select field\'s options are not carried into the dialog', async () => {
    const dialog = await queued('ui.prompt', {
      title: 't',
      fields: [{ name: 'f', label: 'L', value: 'V'.repeat(1_000_000), options: Array.from({ length: 100_000 }, (_, i) => `option ${i}`) }],
    });
    expect(dialog).toBeTruthy();
    expect(dialog!.fields).toEqual([{ name: 'f', label: 'L', type: 'text', placeholder: undefined, required: false }]);
  });

  it('takes nothing but text where text is expected', async () => {
    const huge = Array.from({ length: 200_000 }, () => 'x');
    const dialog = await queued('ui.prompt', {
      title: { toString: 'not a title' }, message: huge, confirmLabel: { a: 1 },
      fields: [null, 'f', { name: { a: 1 }, label: 'Nested name' }, { name: 'ok', label: ['L'], placeholder: { p: 1 } }],
    });
    expect(dialog).toBeTruthy();
    expect(dialog!.title).toBe('P');
    expect(dialog!.message).toBe('');
    expect(dialog!.confirmLabel).toBeUndefined();
    expect(dialog!.fields).toEqual([{ name: 'ok', label: '', type: 'text', placeholder: undefined, required: false }]);
  });

  it('an ordinary question still goes through as written (a control)', async () => {
    const dialog = await queued('ui.confirm', { title: 'Send anyway?', message: 'The message has **3** attachments.', confirmLabel: 'Send' });
    expect(dialog).toBeTruthy();
    expect(dialog!.title).toBe('Send anyway?');
    expect(dialog!.message).toBe('The message has **3** attachments.');
    expect(dialog!.confirmLabel).toBe('Send');
  });

  it('an ordinary prompt keeps its fields as written (a control)', async () => {
    const dialog = await queued('ui.prompt', {
      title: 'Sign in', fields: [{ name: 'user', label: 'User name', placeholder: 'name@example.org', required: true }, { name: 'pw', label: 'Password', type: 'password' }],
    });
    expect(dialog!.fields).toEqual([
      { name: 'user', label: 'User name', type: 'text', placeholder: 'name@example.org', required: true },
      { name: 'pw', label: 'Password', type: 'password', placeholder: undefined, required: false },
    ]);
  });
});

describe('how the host draws a plugin dialog\'s message', () => {
  function show(message: string) {
    render(<PluginDialogHost />);
    act(() => { void awaitDialog({ pluginId: 'p', kind: 'alert', title: 'Notice', message }); });
    return document.querySelector('[role="dialog"]')!;
  }

  it('stops pairing ** after a few dozen pieces and shows the rest as written', () => {
    const dialog = show('**'.repeat(10_000));
    expect(dialog.querySelectorAll('strong').length).toBeLessThanOrEqual(32);
    expect(dialog.querySelectorAll('*').length).toBeLessThan(200);
    expect(dialog.textContent).toContain('****');
  });

  it('still draws **bold** in an ordinary message (a control)', () => {
    const dialog = show('The message has **3** attachments and **2** links.');
    expect([...dialog.querySelectorAll('strong')].map((el) => el.textContent)).toEqual(['3', '2']);
    expect(dialog.textContent).toContain('The message has 3 attachments and 2 links.');
  });
});
