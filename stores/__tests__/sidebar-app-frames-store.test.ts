import { describe, expect, it } from 'vitest';
import { appBadgeMark, parseAppBadgeMessage } from '../sidebar-app-frames-store';

describe('parseAppBadgeMessage', () => {
  const base = { type: 'bulwark:app-badge', version: 1 };

  it('reads a count, with or without mentions', () => {
    expect(parseAppBadgeMessage({ ...base, state: 'ok', count: 4, mentions: 1 })).toEqual({ count: 4, mentions: 1 });
    expect(parseAppBadgeMessage({ ...base, count: 7 })).toEqual({ count: 7 });
  });

  it('clears the badge for any state but ok', () => {
    expect(parseAppBadgeMessage({ ...base, state: 'signed-out' })).toBeNull();
    expect(parseAppBadgeMessage({ ...base, state: 'offline', count: 3 })).toBeNull();
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
});
