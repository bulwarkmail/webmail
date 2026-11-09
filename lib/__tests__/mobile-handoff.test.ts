import { describe, expect, it } from 'vitest';
import {
  MOBILE_HANDOFF_REDIRECT_URI,
  buildMobileHandoffCodeUrl,
  buildMobileHandoffUrl,
  mobileCodeChallenge,
  mobileHandoffTarget,
  signedInLoginAction,
} from '@/lib/auth/mobile-handoff';

// The login page handed the typed password (and the SSO callback the tokens)
// to any `bulwarkmobile://` URL named in the query string, with nothing on
// screen to tell the page apart from a normal sign-in. The target is now the
// app's one callback link, and the pages confirm with the user before they
// navigate (components/auth/mobile-handoff-consent.tsx).

describe('mobileHandoffTarget', () => {
  it('accepts only the mobile app callback link', () => {
    expect(mobileHandoffTarget('bulwarkmobile://auth/callback')).toBe(MOBILE_HANDOFF_REDIRECT_URI);
    expect(mobileHandoffTarget(' bulwarkmobile://auth/callback/ ')).toBe(MOBILE_HANDOFF_REDIRECT_URI);
  });

  it.each([
    'bulwarkmobile://x',
    'bulwarkmobile://auth/callback?x=1',
    'bulwarkmobile://auth/callback#frag',
    'bulwarkmobile://evil.example/auth/callback',
    'https://evil.example/',
    'javascript:alert(1)',
    '',
    null,
    undefined,
  ])('refuses %s', (raw) => {
    expect(mobileHandoffTarget(raw)).toBe('');
  });
});

describe('buildMobileHandoffUrl', () => {
  it('puts the material in the fragment, encoded', () => {
    const url = buildMobileHandoffUrl(MOBILE_HANDOFF_REDIRECT_URI, { flow: 'password', password: 'p&ss#1', state: 's' });
    expect(url.startsWith('bulwarkmobile://auth/callback#')).toBe(true);
    expect(url).toContain('password=p%26ss%231');
    expect(url.split('#')).toHaveLength(2);
  });
});

// The app's "Sign in via webmail" opens the login page in the system browser.
// When that browser already had a webmail session (the user reads mail in
// Safari, or signed out of the app after an earlier hand-off), the page sent
// the session to the mailbox and the app never got a sign-in: the user was
// left in the webmail's inbox inside the app's sign-in sheet.
describe('signedInLoginAction', () => {
  it('keeps the form for a hand-off opened by a signed-in browser', () => {
    expect(signedInLoginAction({ isMobileHandoff: true, isAddAccountMode: false, hasHandoffPayload: false })).toBe('stay');
  });

  it('hands over a sign-in that just happened on the page', () => {
    expect(signedInLoginAction({ isMobileHandoff: true, isAddAccountMode: false, hasHandoffPayload: true })).toBe('handoff');
  });

  it('opens the mailbox after a normal sign-in', () => {
    expect(signedInLoginAction({ isMobileHandoff: false, isAddAccountMode: false, hasHandoffPayload: false })).toBe('mailbox');
  });

  it('leaves add-account mode alone', () => {
    expect(signedInLoginAction({ isMobileHandoff: false, isAddAccountMode: true, hasHandoffPayload: false })).toBe('none');
  });
});

describe('code hand-off link', () => {
  // bulwarkmail.org/docs/development/mobile-handoff: an app that sent a challenge gets a link with
  // the one-time code and its state, in the query, and nothing else.
  it('carries only the code and the state', () => {
    const url = new URL(buildMobileHandoffCodeUrl(MOBILE_HANDOFF_REDIRECT_URI, 'ab'.repeat(32), 'st&ate=1'));
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(MOBILE_HANDOFF_REDIRECT_URI);
    expect([...url.searchParams.keys()]).toEqual(['code', 'state']);
    expect(url.searchParams.get('code')).toBe('ab'.repeat(32));
    expect(url.searchParams.get('state')).toBe('st&ate=1');
    expect(url.hash).toBe('');
  });

  it('accepts only an S256 challenge', () => {
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(mobileCodeChallenge(challenge)).toBe(challenge);
    expect(mobileCodeChallenge(`${challenge}=`)).toBe('');
    expect(mobileCodeChallenge(challenge.slice(1))).toBe('');
    expect(mobileCodeChallenge(`${challenge.slice(1)}+`)).toBe('');
    expect(mobileCodeChallenge('')).toBe('');
    expect(mobileCodeChallenge(null)).toBe('');
  });
});
