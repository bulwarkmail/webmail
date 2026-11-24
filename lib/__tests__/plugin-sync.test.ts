import { describe, it, expect } from 'vitest';
import {
  PLUGIN_SYNC_TOMBSTONE_TTL_MS, mergePluginSync, mergeStoredPluginSync, parsePluginSync,
} from '../plugin-sync';

const NOW = Date.UTC(2026, 10, 24);

describe('parsePluginSync', () => {
  it('keeps well-formed entries and drops the rest', () => {
    expect(parsePluginSync({
      'paperless|on': { at: 5, v: false },
      'paperless|settings': { at: 5, v: { url: 'https://docs.example.com' } },
      'ai-assistant|s:prefs': { at: 6, v: { useOwn: true } },
      'ai-assistant|s:old': { at: 7, gone: true },
      'paperless|on ': { at: 5, v: true },
      'Bad Id|on': { at: 5, v: true },
      'paperless|settings2': { at: 5, v: {} },
      'x1|on': { at: 5, v: 'yes' },
      'x2|settings': { at: 5, v: [1] },
      'x3|s:k': { at: 0, v: 1 },
      'x4|s:k': { at: 5 },
    })).toEqual({
      'paperless|on': { at: 5, v: false },
      'paperless|settings': { at: 5, v: { url: 'https://docs.example.com' } },
      'ai-assistant|s:prefs': { at: 6, v: { useOwn: true } },
      'ai-assistant|s:old': { at: 7, gone: true },
    });
  });

  it('tells a blob from before plugin sync from an empty one', () => {
    expect(parsePluginSync(undefined)).toBeNull();
    expect(parsePluginSync({})).toEqual({});
  });
});

describe('mergePluginSync', () => {
  it('keeps the newer change of each entry, and the first on a tie', () => {
    const merged = mergePluginSync(
      { 'a1|on': { at: 10, v: true }, 'a1|settings': { at: 20, v: { x: 1 } } },
      { 'a1|on': { at: 11, v: false }, 'a1|settings': { at: 20, v: { x: 2 } }, 'b1|on': { at: 1, v: true } },
      NOW,
    );
    expect(merged).toEqual({
      'a1|on': { at: 11, v: false },
      'a1|settings': { at: 20, v: { x: 1 } },
      'b1|on': { at: 1, v: true },
    });
  });

  it('forgets removed keys after the TTL', () => {
    const old = NOW - PLUGIN_SYNC_TOMBSTONE_TTL_MS - 1;
    expect(mergePluginSync({ 'a1|s:k': { at: old, gone: true } }, {}, NOW)).toEqual({});
    expect(mergePluginSync({ 'a1|s:k': { at: NOW - 1000, gone: true } }, {}, NOW)).toEqual({ 'a1|s:k': { at: NOW - 1000, gone: true } });
  });
});

describe('mergeStoredPluginSync (the settings route)', () => {
  it("doesn't let a browser that missed a change put the old value back", () => {
    const stored = { pluginSync: { 'a1|settings': { at: 200, v: { model: 'new' } } } };
    const stale = { theme: 'dark', pluginSync: { 'a1|settings': { at: 100, v: { model: 'old' } }, 'a1|on': { at: 150, v: true } } };
    expect(mergeStoredPluginSync(stored, stale, NOW)).toEqual({
      theme: 'dark',
      pluginSync: { 'a1|settings': { at: 200, v: { model: 'new' } }, 'a1|on': { at: 150, v: true } },
    });
  });

  it('keeps what is stored when a push from an older build has none', () => {
    const stored = { pluginSync: { 'a1|on': { at: 1, v: false } } };
    expect(mergeStoredPluginSync(stored, { theme: 'dark' }, NOW)).toEqual({ theme: 'dark', pluginSync: { 'a1|on': { at: 1, v: false } } });
    expect(mergeStoredPluginSync(null, { theme: 'dark', pluginSync: 'junk' }, NOW)).toEqual({ theme: 'dark' });
  });

  it('keeps what is stored when the merge grows past the limit', () => {
    const stored = { pluginSync: { 'a1|on': { at: 1, v: false } } };
    const huge = { pluginSync: { 'a1|s:big': { at: 2, v: 'x'.repeat(600 * 1024) } } };
    expect(mergeStoredPluginSync(stored, huge, NOW).pluginSync).toEqual(stored.pluginSync);
  });
});
