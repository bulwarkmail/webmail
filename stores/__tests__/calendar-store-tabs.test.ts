import { describe, it, expect, beforeEach } from 'vitest';
import { useCalendarStore } from '../calendar-store';

// #1727: every tab keeps its own copy of calendar-storage and writes it back
// on any change. The view picked in one tab must survive the other tabs'
// writes and the old /calendar/<view>/<date> address a tab reloads with.

const KEY = 'calendar-storage';

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) ?? '{}').state ?? {};
}

/** What another tab does when the user picks a view there. */
function otherTabPicks(viewMode: string) {
  const value = JSON.parse(localStorage.getItem(KEY) ?? '{"state":{},"version":0}');
  value.state.viewMode = viewMode;
  localStorage.setItem(KEY, JSON.stringify(value));
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem(KEY, JSON.stringify({ state: { viewMode: 'month', selectedCalendarIds: ['c1'] }, version: 0 }));
  await useCalendarStore.persist.rehydrate();
});

describe('calendar view with several tabs open (#1727)', () => {
  it('keeps the view another tab picked when this tab writes for something else', () => {
    expect(useCalendarStore.getState().viewMode).toBe('month');
    otherTabPicks('week');

    // An event load or a day change in this tab writes the store.
    useCalendarStore.setState({ events: [], selectedDate: new Date(2026, 10, 16) });

    expect(stored().viewMode).toBe('week');
    expect(stored().selectedCalendarIds).toEqual(['c1']);
  });

  it('still stores what this tab changes itself', () => {
    otherTabPicks('week');
    useCalendarStore.setState({ selectedCalendarIds: ['c2'] });

    expect(stored().selectedCalendarIds).toEqual(['c2']);
    expect(stored().viewMode).toBe('week');
  });

  it('stores the view the user picks, also when this tab already showed it', () => {
    otherTabPicks('week');
    useCalendarStore.getState().setViewMode('month');

    expect(stored().viewMode).toBe('month');
  });

  it('shows the view of a link without replacing the picked one', () => {
    otherTabPicks('week');
    useCalendarStore.getState().showViewMode('day');

    expect(useCalendarStore.getState().viewMode).toBe('day');
    expect(stored().viewMode).toBe('week');

    useCalendarStore.setState({ events: [] });
    expect(stored().viewMode).toBe('week');

    useCalendarStore.getState().setViewMode('day');
    expect(stored().viewMode).toBe('day');
  });
});
