import { afterEach, describe, it, expect, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';

vi.mock('../plugin-sandbox/host-api', () => ({
  dispatchApiCall: vi.fn(async () => 'ok'),
}));

import { createBackgroundInstance, createSlotInstance } from '../plugin-sandbox/host-bridge';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import { onFrameActivity } from '../session-policy/frame-activity';

function plugin(): InstalledPlugin {
  return {
    id: 'p1', name: 'P', version: '1.0.0', author: '', description: '', type: 'hook',
    permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
  };
}

function post(source: Window | null, origin: string, data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
}

const instances: Array<{ destroy(): void }> = [];

/** The frame answers init: its hooks and slots are in place. */
function booted<T extends { iframe: HTMLIFrameElement }>(inst: T): T {
  post(inst.iframe.contentWindow, 'null', { type: 'init-done', hooks: [], slots: [], shortcuts: [] });
  return inst;
}
afterEach(() => {
  for (const i of instances.splice(0)) i.destroy();
  vi.clearAllMocks();
});

describe('host bridge origin pin for untrusted sandboxes', () => {
  it('answers API requests from the null-origin sandbox document', async () => {
    const inst = createBackgroundInstance({ plugin: plugin(), code: '', locale: 'en', tier: 'untrusted' });
    instances.push(inst);

    post(inst.iframe.contentWindow, 'null', { type: 'api-request', id: '1', method: 'storage.keys', args: [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(dispatchApiCall).toHaveBeenCalledTimes(1);
  });

  it('ignores the same frame once it has navigated to another origin', async () => {
    // A sandboxed frame may navigate itself. The page it lands on is no
    // longer under the sandbox CSP, so it must not inherit the RPC channel.
    const inst = createBackgroundInstance({ plugin: plugin(), code: '', locale: 'en', tier: 'untrusted' });
    instances.push(inst);

    post(inst.iframe.contentWindow, 'https://attacker.example', { type: 'api-request', id: '1', method: 'storage.keys', args: [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(dispatchApiCall).not.toHaveBeenCalled();
  });

  it('tears the frame down once it loads a second document', async () => {
    // The host posts hook payloads with targetOrigin '*'; after the sandbox
    // navigates itself, whatever page it shows must not keep receiving them.
    const inst = createBackgroundInstance({ plugin: plugin(), code: '', locale: 'en', tier: 'untrusted' });
    instances.push(inst);
    const frame = inst.iframe;
    frame.dispatchEvent(new Event('load')); // the sandbox document
    expect(frame.isConnected).toBe(true);

    frame.dispatchEvent(new Event('load')); // some other page
    expect(frame.isConnected).toBe(false);
    await expect(inst.initPromise).rejects.toThrow(/navigated away/);
    post(frame.contentWindow, 'null', { type: 'api-request', id: '1', method: 'storage.keys', args: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchApiCall).not.toHaveBeenCalled();
  });
});

describe('init payload settings', () => {
  it('hands a new iframe the settings with defaults filled in', async () => {
    const p = {
      ...plugin(),
      settings: { size: 64 },
      settingsSchema: {
        size: { type: 'number' as const, label: 'Size', default: 160 },
        mode: { type: 'select' as const, label: 'Mode', default: 'auto', options: ['auto', 'manual'] },
      },
    };
    const inst = createBackgroundInstance({ plugin: p, code: '', locale: 'en', tier: 'untrusted' });
    instances.push(inst);
    const sent = vi.spyOn(inst.iframe.contentWindow!, 'postMessage');

    post(inst.iframe.contentWindow, 'null', { type: 'sandbox-ready' });
    await new Promise((r) => setTimeout(r, 0));

    const init = sent.mock.calls.map(([msg]) => msg as { type: string; payload?: { manifest: { settings: unknown } } }).find((m) => m.type === 'init');
    expect(init?.payload?.manifest.settings).toEqual({ size: 64, mode: 'auto' });
  });
});

describe('slot sizing', () => {
  function slot(name: 'email-banner' | 'composer-toolbar') {
    const onResize = vi.fn();
    const inst = createSlotInstance({
      plugin: plugin(), slot: name, code: '', locale: 'en', tier: 'untrusted', extraProps: {},
      hostContainer: document.body, onResize,
    });
    instances.push(inst);
    return { inst, onResize };
  }

  it('ignores a height that is not a number and caps a huge one', async () => {
    const { inst, onResize } = slot('email-banner');
    post(inst.iframe.contentWindow, 'null', { type: 'slot-resize', height: Number.NaN });
    post(inst.iframe.contentWindow, 'null', { type: 'slot-resize', height: 1e9 });
    await new Promise((r) => setTimeout(r, 0));

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(inst.iframe.style.height).toBe('2000px');
  });

  it('sizes a toolbar slot to the width of its content', async () => {
    // A toolbar slot's iframe used to get no width in the composer's
    // button row and squeezed its content to one letter per line.
    const { inst, onResize } = slot('composer-toolbar');
    post(inst.iframe.contentWindow, 'null', { type: 'slot-resize', height: 32, width: 120 });
    await new Promise((r) => setTimeout(r, 0));

    expect(inst.iframe.style.width).toBe('120px');
    expect(onResize).toHaveBeenCalledWith(32, 120);
  });

  it('keeps a block slot at full width whatever it reports', async () => {
    const { inst } = slot('email-banner');
    post(inst.iframe.contentWindow, 'null', { type: 'slot-resize', height: 40, width: 120 });
    await new Promise((r) => setTimeout(r, 0));

    expect(inst.iframe.style.width).toBe('100%');
  });
});

describe('Escape inside a slot frame', () => {
  const inFrame = (wrapperAttr?: string) => {
    const wrapper = document.createElement('div');
    if (wrapperAttr) wrapper.setAttribute(wrapperAttr, 'p1');
    document.body.appendChild(wrapper);
    const inst = createSlotInstance({
      plugin: plugin(), slot: 'plugin-dialog', code: '', locale: 'en', tier: 'untrusted', extraProps: {}, hostContainer: wrapper,
    });
    instances.push(inst);
    const keys: string[] = [];
    const onKey = (e: KeyboardEvent) => { keys.push(e.key); };
    document.addEventListener('keydown', onKey, true);
    post(inst.iframe.contentWindow, 'null', { type: 'frame-escape' });
    document.removeEventListener('keydown', onKey, true);
    wrapper.remove();
    return keys;
  };

  it('reaches the host dialog when the frame is one', () => {
    expect(inFrame('data-plugin-dialog')).toEqual(['Escape']);
    expect(inFrame('data-plugin-dialog-popover')).toEqual(['Escape']);
  });

  it('stays in the frame anywhere else', () => {
    expect(inFrame()).toEqual([]);
  });
});

describe('shouldShow context', () => {
  it('leaves host callbacks out instead of failing to post them', async () => {
    const inst = booted(createBackgroundInstance({ plugin: plugin(), code: '', locale: 'en', tier: 'untrusted' }));
    instances.push(inst);
    const sent = vi.spyOn(inst.iframe.contentWindow!, 'postMessage');

    void inst.evaluateShouldShow('composer-attachment-source', { onAttach: () => {}, nested: { cb: () => {}, n: 1 } });

    const msg = sent.mock.calls.map(([m]) => m as { type: string; context?: unknown }).find((m) => m.type === 'slot-should-show');
    expect(msg?.context).toEqual({ nested: { n: 1 } });
  });
});

describe('host bookkeeping', () => {
  it('fails a hook call whose arguments cannot be sent, without keeping it pending', async () => {
    const inst = booted(createBackgroundInstance({ plugin: plugin(), code: '', locale: 'en', tier: 'untrusted' }));
    instances.push(inst);
    vi.spyOn(inst.iframe.contentWindow!, 'postMessage').mockImplementation(() => { throw new DOMException('no clone', 'DataCloneError'); });

    await expect(inst.invokeHook('onEmailOpen', [() => {}])).rejects.toThrow(/no clone/);
    expect((inst as unknown as { pendingHookInvokes: Map<string, unknown> }).pendingHookInvokes.size).toBe(0);
  });

  it('drops callbacks of props that were replaced', () => {
    const inst = createSlotInstance({
      plugin: plugin(), slot: 'email-banner', code: '', locale: 'en', tier: 'untrusted', extraProps: { a: () => 1 },
      hostContainer: document.body, onResize: () => {},
    });
    instances.push(inst);
    const table = (inst as unknown as { callbackTable: Map<string, unknown> }).callbackTable;

    for (let i = 0; i < 50; i++) inst.updateProps({ onAttach: () => i });

    expect(table.size).toBe(1);
  });

  it('boots a slot with the props updated before init, whose callbacks still answer', async () => {
    // The update used to drop the callbacks init was still going to carry,
    // so the slot's first call got "unknown callback" (#1266).
    const inst = createSlotInstance({
      plugin: plugin(), slot: 'calendar-event-actions', code: '', locale: 'en', tier: 'untrusted',
      extraProps: { setVirtualLocation: () => 'old' }, hostContainer: document.body, onResize: () => {},
    });
    instances.push(inst);
    const sent = vi.spyOn(inst.iframe.contentWindow!, 'postMessage');
    inst.updateProps({ setVirtualLocation: () => 'new' });

    post(inst.iframe.contentWindow, 'null', { type: 'sandbox-ready' });
    await new Promise((r) => setTimeout(r, 0));
    type Msg = { type: string; payload?: { extraProps: { setVirtualLocation: { __pluginCallback: string } } } };
    const messages = () => sent.mock.calls.map(([m]) => m as Msg);
    const callbackId = messages().find((m) => m.type === 'init')!.payload!.extraProps.setVirtualLocation.__pluginCallback;
    post(inst.iframe.contentWindow, 'null', { type: 'callback-invoke', id: 'c1', callbackId, args: [] });
    await new Promise((r) => setTimeout(r, 0));

    expect(messages().find((m) => m.type === 'callback-response')).toEqual({ type: 'callback-response', id: 'c1', ok: true, result: 'new' });
    expect(messages().map((m) => m.type)).not.toContain('props-update');
  });
});

describe('plugin frame permissions', () => {
  it('may write to the clipboard and use forms, nothing more', () => {
    const inst = createBackgroundInstance({ plugin: plugin(), code: '', locale: 'en', tier: 'untrusted' });
    try {
      expect(inst.iframe.getAttribute('allow')).toBe('clipboard-write');
      expect(inst.iframe.getAttribute('sandbox')?.split(' ').sort()).toEqual(
        process.env.NODE_ENV === 'development' ? ['allow-same-origin', 'allow-scripts'] : ['allow-forms', 'allow-scripts'],
      );
    } finally {
      inst.destroy();
    }
  });
});

describe('plugin frame color scheme', () => {
  // A frame whose document says dark while the iframe element says light (or
  // the other way round) gets an opaque canvas from the browser: a white
  // panel in a dark page.
  function slot() {
    const inst = createSlotInstance({
      plugin: plugin(), slot: 'plugin-dialog', code: '', locale: 'en', tier: 'untrusted', extraProps: {},
      hostContainer: document.body, onResize: () => {},
    });
    instances.push(inst);
    return inst;
  }

  it('starts with the color-scheme of the theme the frame boots with', async () => {
    document.documentElement.classList.add('dark');
    try {
      expect(slot().iframe.style.colorScheme).toBe('dark');
    } finally {
      document.documentElement.classList.remove('dark');
      // Let the page-theme watcher settle before the next test's frames.
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('keeps a slot frame hidden until it has booted with the theme', () => {
    // Before init the document (about:blank, then the bare sandbox page)
    // declares no color-scheme, so a dark-theme panel showed white.
    const inst = slot();
    expect(inst.iframe.style.visibility).toBe('hidden');
    post(inst.iframe.contentWindow, 'null', { type: 'sandbox-ready' });
    expect(inst.iframe.style.visibility).toBe('hidden');
    post(inst.iframe.contentWindow, 'null', { type: 'init-done', hooks: [], slots: [], shortcuts: [] });
    expect(inst.iframe.style.visibility).toBe('');
  });

  it('does not hide background frames', () => {
    const inst = createBackgroundInstance({ plugin: plugin(), code: '', locale: 'en', tier: 'untrusted' });
    instances.push(inst);
    expect(inst.iframe.style.visibility).toBe('');
  });

  it('boots with a theme that changed before the frame was ready', async () => {
    const inst = slot();
    const sent: unknown[] = [];
    vi.spyOn(inst.iframe.contentWindow!, 'postMessage').mockImplementation((msg: unknown) => { sent.push(msg); });
    inst.setTheme({ dark: true, fontFamily: 'sans-serif', vars: {} });
    expect(inst.iframe.style.colorScheme).toBe('dark');

    post(inst.iframe.contentWindow, 'null', { type: 'sandbox-ready' });
    await new Promise((r) => setTimeout(r, 0));
    const init = sent.find((m) => (m as { type: string }).type === 'init') as { payload: { theme: { dark: boolean } } };
    expect(init.payload.theme.dark).toBe(true);
    expect(sent.some((m) => (m as { type: string }).type === 'theme-change')).toBe(false);
  });

  it('switches the element only once the frame has applied a theme change', async () => {
    const inst = slot();
    vi.spyOn(inst.iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    post(inst.iframe.contentWindow, 'null', { type: 'sandbox-ready' });
    await new Promise((r) => setTimeout(r, 0));
    post(inst.iframe.contentWindow, 'null', { type: 'init-done', hooks: [], slots: [], shortcuts: [] });
    expect(inst.iframe.style.colorScheme).toBe('light');

    inst.setTheme({ dark: true, fontFamily: 'sans-serif', vars: {} });
    // The frame's document is still light: a dark element now means white.
    expect(inst.iframe.style.colorScheme).toBe('light');
    post(inst.iframe.contentWindow, 'null', { type: 'theme-applied', dark: true });
    expect(inst.iframe.style.colorScheme).toBe('dark');
  });
});

describe('plugin frames follow the page theme', () => {
  // The theme can change without the theme store: settings synced from the
  // server after load, a custom theme's stylesheet. Frames must follow what
  // the page shows, or a dark page gets light frames.
  it('pushes the new theme to open frames when the page root turns dark', async () => {
    const inst = createSlotInstance({
      plugin: plugin(), slot: 'plugin-dialog', code: '', locale: 'en', tier: 'untrusted', extraProps: {},
      hostContainer: document.body, onResize: () => {},
    });
    instances.push(inst);
    expect(inst.iframe.style.colorScheme).toBe('light');
    document.documentElement.classList.add('dark');
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(inst.iframe.style.colorScheme).toBe('dark');
    } finally {
      document.documentElement.classList.remove('dark');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(inst.iframe.style.colorScheme).toBe('light');
  });
});

describe('plugin translations in frames', () => {
  const locales = {
    en: { hello: 'Hello' },
    de: { hello: 'Hallo' },
    fr: { hello: 'Bonjour' },
    ja: { hello: 'こんにちは' },
  };

  it('sends a frame only the tables of its locale, and the next ones with a locale change', async () => {
    const inst = createSlotInstance({
      plugin: { ...plugin(), locales }, slot: 'plugin-dialog', code: '', locale: 'de', tier: 'untrusted', extraProps: {},
      hostContainer: document.body, onResize: () => {},
    });
    instances.push(inst);
    const sent: Array<Record<string, unknown>> = [];
    vi.spyOn(inst.iframe.contentWindow!, 'postMessage').mockImplementation((msg: unknown) => { sent.push(msg as Record<string, unknown>); });
    post(inst.iframe.contentWindow, 'null', { type: 'sandbox-ready' });
    await new Promise((r) => setTimeout(r, 0));

    const init = sent.find((m) => m.type === 'init') as { payload: { manifest: { locales: Record<string, unknown> } } };
    expect(Object.keys(init.payload.manifest.locales).sort()).toEqual(['de', 'en']);

    inst.setLocale('fr');
    const change = sent.find((m) => m.type === 'locale-change') as { locale: string; locales: Record<string, unknown> };
    expect(change.locale).toBe('fr');
    expect(change.locales).toEqual({ fr: { hello: 'Bonjour' }, en: { hello: 'Hello' } });
  });

  it('does the same for background frames', async () => {
    const inst = createBackgroundInstance({ plugin: { ...plugin(), locales }, code: '', locale: 'ja', tier: 'untrusted' });
    instances.push(inst);
    const sent: Array<Record<string, unknown>> = [];
    vi.spyOn(inst.iframe.contentWindow!, 'postMessage').mockImplementation((msg: unknown) => { sent.push(msg as Record<string, unknown>); });
    post(inst.iframe.contentWindow, 'null', { type: 'sandbox-ready' });
    await new Promise((r) => setTimeout(r, 0));

    const init = sent.find((m) => m.type === 'init') as { payload: { manifest: { locales: Record<string, unknown> } } };
    expect(Object.keys(init.payload.manifest.locales).sort()).toEqual(['en', 'ja']);
  });
});

describe('calls before the background frame has booted', () => {
  // A plugin offering the slots remembered from its last start is in the
  // registry while its frame boots; a message posted before init is lost.
  it('holds shouldShow and hook calls until init-done', async () => {
    const inst = createBackgroundInstance({ plugin: plugin(), code: '', locale: 'en', tier: 'untrusted' });
    instances.push(inst);
    const sent: Array<{ type: string; id?: string }> = [];
    vi.spyOn(inst.iframe.contentWindow!, 'postMessage').mockImplementation((m: unknown) => { sent.push(m as { type: string }); });

    const show = inst.evaluateShouldShow('email-banner', {});
    const hook = inst.invokeHook('onAction', [{ actionId: 'x' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.filter((m) => m.type === 'slot-should-show' || m.type === 'hook-invoke')).toEqual([]);

    booted(inst);
    await new Promise((r) => setTimeout(r, 0));
    const ask = sent.find((m) => m.type === 'slot-should-show')!;
    const call = sent.find((m) => m.type === 'hook-invoke')!;
    post(inst.iframe.contentWindow, 'null', { type: 'slot-should-show-result', id: ask.id, show: true });
    post(inst.iframe.contentWindow, 'null', { type: 'hook-result', id: call.id, ok: true, result: 'done' });
    await expect(show).resolves.toBe(true);
    await expect(hook).resolves.toBe('done');
  });

  it('gives up on them when the frame is destroyed first', async () => {
    const inst = createBackgroundInstance({ plugin: plugin(), code: '', locale: 'en', tier: 'untrusted' });
    const show = inst.evaluateShouldShow('email-banner', {});
    const hook = inst.invokeHook('onAction', []);
    inst.destroy();

    await expect(show).resolves.toBe(false);
    await expect(hook).rejects.toThrow(/destroyed/);
    await expect(inst.initPromise).rejects.toThrow(/destroyed/);
    expect(inst.closed).toBe(true);
  });
});

describe('input in a frame', () => {
  /** sandbox-ready as the runtime posts it, with its activity port. */
  function ready(inst: { iframe: HTMLIFrameElement }, port: MessagePort): void {
    const ev = new MessageEvent('message', { data: { type: 'sandbox-ready' }, origin: 'null', source: inst.iframe.contentWindow });
    Object.defineProperty(ev, 'ports', { value: [port] });
    window.dispatchEvent(ev);
  }
  const delivered = () => new Promise((r) => setTimeout(r, 20));
  const channels: MessageChannel[] = [];
  afterEach(() => {
    for (const c of channels.splice(0)) { c.port1.close(); c.port2.close(); }
  });
  function channel(): MessageChannel {
    const c = new MessageChannel();
    channels.push(c);
    return c;
  }

  it('counts for the idle timeout what the runtime reports through its port', async () => {
    const heard = vi.fn();
    const off = onFrameActivity(heard);
    try {
      const inst = createSlotInstance({
        plugin: plugin(), slot: 'app-page', code: '', locale: 'en', tier: 'untrusted', extraProps: {},
        hostContainer: document.body, onResize: () => {},
      });
      instances.push(inst);
      const runtime = channel();
      ready(inst, runtime.port2);
      runtime.port1.postMessage(null);
      await delivered();
      expect(heard).toHaveBeenCalledTimes(1);

      // A second sandbox-ready is not the runtime's: its port is ignored.
      const forged = channel();
      ready(inst, forged.port2);
      forged.port1.postMessage(null);
      await delivered();
      expect(heard).toHaveBeenCalledTimes(1);

      // Nor does a frame that is gone count.
      inst.destroy();
      runtime.port1.postMessage(null);
      await delivered();
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});
