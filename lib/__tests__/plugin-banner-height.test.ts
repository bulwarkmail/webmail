// The `app-top-banner` slot is a banner across the top of every page. The app's pages are a column
// as tall as the window, so a banner taller than the window would leave nothing of the app on
// screen, Settings included. The rule: the top banner is at most 120 px tall, whatever height the
// plugin reports (a few lines of text). The banners in the reader and over the message list are at
// most 400 px; a plugin's own page and its dialog keep the general limit.
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { InstalledPlugin, SlotName } from '../plugin-types';

vi.mock('../plugin-sandbox/host-api', () => ({ dispatchApiCall: vi.fn(async () => 'ok') }));

import { createSlotInstance, type SandboxInstance } from '../plugin-sandbox/host-bridge';

const TOP_BANNER_MAX = 120;
const READER_BANNER_MAX = 400;

function plugin(id = 'p1'): InstalledPlugin {
  return {
    id, name: 'P', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: ['ui:app-top-banner', 'ui:app-page', 'ui:email-banner', 'ui:message-list'], entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
  };
}

function post(source: Window | null, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source }));
}

const instances: Array<{ destroy(): void }> = [];
afterEach(() => { for (const i of instances.splice(0)) i.destroy(); });

/** A started frame of `slot`, and what the host last told the page about its height. */
function frameOf(slot: SlotName, pluginId = 'p1'): { inst: SandboxInstance; told: () => number | null } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let told: number | null = null;
  const inst = createSlotInstance({
    plugin: plugin(pluginId), slot, code: '', locale: 'en', tier: 'untrusted', extraProps: {},
    hostContainer: container, onResize: (h) => { told = h; },
  });
  instances.push(inst);
  post(inst.iframe.contentWindow, { type: 'init-done', hooks: [], slots: [], shortcuts: [] });
  return { inst, told: () => told };
}

/** The frame of `slot` after the plugin reported `height`: what the host made the frame, and what it told the page. */
function reported(slot: SlotName, height: number): { frame: number; told: number | null } {
  const { inst, told } = frameOf(slot);
  post(inst.iframe.contentWindow, { type: 'slot-resize', height });
  return { frame: parseFloat(inst.iframe.style.height), told: told() };
}

describe('how tall a plugin\'s top banner may get', () => {
  it.each([2000, 900, 121])('keeps the top banner to the limit when the plugin reports %i px', (height) => {
    const { frame, told } = reported('app-top-banner', height);
    expect(frame).toBeLessThanOrEqual(TOP_BANNER_MAX);
    expect(told).not.toBeNull();
    expect(told!).toBeLessThanOrEqual(TOP_BANNER_MAX);
  });

  // Controls.
  it.each([48, 120])('shows a banner of %i px as it is', (height) => {
    const { frame, told } = reported('app-top-banner', height);
    expect(frame).toBe(height);
    expect(told).toBe(height);
  });

  it('leaves a page of the plugin\'s own as tall as it reports (up to the general limit)', () => {
    const { frame } = reported('app-page', 1800);
    expect(frame).toBe(1800);
  });

  it('leaves a plugin\'s dialog frame as tall as it reports (up to the general limit)', () => {
    const { frame } = reported('plugin-dialog', 1800);
    expect(frame).toBe(1800);
  });

  it('clamps every report of a banner that keeps reporting a larger height', () => {
    const { inst, told } = frameOf('app-top-banner');
    for (let height = 100; height <= 5000; height += 100) {
      post(inst.iframe.contentWindow, { type: 'slot-resize', height });
      expect(parseFloat(inst.iframe.style.height)).toBeLessThanOrEqual(TOP_BANNER_MAX);
      expect(told()!).toBeLessThanOrEqual(TOP_BANNER_MAX);
    }
  });

  it('limits each banner when two plugins have one', () => {
    const first = frameOf('app-top-banner', 'first');
    const second = frameOf('app-top-banner', 'second');
    post(first.inst.iframe.contentWindow, { type: 'slot-resize', height: 2000 });
    post(second.inst.iframe.contentWindow, { type: 'slot-resize', height: 2000 });
    expect(parseFloat(first.inst.iframe.style.height)).toBe(TOP_BANNER_MAX);
    expect(parseFloat(second.inst.iframe.style.height)).toBe(TOP_BANNER_MAX);
  });

  it('lets a banner taller than the limit scroll inside its frame, with the scrollbar shown', () => {
    // impersonation-notice with both buttons needs 195 px at 390 px width and 275 px at 360.
    const { inst } = frameOf('app-top-banner');
    post(inst.iframe.contentWindow, { type: 'slot-resize', height: 275 });
    expect(parseFloat(inst.iframe.style.height)).toBe(TOP_BANNER_MAX);
    expect(inst.iframe.getAttribute('scrolling')).toBe('yes');
    // Once the content fits again, the frame scrolls only as it needs.
    post(inst.iframe.contentWindow, { type: 'slot-resize', height: 49 });
    expect(inst.iframe.getAttribute('scrolling')).toBe('auto');
  });
});

describe('how tall a banner in the reader or over the message list may get', () => {
  const slots: SlotName[] = ['reader-header', 'reader-below-subject', 'email-banner', 'reader-above-quote', 'message-list-header'];

  it.each(slots)('keeps %s to its limit', (slot) => {
    const { frame, told } = reported(slot, 2000);
    expect(frame).toBe(READER_BANNER_MAX);
    expect(told).toBe(READER_BANNER_MAX);
  });

  it.each(slots)('shows %s at its limit as it is', (slot) => {
    expect(reported(slot, READER_BANNER_MAX).frame).toBe(READER_BANNER_MAX);
  });
});
