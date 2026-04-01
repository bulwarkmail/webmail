import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPluginAPI, setSlotRegistrationBridge } from '../plugin-api';
import type { InstalledPlugin } from '../plugin-types';
import { clearAllHooks } from '../plugin-hooks';

function makePlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    author: 'Test',
    description: '',
    type: 'ui-extension',
    entrypoint: 'index.js',
    permissions: [],
    enabled: true,
    status: 'running',
    settings: {},
    ...overrides,
  };
}

beforeEach(() => {
  clearAllHooks();
  localStorage.clear();
  setSlotRegistrationBridge(null);
});

describe('createPluginAPI', () => {
  it('exposes plugin info', () => {
    const plugin = makePlugin();
    const api = createPluginAPI(plugin);
    expect(api.plugin.id).toBe('test-plugin');
    expect(api.plugin.version).toBe('1.0.0');
  });

  it('returns a frozen copy of settings', () => {
    const plugin = makePlugin({ settings: { key: 'val' } });
    const api = createPluginAPI(plugin);
    expect(api.plugin.settings).toEqual({ key: 'val' });
  });
});

describe('plugin storage (scoped localStorage)', () => {
  it('set and get a value', () => {
    const api = createPluginAPI(makePlugin());
    api.storage.set('foo', 42);
    expect(api.storage.get('foo')).toBe(42);
  });

  it('scopes to plugin id', () => {
    const api1 = createPluginAPI(makePlugin({ id: 'p1' }));
    const api2 = createPluginAPI(makePlugin({ id: 'p2' }));
    api1.storage.set('key', 'a');
    api2.storage.set('key', 'b');
    expect(api1.storage.get('key')).toBe('a');
    expect(api2.storage.get('key')).toBe('b');
  });

  it('remove deletes a value', () => {
    const api = createPluginAPI(makePlugin());
    api.storage.set('x', 10);
    api.storage.remove('x');
    expect(api.storage.get('x')).toBeNull();
  });

  it('keys lists only plugin-scoped keys', () => {
    const api = createPluginAPI(makePlugin({ id: 'kp' }));
    api.storage.set('a', 1);
    api.storage.set('b', 2);
    localStorage.setItem('unrelated', 'val');
    expect(api.storage.keys()).toContain('a');
    expect(api.storage.keys()).toContain('b');
    expect(api.storage.keys()).not.toContain('unrelated');
  });
});

describe('plugin logger', () => {
  it('prefixes log messages with plugin id', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const api = createPluginAPI(makePlugin({ id: 'log-test' }));
    api.log.info('hello');
    expect(infoSpy).toHaveBeenCalledWith('[plugin:log-test]', 'hello');
    infoSpy.mockRestore();
  });
});

describe('hooks permission gating', () => {
  it('returns no-op disposable without permission', () => {
    const plugin = makePlugin({ permissions: [] }); // no email:read
    const api = createPluginAPI(plugin);
    const d = api.hooks.onEmailOpen(vi.fn());
    expect(d).toBeDefined();
    expect(d.dispose).toBeInstanceOf(Function);
  });

  it('registers handler when permission is granted', () => {
    const plugin = makePlugin({ permissions: ['email:read'] });
    const api = createPluginAPI(plugin);
    const fn = vi.fn();
    const d = api.hooks.onEmailOpen(fn);
    expect(d).toBeDefined();
    d.dispose(); // should not throw
  });
});

describe('ui permission requirement', () => {
  it('throws without ui:toolbar permission', () => {
    const plugin = makePlugin({ permissions: [] });
    const api = createPluginAPI(plugin);
    expect(() => api.ui.registerToolbarAction({
      id: 'test',
      label: 'Test',
      onClick: () => {},
    })).toThrow('lacks permission');
  });

  it('does not throw with correct permission (slot bridge not set, returns no-op)', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = makePlugin({ permissions: ['ui:toolbar'] });
    const api = createPluginAPI(plugin);
    const d = api.ui.registerToolbarAction({ id: 'test', label: 'Test', onClick: () => {} });
    expect(d.dispose).toBeInstanceOf(Function);
    consoleSpy.mockRestore();
  });
});

describe('slot registration bridge', () => {
  it('calls bridge when set', () => {
    const bridge = vi.fn((_name, _reg) => ({ dispose: () => {} }));
    setSlotRegistrationBridge(bridge);

    const plugin = makePlugin({ permissions: ['ui:email-footer'] });
    const api = createPluginAPI(plugin);
    const DummyComponent = () => null;
    api.ui.registerEmailFooter(DummyComponent);
    expect(bridge).toHaveBeenCalled();
  });
});

describe('toast bridge', () => {
  it('exposes success/error/info/warning methods', () => {
    const plugin = makePlugin();
    const api = createPluginAPI(plugin);
    expect(api.toast.success).toBeInstanceOf(Function);
    expect(api.toast.error).toBeInstanceOf(Function);
    expect(api.toast.info).toBeInstanceOf(Function);
    expect(api.toast.warning).toBeInstanceOf(Function);
  });
});

describe('http.post path validation', () => {
  function makeApi(permissions: string[] = ['http:post']) {
    return createPluginAPI(makePlugin({ permissions }));
  }

  it('rejects protocol-relative URLs like //evil.example', async () => {
    const api = makeApi();
    await expect(api.http.post('//evil.example/collect', {})).rejects.toThrow('must start with /api/');
  });

  it('rejects absolute URLs to other origins', async () => {
    const api = makeApi();
    await expect(api.http.post('https://evil.example/steal', {})).rejects.toThrow('must start with /api/');
  });

  it('rejects paths not under /api/', async () => {
    const api = makeApi();
    await expect(api.http.post('/other/path', {})).rejects.toThrow('must start with /api/');
  });

  it('rejects paths that use backslash to bypass the check', async () => {
    const api = makeApi();
    await expect(api.http.post('/api/\\@evil.example', {})).rejects.toThrow();
  });

  it('throws without http:post permission', async () => {
    const api = makeApi([]);
    await expect(api.http.post('/api/jitsi', {})).rejects.toThrow('lacks permission');
  });

  it('accepts a valid /api/ path', async () => {
    const api = makeApi();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ url: 'https://meet.example.com/room' }),
    });
    const result = await api.http.post('/api/jitsi', { eventTitle: 'test' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ url: 'https://meet.example.com/room' });
  });
});
