import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

// #1674: a location with null description, locationTypes or links members
// is exported by Stalwart as a VLOCATION only, which guests' calendars don't
// read. A plugin's location goes out with its name, and an existing
// location keeps its other members.

const WRITER: InstalledPlugin = {
  id: 'writer', name: 'writer', version: '1.0.0', author: 'test', description: '',
  type: 'hook', permissions: ['calendar:write'], grantedPermissions: ['calendar:write'], entrypoint: 'index.js',
  enabled: true, status: 'running', settings: {},
};

const updateEvent = vi.fn(async () => true);

beforeEach(() => {
  updateEvent.mockClear();
  useAuthStore.setState({ client: { getAccountId: () => 'acc1', getCalendarEvent: vi.fn(async () => null) } as unknown as IJMAPClient } as never);
  useCalendarStore.setState({
    supportsCalendar: true,
    calendars: [{ id: 'cal1', isDefault: true }],
    events: [{
      id: 'e1', uid: 'u1', title: 'Review', start: '2026-11-20T10:00:00', duration: 'PT1H', calendarIds: { cal1: true },
      locations: { x7: { '@type': 'Location', name: 'HQ', description: 'Second floor', links: null } },
    }],
    updateEvent,
  } as never);
});
afterEach(() => {
  useAuthStore.setState({ client: null });
});

describe('api.calendar.updateEvent location', () => {
  it('changes the name and keeps the members the location had', async () => {
    await dispatchApiCall(WRITER, 'calendar.updateEvent', ['e1', { location: 'HQ Berlin' }]);
    expect(updateEvent).toHaveBeenCalledTimes(1);
    expect((updateEvent.mock.calls[0] as unknown[])[2]).toEqual({
      locations: { x7: { '@type': 'Location', name: 'HQ Berlin', description: 'Second floor' } },
    });
  });

  it('clears the location with an empty string', async () => {
    await dispatchApiCall(WRITER, 'calendar.updateEvent', ['e1', { location: '' }]);
    expect((updateEvent.mock.calls[0] as unknown[])[2]).toEqual({ locations: null });
  });
});
