// The plugin OAuth return page names `error` only when it is a defined OAuth error code. A value
// shaped like a code that no specification defines (a phone number, a domain, an instruction
// joined with dots, dashes or underscores) gets the page's own words, like any other text. The
// codes the page may name are the ones RFC 6749 4.1.2.1 and OpenID Connect define.
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

describe('a value that looks like a code but is none', () => {
  it.each([
    'mailbox_locked.call-0800-555-0199',
    'verify-your-account-at.evil-example.com',
    'call.00441234567890.to.unlock',
    'password_expired_reply_with_it',
  ])('does not show %s', (value) => {
    const text = shown(`error=${encodeURIComponent(value)}&state=x`);
    expect(text).not.toContain(value);
    expect(text).toContain('oauth_callback.failed_title');
  });
});

describe('encodings and markup', () => {
  it.each([
    ['a right-to-left override', '‮access_denied'],
    ['markup', '<b>server_error</b>'],
    ['a zero-width space inside', 'server​_error'],
    ['65 characters', 'a'.repeat(65)],
  ])('does not show %s', (_, value) => {
    const text = shown(`error=${encodeURIComponent(value)}&state=x`);
    expect(text).not.toContain(value);
  });
});

describe('controls', () => {
  it.each(['invalid_request', 'unauthorized_client', 'unsupported_response_type', 'invalid_scope', 'server_error', 'temporarily_unavailable', 'interaction_required', 'login_required', 'consent_required'])(
    'still names %s', (code) => {
      expect(shown(`error=${code}&state=x`)).toContain(code);
    },
  );
  it('keeps its own words for access_denied', () => {
    expect(shown('error=access_denied&state=x')).toContain('oauth_callback.denied');
  });
});
