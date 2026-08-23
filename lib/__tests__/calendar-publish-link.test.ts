import { describe, expect, it } from 'vitest';
import {
  buildCalendarPublishLinkUrl,
  canManageCalendarPublishLinks,
} from '@/lib/calendar-publish-link';
import type { Calendar } from '@/lib/jmap/types';

function baseCalendar(overrides: Partial<Calendar> = {}): Calendar {
  return {
    id: 'cal-1',
    name: 'Work',
    description: null,
    color: '#3b82f6',
    sortOrder: 1,
    isSubscribed: true,
    isVisible: true,
    isDefault: false,
    includeInAvailability: 'all',
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: null,
    shareWith: null,
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: true,
      mayWriteOwn: true,
      mayUpdatePrivate: true,
      mayRSVP: true,
      mayShare: true,
      mayDelete: true,
    },
    ...overrides,
  };
}

describe('canManageCalendarPublishLinks', () => {
  it('allows owned calendars', () => {
    expect(canManageCalendarPublishLinks(baseCalendar(), false)).toBe(true);
  });

  it('blocks subscription calendars', () => {
    expect(canManageCalendarPublishLinks(baseCalendar(), true)).toBe(false);
  });

  it('allows writable shared calendars', () => {
    expect(
      canManageCalendarPublishLinks(
        baseCalendar({
          isShared: true,
          myRights: {
            mayReadFreeBusy: true,
            mayReadItems: true,
            mayWriteAll: false,
            mayWriteOwn: true,
            mayUpdatePrivate: false,
            mayRSVP: false,
            mayShare: false,
            mayDelete: false,
          },
        }),
        false,
      ),
    ).toBe(true);
  });

  it('blocks read-only shared calendars', () => {
    expect(
      canManageCalendarPublishLinks(
        baseCalendar({
          isShared: true,
          myRights: {
            mayReadFreeBusy: true,
            mayReadItems: true,
            mayWriteAll: false,
            mayWriteOwn: false,
            mayUpdatePrivate: false,
            mayRSVP: false,
            mayShare: false,
            mayDelete: false,
          },
        }),
        false,
      ),
    ).toBe(false);
  });
});

describe('buildCalendarPublishLinkUrl', () => {
  it('builds public URLs', () => {
    expect(
      buildCalendarPublishLinkUrl('https://mail.example.com/', {
        id: 'abc',
        access: 'public',
      }),
    ).toBe('https://mail.example.com/ics/public/abc.ics');
  });

  it('builds private URLs with secret', () => {
    expect(
      buildCalendarPublishLinkUrl('https://mail.example.com', {
        id: 'abc',
        access: 'private',
        secret: 's3cret',
      }),
    ).toBe('https://mail.example.com/ics/abc/s3cret.ics');
  });
});
