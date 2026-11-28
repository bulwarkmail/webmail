import { describe, it, expect } from 'vitest';
import { isUnsubscribedShare, withoutUnsubscribedShares } from '@/lib/calendar-visibility';

// #1731: shared calendars the user hasn't subscribed to leave the calendar
// while hideUnsubscribedCalendars is on.

const own = { id: 'own', isShared: false, isSubscribed: true };
const ownUnsubscribed = { id: 'own2', isShared: false, isSubscribed: false };
const subscribed = { id: 'team', isShared: true, isSubscribed: true };
const unsubscribed = { id: 'room', isShared: true, isSubscribed: false };
// A server that sends no isSubscribed.
const unknown = { id: 'other', isShared: true } as { id: string; isShared: boolean; isSubscribed: boolean };

describe('isUnsubscribedShare', () => {
  it('is true only for a shared calendar the server says is unsubscribed', () => {
    expect(isUnsubscribedShare(unsubscribed)).toBe(true);
    expect(isUnsubscribedShare(subscribed)).toBe(false);
    expect(isUnsubscribedShare(ownUnsubscribed)).toBe(false);
    expect(isUnsubscribedShare(unknown)).toBe(false);
  });
});

describe('withoutUnsubscribedShares', () => {
  const all = [own, ownUnsubscribed, subscribed, unsubscribed, unknown];
  const selected = ['own', 'own2', 'team', 'room', 'other'];

  it('leaves calendars and selection alone while the setting is off', () => {
    const shown = withoutUnsubscribedShares(all, selected, false);
    expect(shown.calendars).toBe(all);
    expect(shown.selectedIds).toBe(selected);
  });

  it('takes the unsubscribed shared calendars out of both while it is on', () => {
    const shown = withoutUnsubscribedShares(all, selected, true);
    expect(shown.calendars.map((c) => c.id)).toEqual(['own', 'own2', 'team', 'other']);
    expect(shown.selectedIds).toEqual(['own', 'own2', 'team', 'other']);
  });
});
