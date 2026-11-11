/**
 * An inline slot's frame is sized to its content, so nothing in it needs to
 * scroll. With fractional display scaling the frame can come out a fraction
 * of a pixel short, and classic scrollbars then cut the row off (#1602). Its
 * document hides overflow; a slot that grows with its content keeps the
 * browser's default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, screen, waitFor } from '@testing-library/react';

const HOST_ORIGIN = window.location.origin;

const bundle = (slot: string) => `module.exports = { slots: { '${slot}': { component: function () {
  return React.createElement('span', null, 'slot content');
} } } };`;

function post(source: unknown, origin: string, data: unknown): void {
  const ev = new MessageEvent('message', { data, origin });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}

let hostWindow: { postMessage: ReturnType<typeof vi.fn> };
const realParent = Object.getOwnPropertyDescriptor(window, 'parent');

beforeEach(() => {
  // The runtime keeps its host binding and boot flag at module scope.
  vi.resetModules();
  hostWindow = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { configurable: true, get: () => hostWindow as unknown as Window });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (realParent) Object.defineProperty(window, 'parent', realParent);
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});

async function bootSlot(slot: string): Promise<void> {
  const { SandboxRuntime } = await import('@/lib/plugin-sandbox/runtime');
  render(React.createElement(SandboxRuntime));
  post(hostWindow, HOST_ORIGIN, {
    type: 'init',
    payload: {
      mode: 'slot',
      pluginId: 'x',
      tier: 'privileged',
      slot,
      locale: 'en',
      manifest: { id: 'x', version: '1.0.0', permissions: [], settings: {} },
      code: bundle(slot),
      extraProps: {},
      theme: { dark: false, fontFamily: 'sans-serif', vars: {} },
    },
  });
  // The renderer loads on first boot, which is slow on a cold transform cache.
  await waitFor(() => expect(screen.getByText('slot content')).toBeInTheDocument(), { timeout: 15_000 });
}

describe('scrollbars in a slot frame', () => {
  it('hides them in an inline slot, whose frame is sized to its content', async () => {
    await bootSlot('composer-toolbar');
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');
  }, 30_000);

  it('leaves them alone in a slot that fills its container width', async () => {
    await bootSlot('email-banner');
    expect(document.documentElement.style.overflow).toBe('');
    expect(document.body.style.overflow).toBe('');
  }, 30_000);
});
