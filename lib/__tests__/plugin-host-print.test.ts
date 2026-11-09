import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { printDocument } from '../plugin-sandbox/host-api-print';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

const PLUGIN: InstalledPlugin = {
  id: 'e-invoice', name: 'E-Invoice', version: '1.0.0', author: 'test', description: '',
  type: 'ui-extension', permissions: [], grantedPermissions: [], entrypoint: 'index.js',
  enabled: true, status: 'running', settings: {},
};
const call = (method: string, ...args: unknown[]) => dispatchApiCall(PLUGIN, method, args);

describe('api.ui.print', () => {
  let printed: string[];

  beforeEach(() => {
    resetPluginRateLimits();
    printed = [];
    document.querySelectorAll('iframe').forEach((f) => f.remove());
    // jsdom neither loads srcdoc nor prints: load the frame when it is
    // attached and record what its print() would have printed.
    vi.spyOn(document.body, 'appendChild').mockImplementation(function (this: HTMLElement, node: Node) {
      HTMLElement.prototype.appendChild.call(this, node);
      if (node instanceof HTMLIFrameElement) {
        const srcdoc = node.srcdoc;
        node.contentWindow!.print = () => { printed.push(srcdoc); };
        queueMicrotask(() => node.dispatchEvent(new Event('load')));
      }
      return node;
    } as never);
  });

  it('prints the page from a frame that runs no scripts and loads nothing', async () => {
    expect(await call('ui.print', {
      title: 'Rechnung 2026-117',
      html: '<style>td { padding: 4px }</style><table><tr><td>Total</td><td>119,00 €</td></tr></table>'
        + '<script>parent.steal()</script><img src="https://tracker.example/p.gif"><form action="https://x.example"><input name="a"></form>',
    })).toBe(true);
    expect(printed).toHaveLength(1);
    const page = printed[0];
    expect(page).toContain('<title>Rechnung 2026-117</title>');
    expect(page).toContain('<td>119,00 €</td>');
    expect(page).toContain('td { padding: 4px }');
    expect(page).not.toContain('<script');
    expect(page).not.toContain('<form');
    expect(page).toMatch(/default-src 'none'; img-src data: blob:;/);
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-modals');
  });

  it('escapes the title and refuses bad input', async () => {
    expect(printDocument('</title><script>x()</script>', '', 'ltr')).toContain('<title>&lt;/title&gt;&lt;script&gt;');
    await expect(call('ui.print', { html: 42 })).rejects.toThrow(/html must be a string/);
    await expect(call('ui.print', { title: 'a\nb', html: '' })).rejects.toThrow(/title must be one line/);
    await expect(call('ui.print', { html: '', url: 'https://x.example' })).rejects.toThrow(/unknown property "url"/);
    expect(printed).toEqual([]);
  });

  it('prints at most three times a minute', async () => {
    for (let i = 0; i < 3; i++) await call('ui.print', { html: '<p>x</p>' });
    await expect(call('ui.print', { html: '<p>x</p>' })).rejects.toThrow(/at most 3 times a minute/);
    expect(printed).toHaveLength(3);
  });
});
