import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';

vi.mock('../plugin-sandbox/host-api', () => ({ dispatchApiCall: vi.fn(async () => 'ok') }));

import { createBackgroundInstance } from '../plugin-sandbox/host-bridge';

// A plugin's hidden background frame must not widen the page. Parked at
// left -9999px it made a right-to-left page (Arabic, Hebrew, Persian)
// 9999px wider on the left, with blank space to scroll into.

const instances: Array<{ destroy(): void }> = [];
afterEach(() => { for (const i of instances.splice(0)) i.destroy(); });

describe('the background frame', () => {
  it('sits in the page, invisible and out of the way, without a far-off position', () => {
    const plugin = {
      id: 'p1', name: 'P', version: '1.0.0', author: '', description: '', type: 'hook',
      permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
    } as InstalledPlugin;
    const inst = createBackgroundInstance({ plugin, code: '', locale: 'en', tier: 'untrusted' });
    instances.push(inst);
    const { style } = inst.iframe;
    expect(style.position).toBe('fixed');
    expect(style.left).toBe('0px');
    expect(style.top).toBe('0px');
    expect(style.width).toBe('1px');
    expect(style.opacity).toBe('0');
    expect(style.pointerEvents).toBe('none');
    expect(inst.iframe.getAttribute('aria-hidden')).toBe('true');
    expect(inst.iframe.tabIndex).toBe(-1);
  });
});
