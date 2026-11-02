import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { head, resetDialogLimits, resolveHead } from '../plugin-sandbox/host-dialog';
import {
  forgetTrigger, noteTrigger, placePopover, trackTriggers, triggerAnchor, POPOVER_GAP, POPOVER_MARGIN, TRIGGER_WINDOW_MS,
} from '../plugin-sandbox/dialog-anchor';

// api.ui.openDialog({ anchor: 'trigger' }): the dialog beside the control the
// user activated last, when that was a moment ago.

function plugin(): InstalledPlugin {
  return {
    id: 'p1', name: 'Plugin One', version: '1.0.0', author: '', description: '', type: 'hook',
    permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, managed: true,
  };
}

/** A control on the page standing at this rect. */
function control(html: string, rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  const el = host.querySelector<HTMLElement>('[data-at]') ?? host.firstElementChild as HTMLElement;
  el.getBoundingClientRect = () => ({
    left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height,
    width: rect.width, height: rect.height, x: rect.left, y: rect.top, toJSON: () => ({}),
  });
  return el;
}

let stop: () => void = () => {};
beforeEach(() => {
  forgetTrigger();
  resetDialogLimits();
  while (head()) resolveHead(null);
  stop = trackTriggers();
});
afterEach(() => {
  stop();
  document.body.innerHTML = '';
});

describe('the trigger a dialog opens beside', () => {
  it('is the button under the pointer, measured again when the dialog opens', () => {
    const button = control('<button data-at><span>Follow up</span></button>', { left: 100, top: 50, width: 24, height: 24 });
    button.querySelector('span')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 110, clientY: 60 }));
    expect(triggerAnchor()).toEqual({ left: 100, top: 50, right: 124, bottom: 74 });
  });

  it('is the point a menu entry was chosen at, the menu being gone', () => {
    const entry = control('<div role="menu"><div role="menuitem" data-at>Follow up</div></div>', { left: 300, top: 200, width: 180, height: 28 });
    entry.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 320, clientY: 210 }));
    entry.parentElement!.remove();
    expect(triggerAnchor()).toEqual({ left: 320, top: 210, right: 320, bottom: 210 });
  });

  it('is the focused control on Enter, and nothing after another key', () => {
    const button = control('<button data-at>Flag</button>', { left: 10, top: 20, width: 20, height: 20 });
    button.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(triggerAnchor()).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    expect(triggerAnchor()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }));
    expect(triggerAnchor()).toBeNull();
  });

  it('is forgotten after the window', () => {
    const button = control('<button data-at>Flag</button>', { left: 10, top: 20, width: 20, height: 20 });
    noteTrigger(button, undefined, 1000);
    expect(triggerAnchor(1000 + TRIGGER_WINDOW_MS)).not.toBeNull();
    expect(triggerAnchor(1001 + TRIGGER_WINDOW_MS)).toBeNull();
  });

  it('keeps its rect when the control has gone', () => {
    const button = control('<button data-at>Flag</button>', { left: 10, top: 20, width: 20, height: 20 });
    noteTrigger(button);
    button.remove();
    expect(triggerAnchor()).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
  });
});

describe('placePopover', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 320, height: 200 };

  it('stands below the anchor, at its start', () => {
    expect(placePopover({ left: 100, top: 50, right: 124, bottom: 74 }, size, viewport))
      .toEqual({ left: 100, top: 74 + POPOVER_GAP });
  });

  it('lines up with the end in RTL', () => {
    expect(placePopover({ left: 600, top: 50, right: 624, bottom: 74 }, size, viewport, true).left).toBe(624 - 320);
  });

  it('goes above when it does not fit below', () => {
    expect(placePopover({ left: 100, top: 700, right: 124, bottom: 724 }, size, viewport).top).toBe(700 - POPOVER_GAP - 200);
  });

  it('stays inside the window', () => {
    expect(placePopover({ left: 950, top: 10, right: 980, bottom: 30 }, size, viewport).left).toBe(1000 - POPOVER_MARGIN - 320);
    expect(placePopover({ left: 100, top: 300, right: 100, bottom: 300 }, { width: 320, height: 700 }, viewport).top)
      .toBe(800 - POPOVER_MARGIN - 700);
  });
});

describe("ui.openDialog's anchor", () => {
  it("is the trigger's place when the plugin asks for it", async () => {
    const button = control('<button data-at>Follow up</button>', { left: 100, top: 50, width: 24, height: 24 });
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 110, clientY: 60 }));
    const result = dispatchApiCall(plugin(), 'ui.openDialog', [{ slot: 'plugin-dialog', anchor: 'trigger', width: 320 }]);
    await vi.waitFor(() => expect(head()).not.toBeNull());
    expect(head()?.anchor).toEqual({ left: 100, top: 50, right: 124, bottom: 74 });
    resolveHead(null);
    await expect(result).resolves.toBeNull();
  });

  it('is none without the option, without a trigger, or with a place the plugin names', async () => {
    const button = control('<button data-at>Follow up</button>', { left: 100, top: 50, width: 24, height: 24 });
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    for (const opts of [{ slot: 'plugin-dialog' }, { slot: 'plugin-dialog', anchor: { left: 0, top: 0, right: 0, bottom: 0 } }]) {
      const result = dispatchApiCall(plugin(), 'ui.openDialog', [opts]);
      await vi.waitFor(() => expect(head()).not.toBeNull());
      expect(head()?.anchor).toBeUndefined();
      resolveHead(null);
      await result;
    }
    forgetTrigger();
    const result = dispatchApiCall(plugin(), 'ui.openDialog', [{ slot: 'plugin-dialog', anchor: 'trigger' }]);
    await vi.waitFor(() => expect(head()).not.toBeNull());
    expect(head()?.anchor).toBeUndefined();
    resolveHead(null);
    await result;
  });
});
