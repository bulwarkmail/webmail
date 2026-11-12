// The plugin OAuth callback page needs no session. It says that authorization failed when the
// address carries `error`, and names the error only when it is an OAuth error code (RFC 6749
// 4.1.2.1: `access_denied`, `invalid_scope`, ...); any other text gets the page's own words, and
// `error_description` is never shown. What the plugin receives stays as the provider sent it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

let search = '';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) => (vars ? `${key} ${Object.values(vars).join(' ')}` : key),
}));
vi.mock('@/components/auth/oauth-status-card', () => ({
  OAuthStatusCard: ({ title, message }: { title?: string; message?: string }) => React.createElement('div', null, title, ' ', message),
}));

import PluginOAuthCallbackPage from '../page';
import { PLUGIN_OAUTH_STORAGE_KEY } from '@/lib/plugin-oauth';

function shown(query: string): string {
  search = query;
  const { container, unmount } = render(React.createElement(PluginOAuthCallbackPage));
  const text = container.textContent ?? '';
  unmount();
  return text;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('what the plugin OAuth callback page says', () => {
  it('does not repeat a sentence from the address as its own message', () => {
    const text = shown(`error=${encodeURIComponent('your mailbox is locked. To unlock it, call 0000 000 000 and give your password')}&state=x`);
    expect(text).not.toContain('your mailbox is locked');
    expect(text).not.toContain('0000 000 000');
    // It still says that it failed.
    expect(text).toContain('oauth_callback.failed_title');
  });

  it('does not repeat a link from the address', () => {
    expect(shown(`error=${encodeURIComponent('go to https://evil.example/unlock')}&state=x`)).not.toContain('evil.example');
  });

  it('keeps its own text for a denial (a control)', () => {
    expect(shown('error=access_denied&state=x')).toContain('oauth_callback.denied');
  });

  it('may still name an OAuth error code (a control)', () => {
    expect(shown('error=invalid_scope&state=x')).toContain('oauth_callback.failed_title');
  });

  it('names an error code, in upper case too', () => {
    expect(shown('error=invalid_scope&state=x')).toContain('invalid_scope');
    expect(shown('error=TEMPORARILY_UNAVAILABLE&state=x')).toContain('TEMPORARILY_UNAVAILABLE');
  });

  it('does not show a code followed by a sentence', () => {
    const text = shown(`error=${encodeURIComponent('server_error your mailbox is locked')}&state=x`);
    expect(text).not.toContain('your mailbox is locked');
    expect(text).not.toContain('server_error');
    expect(text).toContain('oauth_callback.failed_title');
  });

  it('never shows error_description', () => {
    const text = shown(`error=server_error&error_description=${encodeURIComponent('Call 0000 000 000 to unlock your mailbox')}&state=x`);
    expect(text).toContain('server_error');
    expect(text).not.toContain('0000 000 000');
  });

  it('goes by the first error when the address gives two', () => {
    const sentence = encodeURIComponent('your mailbox is locked');
    expect(shown(`error=${sentence}&error=access_denied&state=x`)).not.toContain('your mailbox is locked');
    const denied = shown(`error=access_denied&error=${sentence}&state=x`);
    expect(denied).toContain('oauth_callback.denied');
    expect(denied).not.toContain('your mailbox is locked');
  });

  it('does not show a very long state', () => {
    const state = 'S'.repeat(100_000);
    expect(shown(`error=server_error&state=${state}`)).not.toContain('SSSS');
  });

  it('hands the plugin the provider\'s error and description as they came', () => {
    const description = 'The user cancelled at the consent screen.';
    shown(`error=${encodeURIComponent('Custom Error Text')}&error_description=${encodeURIComponent(description)}&state=x`);
    expect(JSON.parse(sessionStorage.getItem(PLUGIN_OAUTH_STORAGE_KEY)!)).toMatchObject({
      state: 'x', error: 'Custom Error Text', error_description: description,
    });
  });
});
