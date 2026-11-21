import { describe, expect, it } from 'vitest';
import { callbackIssuerAccepted, isOwnIssuer } from '@/lib/oauth/discovery';

// How issuers are compared: a callback's `iss` with the issuer a sign-in was
// sent to (RFC 9207), and a metadata document's `issuer` with the base it was
// fetched from (RFC 8414). Both are simple string comparisons; only trailing
// slashes are forgiven.
describe('the iss of a callback', () => {
  const issuer = 'https://idp.example';
  it('accepts the issuer itself and any number of trailing slashes', () => {
    expect(callbackIssuerAccepted(issuer, issuer, true)).toBe(true);
    expect(callbackIssuerAccepted(`${issuer}/`, issuer, true)).toBe(true);
    expect(callbackIssuerAccepted(`${issuer}//`, `${issuer}/`, true)).toBe(true);
  });
  it('refuses another case, a default port, another path, another scheme', () => {
    expect(callbackIssuerAccepted('https://IDP.example', issuer, true)).toBe(false);
    expect(callbackIssuerAccepted('https://idp.example:443', issuer, true)).toBe(false);
    expect(callbackIssuerAccepted('https://idp.example/realms/other', 'https://idp.example/realms/mine', true)).toBe(false);
    expect(callbackIssuerAccepted('http://idp.example', issuer, true)).toBe(false);
  });
  it('refuses a non-string iss (an array from a parser that keeps repeats)', () => {
    expect(callbackIssuerAccepted([issuer, 'https://other.example'], issuer, false)).toBe(false);
  });
  it('refuses an iss when no issuer is known to compare it with', () => {
    expect(callbackIssuerAccepted('https://anyone.example', undefined, true)).toBe(false);
    expect(callbackIssuerAccepted('https://anyone.example', undefined, false)).toBe(false);
  });
});

describe("a metadata document's issuer", () => {
  it('is its own when identical to the base it was fetched from, trailing slashes aside', () => {
    expect(isOwnIssuer('https://mail.example', 'https://mail.example')).toBe(true);
    expect(isOwnIssuer('https://mail.example/', 'https://mail.example')).toBe(true);
    expect(isOwnIssuer('https://id.example/realms/mail', 'https://id.example/realms/mail')).toBe(true);
  });
  it('is not when missing, another host, another path, a capitalised host or a named default port', () => {
    expect(isOwnIssuer(undefined, 'https://mail.example')).toBe(false);
    expect(isOwnIssuer('', 'https://mail.example')).toBe(false);
    expect(isOwnIssuer('https://honest.example', 'https://other.example')).toBe(false);
    expect(isOwnIssuer('https://id.example/realms/other', 'https://id.example/realms/mail')).toBe(false);
    expect(isOwnIssuer('https://Mail.example', 'https://mail.example')).toBe(false);
    expect(isOwnIssuer('https://mail.example:443', 'https://mail.example')).toBe(false);
  });
});
