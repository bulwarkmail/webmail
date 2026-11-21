import { describe, it, expect } from 'vitest';
import { savedStatusFields } from '@/components/calendar/event-modal';
import type { CalendarEvent } from '@/lib/jmap/types';

// The editor has Show as and Visibility fields but none for the status.
// Saving used to reset every edited event to confirmed, busy and public -
// and on Stalwart 1.0 an edit of one occurrence fails when privacy differs
// from the series' (a series without CLASS has none at all).

describe('savedStatusFields', () => {
  it('gives a new event the defaults', () => {
    expect(savedStatusFields(null)).toEqual({ status: 'confirmed', freeBusyStatus: 'busy', privacy: 'public' });
  });

  it('gives a new event the free/busy and privacy picked in the editor', () => {
    expect(savedStatusFields(null, { freeBusyStatus: 'free', privacy: 'secret' }))
      .toEqual({ status: 'confirmed', freeBusyStatus: 'free', privacy: 'secret' });
  });

  it('makes a new event in a shared calendar public, where the field is not offered', () => {
    expect(savedStatusFields(null, { freeBusyStatus: 'busy' })).toEqual({ status: 'confirmed', freeBusyStatus: 'busy', privacy: 'public' });
  });

  it('leaves unchanged fields out of an edit, keeping a tentative, free or private event as it is', () => {
    const event = { id: 'e1', status: 'tentative', freeBusyStatus: 'free', privacy: 'private' } as CalendarEvent;
    expect(savedStatusFields(event, { freeBusyStatus: 'free', privacy: 'private' })).toEqual({});
  });

  it('sends only what the user changed in an edit', () => {
    const event = { id: 'e1', status: 'tentative', freeBusyStatus: 'busy', privacy: 'public' } as CalendarEvent;
    expect(savedStatusFields(event, { freeBusyStatus: 'free', privacy: 'public' })).toEqual({ freeBusyStatus: 'free' });
    expect(savedStatusFields(event, { freeBusyStatus: 'busy', privacy: 'private' })).toEqual({ privacy: 'private' });
  });

  it('treats an event without privacy as public', () => {
    const event = { id: 'e1', freeBusyStatus: 'busy' } as CalendarEvent;
    expect(savedStatusFields(event, { freeBusyStatus: 'busy', privacy: 'public' })).toEqual({});
  });

  it('never sends privacy for an event in a shared calendar', () => {
    const event = { id: 'e1', freeBusyStatus: 'busy', privacy: 'private' } as CalendarEvent;
    expect(savedStatusFields(event, { freeBusyStatus: 'busy' })).toEqual({});
  });
});
