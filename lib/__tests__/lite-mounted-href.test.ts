import { describe, expect, it } from 'vitest';
import { hrefToString, mountedHref, stripMountedPathname } from '@/lib/lite-mounted-href';

describe('hrefToString', () => {
  it('passes strings through and serialises next-intl href objects', () => {
    expect(hrefToString('/settings?tab=x')).toBe('/settings?tab=x');
    expect(hrefToString({ pathname: '/mail', query: { a: 1, b: ['x', 'y'], skip: undefined }, hash: 'top' })).toBe('/mail?a=1&b=x&b=y#top');
    expect(hrefToString({ pathname: '/calendar' })).toBe('/calendar');
  });
});

describe('mountedHref', () => {
  it('adds the runtime mount and the locale', () => {
    expect(mountedHref('/settings', 'en', '/webmail')).toBe('/webmail/en/settings');
    expect(mountedHref('/', 'de', '/webmail')).toBe('/webmail/de/');
    expect(mountedHref('/?mode=x', 'de', '/webmail')).toBe('/webmail/de/?mode=x');
    expect(mountedHref('/login?mode=add-account', 'en', '/bulwark')).toBe('/bulwark/en/login?mode=add-account');
    expect(mountedHref({ pathname: '/contacts', query: { id: 'c1' } }, 'en', '/webmail')).toBe('/webmail/en/contacts?id=c1');
  });

  it('behaves like next-intl at the site root', () => {
    expect(mountedHref('/settings', 'en', '')).toBe('/en/settings');
    expect(mountedHref('/', 'en', '')).toBe('/en/');
  });

  it('is idempotent and leaves external, relative and protocol-relative hrefs alone', () => {
    expect(mountedHref('/webmail/en/mail', 'en', '/webmail')).toBe('/webmail/en/mail');
    expect(mountedHref('/webmail', 'en', '/webmail')).toBe('/webmail');
    expect(mountedHref('/en/mail', 'en', '')).toBe('/en/mail');
    expect(mountedHref('https://example.com/x', 'en', '/webmail')).toBe('https://example.com/x');
    expect(mountedHref('//cdn.example.com/x', 'en', '/webmail')).toBe('//cdn.example.com/x');
    expect(mountedHref('thread/1', 'en', '/webmail')).toBe('thread/1');
    expect(mountedHref('#anchor', 'en', '/webmail')).toBe('#anchor');
  });

  it('does not mistake a path that merely starts with the mount text for a mounted one', () => {
    expect(mountedHref('/webmailer', 'en', '/webmail')).toBe('/webmail/en/webmailer');
  });
});

describe('stripMountedPathname', () => {
  it('drops the mount, the locale and a trailing slash', () => {
    expect(stripMountedPathname('/webmail/en/settings/', '/webmail')).toBe('/settings');
    expect(stripMountedPathname('/webmail/en/calendar/week/2026-09-17', '/webmail')).toBe('/calendar/week/2026-09-17');
    expect(stripMountedPathname('/webmail/en/', '/webmail')).toBe('/');
    expect(stripMountedPathname('/webmail/zh-TW', '/webmail')).toBe('/');
    expect(stripMountedPathname('/webmail', '/webmail')).toBe('/');
  });

  it('matches next-intl at the site root and during prerendering (no mount)', () => {
    expect(stripMountedPathname('/en/mail', '')).toBe('/mail');
    expect(stripMountedPathname('/', '')).toBe('/');
    expect(stripMountedPathname('', '')).toBe('/');
  });

  it('keeps paths without a locale as they are', () => {
    expect(stripMountedPathname('/webmail/nope/x', '/webmail')).toBe('/nope/x');
  });
});
