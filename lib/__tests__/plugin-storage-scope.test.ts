import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimLegacyPluginStorage,
  clearAllPluginStorage,
  clearPluginStorageForAccount,
  pluginStoragePrefix,
} from '@/lib/plugin-sandbox/storage-scope';

// api.storage was shared by every account signed in to the browser and
// survived signing out, so a plugin read the previous account's data.

const ALICE = 'alice@mail.example';
const BOB = 'bob@mail.example';

function keys(): string[] {
  return Object.keys(localStorage).sort();
}

beforeEach(() => {
  localStorage.clear();
  clearAllPluginStorage(); // also forgets which plugins claimed legacy keys
});

describe('plugin storage scope', () => {
  it('gives each account its own namespace under the plugin prefix', () => {
    expect(pluginStoragePrefix('quick-notes', ALICE)).toBe('plugin:quick-notes:@alice%40mail.example:');
    expect(pluginStoragePrefix('quick-notes', ALICE)).not.toBe(pluginStoragePrefix('quick-notes', BOB));
  });

  it('hands pre-existing keys to the first account that uses the plugin', () => {
    localStorage.setItem('plugin:quick-notes:notes', '{"m1":"hi"}');
    claimLegacyPluginStorage('quick-notes', ALICE);
    expect(keys()).toEqual(['plugin:quick-notes:@alice%40mail.example:notes']);

    claimLegacyPluginStorage('quick-notes', BOB);
    expect(localStorage.getItem(`${pluginStoragePrefix('quick-notes', BOB)}notes`)).toBeNull();
  });

  it('signing one account out deletes only its keys', () => {
    localStorage.setItem(`${pluginStoragePrefix('quick-notes', ALICE)}notes`, '1');
    localStorage.setItem(`${pluginStoragePrefix('auto-tag', ALICE)}totalTagged`, '2');
    localStorage.setItem(`${pluginStoragePrefix('quick-notes', BOB)}notes`, '3');
    localStorage.setItem('settings-storage', '{}');

    clearPluginStorageForAccount(ALICE);
    expect(keys()).toEqual(['plugin:quick-notes:@bob%40mail.example:notes', 'settings-storage']);
  });

  it('a full sign-out deletes all plugin storage, including unclaimed legacy keys', () => {
    localStorage.setItem(`${pluginStoragePrefix('quick-notes', BOB)}notes`, '3');
    localStorage.setItem('plugin:auto-tag:totalTagged', '4');
    localStorage.setItem('settings-storage', '{}');

    clearAllPluginStorage();
    expect(keys()).toEqual(['settings-storage']);
  });
});
