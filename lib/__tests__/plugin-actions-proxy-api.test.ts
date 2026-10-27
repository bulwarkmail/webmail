import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', async (orig) => ({
  ...(await orig<typeof import('@/lib/browser-navigation')>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
const registryEntries = vi.hoisted(() => [] as unknown[]);
vi.mock('../plugin-sandbox/registry', async (orig) => ({
  ...(await orig<typeof import('../plugin-sandbox/registry')>()),
  all: () => registryEntries,
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { actionsFor, resetActions, runAction, checkActions } from '../plugin-sandbox/actions';
import { dayLabelsByDate, resetDayLabels } from '../plugin-sandbox/day-labels';
import { allPages, resetPages } from '../plugin-sandbox/pages';
import { onPanelRequest, resetPanelRequests } from '../plugin-sandbox/panel-requests';
import type { StreamSink } from '../plugin-sandbox/proxy-client';
import '../plugin-sandbox/loader';

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'p1', name: 'Plugin One', version: '1.0.0', author: '', description: '', type: 'hook',
    permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, managed: true,
    ...overrides,
  };
}

beforeEach(() => {
  apiFetch.mockReset();
  resetActions();
  resetDayLabels();
  resetPages();
  registryEntries.length = 0;
});

describe('ui.setPanel (openPanel, closePanel, togglePanel)', () => {
  beforeEach(() => { resetPanelRequests(); });

  it('needs the permission of the panel\'s slot', async () => {
    await expect(dispatchApiCall(plugin({ permissions: [] }), 'ui.setPanel', ['composer-sidebar-right', 'open', { composerId: 'c1' }]))
      .rejects.toThrow(/may not open the panel/);
    await expect(dispatchApiCall(plugin({ permissions: ['ui:composer-sidebar'] }), 'ui.setPanel', ['email-detail-sidebar', 'open', undefined]))
      .rejects.toThrow(/may not open the panel/);
    await expect(dispatchApiCall(plugin({ permissions: ['ui:email-details'] }), 'ui.setPanel', ['sidebar-widget', 'open', undefined]))
      .rejects.toThrow(/may not open the panel/);
  });

  it('delivers the request to the panel on screen and answers with its state', async () => {
    const seen: unknown[] = [];
    onPanelRequest((request) => { seen.push(request); return request.mode !== 'close'; });
    await expect(dispatchApiCall(plugin({ permissions: ['ui:composer-sidebar'] }), 'ui.setPanel', ['composer-sidebar-right', 'toggle', { composerId: 'c1' }])).resolves.toBe(true);
    await expect(dispatchApiCall(plugin({ permissions: ['ui:email-details'] }), 'ui.setPanel', ['email-detail-sidebar', 'close', undefined])).resolves.toBe(false);
    expect(seen).toEqual([
      { pluginId: 'p1', slot: 'composer-sidebar-right', mode: 'toggle', composerId: 'c1' },
      { pluginId: 'p1', slot: 'email-detail-sidebar', mode: 'close' },
    ]);
  });

  it('answers null when no panel is on screen, and refuses odd arguments', async () => {
    await expect(dispatchApiCall(plugin({ permissions: ['ui:email-details'] }), 'ui.setPanel', ['email-detail-sidebar', 'open', undefined])).resolves.toBeNull();
    await expect(dispatchApiCall(plugin({ permissions: ['ui:composer-sidebar'] }), 'ui.setPanel', ['composer-sidebar', 'open', { composerId: 5 }])).rejects.toThrow(/composerId/);
    await expect(dispatchApiCall(plugin({ permissions: ['ui:composer-sidebar'] }), 'ui.setPanel', ['composer-sidebar', 'sideways', undefined])).rejects.toThrow(/mode/);
  });
});

describe('ui.setActions', () => {
  it('puts a plugin\'s buttons on a surface it may use', async () => {
    await dispatchApiCall(plugin({ permissions: ['ui:message-list'] }), 'ui.setActions', ['message-row-actions', [
      { id: 'b', label: 'Second', order: 2 }, { id: 'a', label: 'First', order: 1, icon: 'archive' },
    ]]);

    expect(actionsFor('message-row-actions').map((a) => [a.pluginId, a.id])).toEqual([['p1', 'a'], ['p1', 'b']]);
  });

  it('refuses a surface the plugin has no permission for, and frame slots', async () => {
    await expect(dispatchApiCall(plugin({ permissions: ['ui:toolbar'] }), 'ui.setActions', ['message-row-actions', []]))
      .rejects.toThrow(/may not add actions/);
    await expect(dispatchApiCall(plugin({ permissions: ['ui:email-banner'] }), 'ui.setActions', ['email-banner', []]))
      .rejects.toThrow(/not a surface that takes actions/);
    expect(actionsFor('message-row-actions')).toEqual([]);
  });

  it('checks what it is given', () => {
    expect(() => checkActions([{ id: 'x', label: '' }])).toThrow(/label/);
    expect(() => checkActions([{ id: 'x', label: 'X' }, { id: 'x', label: 'Y' }])).toThrow(/twice/);
    expect(() => checkActions(Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: 'A' })))).toThrow(/At most/);
    expect(() => checkActions([{ id: 'x', label: 'X', icon: '<svg>' }])).toThrow(/icon/);
  });

  it('takes a badge as a whole number from 0, none for 0', () => {
    expect(checkActions([{ id: 'x', label: 'X', badge: 3 }])[0].badge).toBe(3);
    expect(checkActions([{ id: 'x', label: 'X', badge: 250 }])[0].badge).toBe(250);
    expect(checkActions([{ id: 'x', label: 'X', badge: 0 }])[0]).not.toHaveProperty('badge');
    for (const badge of [-1, 1.5, '2', Number.NaN, Infinity, null]) {
      expect(() => checkActions([{ id: 'x', label: 'X', badge }])).toThrow(/badge/);
    }
  });

  it('sends a click to the plugin with only the context it may see', async () => {
    const invokeHook = vi.fn().mockResolvedValue(undefined);
    const p = plugin({ permissions: ['ui:message-list'] });
    registryEntries.push({ plugin: p, background: { invokeHook } });
    await dispatchApiCall(p, 'ui.setActions', ['message-row-actions', [{ id: 'task', label: 'Make a task' }]]);

    await runAction(actionsFor('message-row-actions')[0], 'message-row-actions', { emailId: 'e1', secretStuff: 1 });

    // emailId needs email:read, which this plugin lacks.
    expect(invokeHook).toHaveBeenCalledWith('onAction', [{ surface: 'message-row-actions', actionId: 'task', context: {} }]);

    p.permissions.push('email:read');
    await runAction(actionsFor('message-row-actions')[0], 'message-row-actions', { emailId: 'e1', secretStuff: 1 });
    expect(invokeHook).toHaveBeenLastCalledWith('onAction', [{ surface: 'message-row-actions', actionId: 'task', context: { emailId: 'e1' } }]);
  });
});

describe('day labels and pages', () => {
  it('stores labels by date, behind ui:calendar-action', async () => {
    await expect(dispatchApiCall(plugin(), 'ui.setDayLabels', [[{ date: '2026-12-24', text: 'Holiday' }]])).rejects.toThrow(/lacks permission/);
    await dispatchApiCall(plugin({ permissions: ['ui:calendar-action'] }), 'ui.setDayLabels', [[{ date: '2026-12-24', text: 'Holiday', dot: true }]]);

    expect(dayLabelsByDate().get('2026-12-24')).toEqual([expect.objectContaining({ text: 'Holiday', dot: true, pluginId: 'p1' })]);
    await expect(dispatchApiCall(plugin({ permissions: ['ui:calendar-action'] }), 'ui.setDayLabels', [[{ date: '24.12.2026', text: 'x' }]])).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('registers pages behind ui:app-page', async () => {
    await dispatchApiCall(plugin({ permissions: ['ui:app-page'] }), 'ui.setPages', [[{ id: 'files', title: 'Nextcloud', icon: 'cloud' }]]);

    expect(allPages()).toEqual([expect.objectContaining({ pluginId: 'p1', id: 'files', title: 'Nextcloud' })]);
    await expect(dispatchApiCall(plugin({ permissions: ['ui:app-page'] }), 'ui.setPages', [[{ id: 'A B', title: 'x' }]])).rejects.toThrow(/id/);
  });
});

describe('proxy.fetch', () => {
  const proxied = plugin({
    permissions: ['http:proxy'],
    credentials: { cloud: { label: 'Nextcloud', scope: 'user', inject: { type: 'basic' } } },
  });

  it('sends the request to the server proxy and returns the answer', async () => {
    apiFetch.mockResolvedValue(new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await dispatchApiCall(proxied, 'proxy.fetch', ['cloud', 'https://cloud.example.org/ocs/v2.php/cloud/user', {
      method: 'GET', headers: { 'OCS-APIRequest': 'true' }, responseType: 'json',
    }]);

    expect(res).toMatchObject({ status: 200, ok: true, body: { ok: 1 } });
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/plugin-proxy?plugin=p1&credential=cloud&url=https%3A%2F%2Fcloud.example.org%2Focs%2Fv2.php%2Fcloud%2Fuser');
    expect(init.headers).toMatchObject({ 'OCS-APIRequest': 'true', 'x-bulwark-method': 'GET' });
  });

  it('refuses a credential the manifest does not declare, and plugins without http:proxy', async () => {
    await expect(dispatchApiCall(proxied, 'proxy.fetch', ['other', 'https://a.example', {}])).rejects.toThrow(/declares no credential/);
    await expect(dispatchApiCall({ ...proxied, permissions: [] }, 'proxy.fetch', ['cloud', 'https://a.example', {}])).rejects.toThrow(/lacks permission/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('tells the plugin when the proxy itself refused', async () => {
    apiFetch.mockResolvedValue(new Response('{"error":"Too many requests","code":"rate_limited"}', {
      status: 429, headers: { 'content-type': 'application/json', 'x-bulwark-proxy-error': 'rate_limited' },
    }));

    const res = await dispatchApiCall(proxied, 'proxy.fetch', ['cloud', 'https://cloud.example.org/x', {}]);

    expect(res).toMatchObject({ status: 429, ok: false, proxyError: 'rate_limited', body: 'Too many requests' });
  });

  it('streams the answer to a request with a body (an AI reply), through fetch', async () => {
    apiFetch.mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('data: hi')); c.close(); },
    }), { status: 200 }));
    const sent: Parameters<StreamSink['sendStream']>[0][] = [];
    const sink: StreamSink = { sendStream: (m) => { sent.push(m); } };

    await dispatchApiCall(proxied, 'proxy.fetch', ['cloud', 'https://cloud.example.org/x', { method: 'POST', body: '{"stream":true}', responseType: 'stream', streamId: 'abc124' }], { sink });
    await vi.waitFor(() => expect(sent.at(-1)?.type).toBe('stream-end'));

    expect(apiFetch).toHaveBeenCalled();
    expect(sent.some((m) => m.type === 'stream-chunk')).toBe(true);
  });

  it('streams a large answer to the iframe in chunks', async () => {
    const encoder = new TextEncoder();
    apiFetch.mockResolvedValue(new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode('data: one\n\n')); c.enqueue(encoder.encode('data: two\n\n')); c.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const sent: Parameters<StreamSink['sendStream']>[0][] = [];
    const sink: StreamSink = { sendStream: (m) => { sent.push(m); } };

    const res = await dispatchApiCall(proxied, 'proxy.fetch', ['cloud', 'https://cloud.example.org/x', { responseType: 'stream', streamId: 'abc123' }], { sink });
    await vi.waitFor(() => expect(sent.at(-1)?.type).toBe('stream-end'));

    expect(res).toMatchObject({ status: 200, ok: true });
    const text = sent.filter((m) => m.type === 'stream-chunk').map((m) => new TextDecoder().decode((m as { chunk: ArrayBuffer }).chunk)).join('');
    expect(text).toBe('data: one\n\ndata: two\n\n');
  });
});
