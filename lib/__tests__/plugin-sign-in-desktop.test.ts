import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '../desktop/types';

const ORIGIN = window.location.origin;

function setBridge(bridge: Partial<BulwarkDesktopBridge> | undefined) {
  window.bulwarkDesktop = bridge as BulwarkDesktopBridge | undefined;
}

function signInUrl(state: string, redirect = `${ORIGIN}/en/plugins/oauth/callback`): URL {
  const url = new URL('https://idp.example.org/application/o/authorize/');
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('state', state);
  return url;
}

afterEach(() => {
  setBridge(undefined);
  localStorage.clear();
});

describe('isPluginSignIn', () => {
  it('is the plugin\'s own sign-in: its state, back to this origin\'s plugin callback', async () => {
    const { createOAuthState, isPluginSignIn } = await import('../plugin-oauth');
    const state = createOAuthState('crm-banner');
    expect(isPluginSignIn(signInUrl(state), 'crm-banner')).toBe(true);
    expect(isPluginSignIn(signInUrl(state, `${ORIGIN}/plugins/oauth/callback`), 'crm-banner')).toBe(true);
  });

  it('is not for another plugin\'s state, a state nobody made, or another redirect', async () => {
    const { createOAuthState, isPluginSignIn } = await import('../plugin-oauth');
    const state = createOAuthState('crm-banner');
    expect(isPluginSignIn(signInUrl(state), 'other-plugin')).toBe(false);
    // A link in a message can name the callback, but not a state the host handed out.
    expect(isPluginSignIn(signInUrl('made-up'), 'crm-banner')).toBe(false);
    expect(isPluginSignIn(signInUrl(state, 'https://evil.example.org/plugins/oauth/callback'), 'crm-banner')).toBe(false);
    expect(isPluginSignIn(signInUrl(state, `${ORIGIN}/en/auth/callback`), 'crm-banner')).toBe(false);
    const twice = signInUrl(state);
    twice.searchParams.append('redirect_uri', 'https://evil.example.org/');
    expect(isPluginSignIn(twice, 'crm-banner')).toBe(false);
  });

  it('consumes nothing: the callback still finds its plugin', async () => {
    const { createOAuthState, isPluginSignIn, takeOAuthStateOwner } = await import('../plugin-oauth');
    const state = createOAuthState('crm-banner');
    isPluginSignIn(signInUrl(state), 'crm-banner');
    expect(takeOAuthStateOwner(state)).toBe('crm-banner');
  });
});

describe('openPluginSignInInApp', () => {
  it('is false without a shell, or with one that has no plugin sign-in', async () => {
    const { openPluginSignInInApp } = await import('../desktop/browser-sign-in');
    expect(await openPluginSignInInApp('https://idp.example.org/')).toBe(false);
    setBridge({ version: 1, platform: 'win32', auth: { claim: () => ({}) as never } });
    expect(await openPluginSignInInApp('https://idp.example.org/')).toBe(false);
  });

  it('hands the address to the shell and passes on its answer; a refusal is false', async () => {
    const { openPluginSignInInApp } = await import('../desktop/browser-sign-in');
    const pluginSignIn = vi.fn(async (url: string) => url.startsWith('https://idp.example.org/'));
    setBridge({ version: 1, platform: 'win32', auth: { claim: () => ({ pluginSignIn }) as never } });
    expect(await openPluginSignInInApp('https://idp.example.org/authorize')).toBe(true);
    expect(await openPluginSignInInApp('https://elsewhere.example.org/')).toBe(false);
    expect(pluginSignIn).toHaveBeenCalledWith('https://idp.example.org/authorize');

    setBridge({ version: 1, platform: 'win32', auth: { claim: () => ({ pluginSignIn: () => Promise.reject(new Error('no handler')) }) as never } });
    expect(await openPluginSignInInApp('https://idp.example.org/authorize')).toBe(false);
  });
});
