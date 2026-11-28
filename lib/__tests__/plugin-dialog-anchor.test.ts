import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { head, resetDialogLimits, resolveHead } from '../plugin-sandbox/host-dialog';
import {
  forgetTrigger, frameAnchor, noteTrigger, placePopover, trackTriggers, triggerAnchor, POPOVER_GAP, POPOVER_MARGIN, TRIGGER_WINDOW_MS,
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

describe('placePopover at the end side', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 340, height: 600 };
  // A rail's foot: 55 px wide, its button at the window's bottom.
  const flag = { left: 0, top: 740, right: 55, bottom: 780 };

  it('stands right of the anchor, bottoms lined up', () => {
    expect(placePopover(flag, size, viewport, false, 'end')).toEqual({ left: 55 + POPOVER_GAP, top: 780 - 600 });
  });

  it('stands left of it in RTL', () => {
    const rtlFlag = { left: 945, top: 740, right: 1000, bottom: 780 };
    expect(placePopover(rtlFlag, size, viewport, true, 'end')).toEqual({ left: 945 - POPOVER_GAP - 340, top: 180 });
  });

  it('goes to the start side when the end side has no room', () => {
    expect(placePopover({ left: 900, top: 100, right: 950, bottom: 140 }, { width: 340, height: 100 }, viewport, false, 'end').left)
      .toBe(900 - POPOVER_GAP - 340);
  });

  it('stays inside a small window', () => {
    const small = { width: 300, height: 400 };
    expect(placePopover({ left: 0, top: 350, right: 55, bottom: 390 }, size, small, false, 'end'))
      .toEqual({ left: POPOVER_MARGIN, top: POPOVER_MARGIN });
    expect(placePopover({ left: 0, top: 10, right: 55, bottom: 50 }, { width: 200, height: 300 }, small, false, 'end').top)
      .toBe(POPOVER_MARGIN);
  });
});

describe('frameAnchor', () => {
  it("is the frame's place, none for one gone or without size", () => {
    const frame = control('<iframe data-at></iframe>', { left: 0, top: 740, width: 55, height: 40 });
    expect(frameAnchor(frame)).toEqual({ left: 0, top: 740, right: 55, bottom: 780 });
    const hidden = control('<iframe data-at></iframe>', { left: 0, top: 0, width: 1, height: 1 });
    expect(frameAnchor(hidden)).toBeNull();
    // display: none measures 0 x 0.
    const none = control('<iframe data-at></iframe>', { left: 0, top: 0, width: 0, height: 0 });
    expect(frameAnchor(none)).toBeNull();
    frame.remove();
    expect(frameAnchor(frame)).toBeNull();
    expect(frameAnchor(undefined)).toBeNull();
  });
});

describe("ui.openDialog's anchor", () => {
  it("is the calling frame's place, at its end side, without any click", async () => {
    const frame = control('<iframe data-at></iframe>', { left: 0, top: 740, width: 55, height: 40 });
    const result = dispatchApiCall(plugin(), 'ui.openDialog', [{ slot: 'plugin-dialog', anchor: 'frame', width: 340 }], { frame: 'slot', frameElement: frame });
    await vi.waitFor(() => expect(head()).not.toBeNull());
    expect(head()?.anchor).toEqual({ left: 0, top: 740, right: 55, bottom: 780 });
    expect(head()?.anchorSide).toBe('end');
    resolveHead(null);
    await expect(result).resolves.toBeNull();
  });

  it("is a spot of the calling frame below which it stands, clamped to the frame", async () => {
    const frame = control('<iframe data-at></iframe>', { left: 60, top: 0, width: 800, height: 30 });
    const result = dispatchApiCall(plugin(), 'ui.openDialog', [{ slot: 'plugin-dialog', anchor: { left: 120, top: 4, right: 200, bottom: 26 }, width: 260 }], { frame: 'slot', frameElement: frame });
    await vi.waitFor(() => expect(head()).not.toBeNull());
    expect(head()?.anchor).toEqual({ left: 180, top: 4, right: 260, bottom: 26 });
    expect(head()?.anchorSide).toBeUndefined();
    resolveHead(null);
    await result;
    // Never outside the frame: a spot beyond it is cut to its edges.
    const far = dispatchApiCall(plugin(), 'ui.openDialog', [{ slot: 'plugin-dialog', anchor: { left: -500, top: -9, right: 5000, bottom: 900 } }], { frame: 'slot', frameElement: frame });
    await vi.waitFor(() => expect(head()).not.toBeNull());
    expect(head()?.anchor).toEqual({ left: 60, top: 0, right: 860, bottom: 30 });
    resolveHead(null);
    await far;
    // Sides given the wrong way round are taken in order.
    const turned = dispatchApiCall(plugin(), 'ui.openDialog', [{ slot: 'plugin-dialog', anchor: { left: 200, top: 26, right: 120, bottom: 4 } }], { frame: 'slot', frameElement: frame });
    await vi.waitFor(() => expect(head()).not.toBeNull());
    expect(head()?.anchor).toEqual({ left: 180, top: 4, right: 260, bottom: 26 });
    resolveHead(null);
    await turned;
  });

  it('is none for a rect from the background frame or one not of numbers', async () => {
    const frame = control('<iframe data-at></iframe>', { left: 60, top: 0, width: 800, height: 30 });
    const calls: [unknown, 'background' | 'slot'][] = [
      [{ left: 1, top: 1, right: 2, bottom: 2 }, 'background'],
      [{ left: '1', top: 1, right: 2, bottom: 2 }, 'slot'],
      [{ left: Number.NaN, top: 1, right: 2, bottom: 2 }, 'slot'],
      [{ left: 1, top: 1, right: Number.POSITIVE_INFINITY, bottom: 2 }, 'slot'],
      [[1, 1, 2, 2], 'slot'],
      // A DOMRect spread into an object: its sides are getters, so nothing comes along.
      [{}, 'slot'],
    ];
    for (const [anchor, kind] of calls) {
      const result = dispatchApiCall(plugin(), 'ui.openDialog', [{ slot: 'plugin-dialog', anchor }], { frame: kind, frameElement: frame });
      await vi.waitFor(() => expect(head()).not.toBeNull());
      expect(head()?.anchor).toBeUndefined();
      resolveHead(null);
      await result;
    }
  });

  it('is none for the background frame or an unknown value', async () => {
    const frame = control('<iframe data-at></iframe>', { left: 0, top: 740, width: 55, height: 40 });
    const calls: [unknown, 'background' | 'slot'][] = [['frame', 'background'], ['beside', 'slot']];
    for (const [anchor, kind] of calls) {
      const result = dispatchApiCall(plugin(), 'ui.openDialog', [{ slot: 'plugin-dialog', anchor }], { frame: kind, frameElement: frame });
      await vi.waitFor(() => expect(head()).not.toBeNull());
      expect(head()?.anchor).toBeUndefined();
      expect(head()?.anchorSide).toBeUndefined();
      resolveHead(null);
      await result;
    }
  });

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
