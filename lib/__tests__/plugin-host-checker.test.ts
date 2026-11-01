import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { HIGH_RISK_PERMISSIONS } from '../plugin-sandbox/permission-text';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import {
  allCheckers, clearPluginCheckers, getChecker, registerCheckTarget, resetCheckers, MAX_DEBOUNCE_MS, MIN_DEBOUNCE_MS,
} from '../plugin-sandbox/checkers';

vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const { dispatchApiCall } = await import('../plugin-sandbox/host-api');

// api.composer.registerChecker and friends: compose:check only, from the
// background frame only, input checked, results routed to the composer.

function plugin(perms: string[], id = 'lt'): InstalledPlugin {
  return {
    id, name: 'LanguageTool', version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const CHECK = plugin(['compose:check']);
const READ_WRITE = plugin(['compose:read', 'compose:write']);
const call = (p: InstalledPlugin, method: string, args: unknown[], frame: 'background' | 'slot' = 'background') =>
  dispatchApiCall(p, method, args, { frame });
const DATA = { id: 'lt', label: 'LanguageTool', kinds: ['spelling', 'grammar'] };

beforeEach(() => resetPluginRateLimits());
afterEach(() => resetCheckers());

describe('compose:check', () => {
  it('is a high-risk permission, and compose:read/write do not grant checking', async () => {
    expect(HIGH_RISK_PERMISSIONS.has('compose:check')).toBe(true);
    for (const method of ['composer.registerChecker', 'composer.setAnnotations', 'composer.getCheckText', 'composer.recheck']) {
      await expect(call(READ_WRITE, method, [DATA])).rejects.toThrow('lacks permission "compose:check"');
    }
    expect(allCheckers()).toHaveLength(0);
  });

  it('registers a checker from the background frame, with defaults filled in', async () => {
    await call(CHECK, 'composer.registerChecker', [DATA]);
    expect(getChecker('lt', 'lt')).toMatchObject({ label: 'LanguageTool', kinds: ['spelling', 'grammar'], debounceMs: 800, mode: 'typing', warnBeforeSend: false, pluginName: 'LanguageTool' });
  });

  it('refuses a registration from a slot frame', async () => {
    await expect(call(CHECK, 'composer.registerChecker', [DATA], 'slot')).rejects.toThrow('not from a slot');
    expect(allCheckers()).toHaveLength(0);
  });

  it('checks what a plugin registers', async () => {
    const bad = [
      { ...DATA, id: 'Bad Id' },
      { ...DATA, label: '' },
      { ...DATA, kinds: [] },
      { ...DATA, kinds: ['spelling', 'nonsense'] },
      { ...DATA, mode: 'always' },
      { ...DATA, languages: ['not a tag'] },
      { ...DATA, extra: true },
      { ...DATA, warnBeforeSend: 'yes' },
    ];
    for (const data of bad) await expect(call(CHECK, 'composer.registerChecker', [data])).rejects.toThrow();
    await call(CHECK, 'composer.registerChecker', [{ ...DATA, debounceMs: 5 }]);
    expect(getChecker('lt', 'lt')!.debounceMs).toBe(MIN_DEBOUNCE_MS);
    await call(CHECK, 'composer.registerChecker', [{ ...DATA, debounceMs: 1e9 }]);
    expect(getChecker('lt', 'lt')!.debounceMs).toBe(MAX_DEBOUNCE_MS);
  });

  it('allows at most four checkers per plugin', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await call(CHECK, 'composer.registerChecker', [{ ...DATA, id }]);
    await expect(call(CHECK, 'composer.registerChecker', [{ ...DATA, id: 'e' }])).rejects.toThrow('at most 4');
  });

  it('updates, rechecks and removes only its own checkers', async () => {
    await call(CHECK, 'composer.registerChecker', [DATA]);
    const epoch = getChecker('lt', 'lt')!.epoch;
    await call(CHECK, 'composer.updateChecker', ['lt', { warnBeforeSend: true }]);
    expect(getChecker('lt', 'lt')!.warnBeforeSend).toBe(true);
    await expect(call(CHECK, 'composer.updateChecker', ['lt', { id: 'other' }])).rejects.toThrow("can't be changed");
    await call(CHECK, 'composer.recheck', ['lt']);
    expect(getChecker('lt', 'lt')!.epoch).toBe(epoch + 1);
    const other = plugin(['compose:check'], 'other');
    await expect(call(other, 'composer.recheck', ['lt'])).rejects.toThrow('no checker');
    await expect(call(other, 'composer.unregisterChecker', ['lt'])).rejects.toThrow('no checker');
    await call(CHECK, 'composer.unregisterChecker', ['lt']);
    expect(allCheckers()).toHaveLength(0);
  });

  it('routes on-demand text and results to the composer it names', async () => {
    await call(CHECK, 'composer.registerChecker', [{ ...DATA, mode: 'on-demand' }]);
    const target = { getCheckText: vi.fn(() => ({ revision: 'r1' })), setAnnotations: vi.fn(() => 2) };
    const unregister = registerCheckTarget('composer-1', target);
    expect(await call(CHECK, 'composer.getCheckText', ['composer-1', 'lt'])).toEqual({ revision: 'r1' });
    expect(await call(CHECK, 'composer.setAnnotations', ['composer-1', 'lt', 'r1', []])).toBe(2);
    expect(target.setAnnotations).toHaveBeenCalledWith(expect.objectContaining({ id: 'lt' }), 'r1', []);
    await expect(call(CHECK, 'composer.setAnnotations', ['composer-2', 'lt', 'r1', []])).rejects.toThrow('not open');
    await expect(call(CHECK, 'composer.setAnnotations', ['composer-1', 'lt', 'r1', 'x'])).rejects.toThrow('must be a list');
    target.getCheckText.mockReturnValueOnce(null as never);
    await expect(call(CHECK, 'composer.getCheckText', ['composer-1', 'lt'])).rejects.toThrow('checking_off');
    unregister();
    await expect(call(CHECK, 'composer.getCheckText', ['composer-1', 'lt'])).rejects.toThrow('not open');
  });

  it('lets only a plugin that can sign say an Options entry signs or encrypts', async () => {
    const entry = [{ id: 'secure', label: 'Encrypt', checked: true, protects: 'encrypt' }];
    await expect(call(plugin(['ui:composer-toolbar'], 'poll'), 'ui.setActions', ['composer-options-menu', entry]))
      .rejects.toThrow('protects needs');
    await call(plugin(['ui:composer-toolbar', 'crypto:full'], 'smime'), 'ui.setActions', ['composer-options-menu', entry]);
    const { actionsFor, clearPluginActions } = await import('../plugin-sandbox/actions');
    expect(actionsFor('composer-options-menu')).toEqual([expect.objectContaining({ pluginId: 'smime', protects: 'encrypt' })]);
    await expect(call(plugin(['ui:composer-toolbar', 'crypto:full'], 'smime'), 'ui.setActions', ['composer-options-menu', [{ ...entry[0], protects: 'both' }]]))
      .rejects.toThrow('must be "sign" or "encrypt"');
    clearPluginActions('smime');
  });

  it('forgets a plugin\'s checkers when it is turned off', async () => {
    await call(CHECK, 'composer.registerChecker', [DATA]);
    clearPluginCheckers('lt');
    expect(allCheckers()).toHaveLength(0);
  });
});
