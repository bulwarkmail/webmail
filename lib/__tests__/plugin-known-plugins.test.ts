import { describe, expect, it } from 'vitest';
import { usePluginStore } from '@/stores/plugin-store';
import { knownPlugins } from '@/lib/plugin-sandbox/known-plugins';
import type { InstalledPlugin } from '@/lib/plugin-types';

// The composer's proofreading reads the installed plugins from here, so it
// knows which signing plugin is still starting, without importing the store.

describe('known plugins', () => {
  it('follow the plugin store', () => {
    const smime = { id: 'smime', name: 'S/MIME', permissions: ['crypto:full'], enabled: true, status: 'enabled' } as unknown as InstalledPlugin;
    usePluginStore.setState({ plugins: [smime] });
    expect(knownPlugins()).toEqual([smime]);
    usePluginStore.setState({ plugins: [] });
    expect(knownPlugins()).toEqual([]);
  });
});
