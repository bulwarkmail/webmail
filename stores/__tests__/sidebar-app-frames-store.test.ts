import { describe, expect, it } from 'vitest';
import { appBadgeMark, parseAppBadgeMessage } from '../sidebar-app-frames-store';

describe('parseAppBadgeMessage', () => {
  const base = { type: 'bulwark:app-badge', version: 1 };

  it('reads a count, with or without mentions', () => {
    expect(parseAppBadgeMessage({ ...base, state: 'ok', count: 4, mentions: 1 })).toEqual({ count: 4, mentions: 1 });
    expect(parseAppBadgeMessage({ ...base, count: 7 })).toEqual({ count: 7 });
  });

  it('keeps a state that says the count cannot be trusted', () => {
    expect(parseAppBadgeMessage({ ...base, state: 'signed-out' })).toEqual({ count: 0, state: 'signed-out' });
    expect(parseAppBadgeMessage({ ...base, state: 'offline', count: 3, mentions: 1 }))
      .toEqual({ count: 3, mentions: 1, state: 'offline' });
    expect(parseAppBadgeMessage({ ...base, state: 'unknown', count: 0, mentions: 0 }))
      .toEqual({ count: 0, mentions: 0, state: 'unknown' });
  });

  it('clears the badge for a state it does not know, never taking silence from the app', () => {
    expect(parseAppBadgeMessage({ ...base, state: 'busy', count: 1 })).toBeNull();
    expect(parseAppBadgeMessage({ ...base, state: 'silent', count: 1 })).toBeNull();
  });

  it('ignores anything that is not exactly this message', () => {
    for (const data of [
      null,
      'bulwark:app-badge',
      { ...base, version: 2, count: 1 },
      { type: 'other', version: 1, count: 1 },
      { ...base, count: -1 },
      { ...base, count: 1.5 },
      { ...base, count: 100_000 },
      { ...base, count: '3' },
      { ...base, count: 1, mentions: -2 },
      { ...base, state: 1, count: 1 },
      { ...base, state: 'offline', count: -1 },
    ]) {
      expect(parseAppBadgeMessage(data)).toBeUndefined();
    }
  });
});

describe('appBadgeMark', () => {
  it('shows mentions as a number, else a dot for unread items', () => {
    expect(appBadgeMark({ count: 4, mentions: 2 })).toEqual({ number: 2 });
    expect(appBadgeMark({ count: 4, mentions: 0 })).toEqual({ dot: true });
    expect(appBadgeMark({ count: 0, mentions: 0 })).toBeNull();
  });

  it('shows the count as a number when the app has no mentions', () => {
    expect(appBadgeMark({ count: 4 })).toEqual({ number: 4 });
    expect(appBadgeMark({ count: 0 })).toBeNull();
    expect(appBadgeMark(undefined)).toBeNull();
  });

  it('marks a count that cannot be trusted: "!" signed out, "?" else, offline with its last number', () => {
    expect(appBadgeMark({ count: 0, state: 'signed-out' })).toEqual({ state: 'signed-out', symbol: '!', last: null });
    expect(appBadgeMark({ count: 9, mentions: 3, state: 'offline' })).toEqual({ state: 'offline', symbol: '?', last: 3 });
    expect(appBadgeMark({ count: 9, mentions: 0, state: 'offline' })).toEqual({ state: 'offline', symbol: '?', last: null });
    expect(appBadgeMark({ count: 4, state: 'unknown' })).toEqual({ state: 'unknown', symbol: '?', last: null });
    expect(appBadgeMark({ count: 4, state: 'silent' })).toEqual({ state: 'silent', symbol: '?', last: null });
  });
});
