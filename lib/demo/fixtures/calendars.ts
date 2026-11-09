import type { Calendar, CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import { CALENDAR_PRESETS } from '@/lib/jmap/share-rights';
import { demoAt, demoDate, demoISODate } from '../demo-utils';
import { PRINCIPAL } from './directory';
import { type Person, NORA, ALICE, BOB, PRIYA, AHMED, LISA, MICHAEL, SARAH, CARLOS, MARCUS, EMMA, DAVID, KENJI, JAMES } from './people';

export const CAL = {
  work: 'demo-calendar-work',
  personal: 'demo-calendar-personal',
  birthdays: 'demo-calendar-birthdays',
  team: 'demo-calendar-team',
} as const;

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const rights = (mayDelete: boolean, mayWriteAll = true) => ({
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayShare: mayWriteAll, mayDelete,
});
// Birthdays come from the contacts, like the real birthday calendar: they
// can't be edited, moved or deleted here.
const readOnly = {
  mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false,
};

/**
 * Nora's Work, Personal and Birthdays calendars, and Alice's "Beacon team"
 * calendar, which Alice shares with the team: it comes from her account and
 * shows under her name. Nora shares Work with Alice (read), who covers for
 * her while she is in Lisbon.
 */
export function createDemoCalendars(): Calendar[] {
  const base = { description: null, isSubscribed: true, isVisible: true, includeInAvailability: 'all' as const, defaultAlertsWithTime: null, defaultAlertsWithoutTime: null, timeZone: null, shareWith: null };
  return [
    { ...base, id: CAL.work, name: 'Work', color: '#db2d54', sortOrder: 1, isDefault: true, myRights: rights(false), shareWith: { [PRINCIPAL.alice]: { ...CALENDAR_PRESETS.read } } },
    { ...base, id: CAL.personal, name: 'Personal', color: '#3b82f6', sortOrder: 2, isDefault: false, myRights: rights(true) },
    {
      ...base, id: CAL.team, name: 'Beacon team', description: 'Launch dates, standups and reviews for Beacon', color: '#8b5cf6', sortOrder: 3, isDefault: false, myRights: rights(false, false),
      isShared: true, accountId: PRINCIPAL.alice, accountName: ALICE.name,
    },
    { ...base, id: CAL.birthdays, name: 'Birthdays', color: '#eab308', sortOrder: 4, isDefault: false, includeInAvailability: 'none', myRights: readOnly },
  ];
}

// ── Participants ──────────────────────────────────────────────
type Status = 'accepted' | 'tentative' | 'declined' | 'needs-action';

function participant(p: Person, roles: Record<string, boolean>, status: Status = 'accepted', expectReply = false): CalendarParticipant {
  return {
    '@type': 'Participant', name: p.name, email: p.email, calendarAddress: `mailto:${p.email}`, description: null,
    sendTo: { imip: `mailto:${p.email}` }, kind: 'individual', roles, participationStatus: status, participationComment: null,
    expectReply, scheduleAgent: 'server', scheduleForceSend: false, scheduleId: null, scheduleSequence: 0,
    scheduleStatus: null, scheduleUpdated: null, invitedBy: null, delegatedTo: null, delegatedFrom: null, memberOf: null,
    locationId: null, language: null, links: null,
  } as CalendarParticipant;
}

const owner = (p: Person) => participant(p, { owner: true, attendee: true });
const attendee = (p: Person, status: Status = 'accepted') => participant(p, { attendee: true }, status, status === 'needs-action');

/** Participants keyed p1, p2, ... */
const people = (...list: CalendarParticipant[]) => Object.fromEntries(list.map((p, i) => [`p${i + 1}`, p]));

// ── Events ────────────────────────────────────────────────────
const BASE = {
  '@type': 'Event' as const,
  descriptionContentType: 'text/plain',
  isDraft: false,
  isOrigin: true,
  sequence: 0,
  status: 'confirmed' as const,
  freeBusyStatus: 'busy' as const,
  privacy: 'public' as const,
  color: null,
  keywords: null,
  categories: null,
  locale: null,
  replyTo: null,
  organizerCalendarAddress: null,
  participants: null,
  mayInviteSelf: false,
  mayInviteOthers: false,
  hideAttendees: false,
  recurrenceId: null,
  recurrenceIdTimeZone: null,
  recurrenceRules: null,
  recurrenceOverrides: null,
  excludedRecurrenceRules: null,
  useDefaultAlerts: true,
  alerts: null,
  locations: null,
  virtualLocations: null,
  links: null,
  relatedTo: null,
};

interface Timed { day: number; hour: number; minute?: number; hours?: number; minutes?: number }

/** A timed event on a day relative to today. */
function timed(id: string, calendar: string, title: string, t: Timed, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  // `hours` and `minutes` are the length; `{ minutes: 15 }` alone is a quarter hour.
  const minutes = (t.hours ?? (t.minutes === undefined ? 1 : 0)) * 60 + (t.minutes ?? 0);
  const duration = minutes % 60 === 0 ? `PT${minutes / 60}H` : minutes < 60 ? `PT${minutes}M` : `PT${Math.floor(minutes / 60)}H${minutes % 60}M`;
  return {
    ...BASE,
    id, uid: `${id}@meridianlabs.example`,
    calendarIds: { [calendar]: true },
    title, description: '',
    created: demoDate(-14), updated: demoDate(-2),
    start: demoISODate(t.day, t.hour, t.minute ?? 0),
    utcStart: demoAt(t.day, t.hour, t.minute ?? 0),
    utcEnd: demoAt(t.day, t.hour, (t.minute ?? 0) + minutes),
    duration, timeZone: TZ, showWithoutTime: false,
    ...extra,
  } as CalendarEvent;
}

/** An all-day event spanning `days` days from a day relative to today. */
function allDay(id: string, calendar: string, title: string, day: number, days = 1, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    ...BASE,
    id, uid: `${id}@meridianlabs.example`,
    calendarIds: { [calendar]: true },
    title, description: '',
    created: demoDate(-30), updated: demoDate(-30),
    start: demoISODate(day), utcStart: demoAt(day), utcEnd: demoAt(day + days),
    duration: `P${days}D`, timeZone: null, showWithoutTime: true,
    freeBusyStatus: 'free' as const,
    ...extra,
  } as CalendarEvent;
}

const room = (name: string, description: string) => ({ loc1: { '@type': 'Location' as const, name, description, locationTypes: null, coordinates: null, timeZone: null, links: null, relativeTo: null } });
const zoom = (id: string) => ({ vl1: { '@type': 'VirtualLocation' as const, name: 'Zoom', uri: `https://zoom.us/j/${id}`, description: null, features: null } });

type RruleDay = 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su';
const weekly = (day: RruleDay) => [{
  '@type': 'RecurrenceRule' as const, frequency: 'weekly' as const, interval: 1, firstDayOfWeek: 'mo' as const, byDay: [{ day }],
  byMonthDay: null, byMonth: null, byYearDay: null, byWeekNo: null, byHour: null, byMinute: null, bySecond: null, bySetPosition: null, count: null, until: null,
}];

/** Weekday of a day relative to today as a two-letter rrule day. */
function rruleDay(dayOffset: number): RruleDay {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  return (['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'] as const)[d.getDay()];
}

/** The go/no-go review, invited by Alice; Nora has not answered yet. */
export const GONOGO_EVENT_ID = 'demo-event-gonogo';

export function createDemoCalendarEvents(): CalendarEvent[] {
  const team = people(owner(ALICE), attendee(NORA), attendee(BOB), attendee(PRIYA), attendee(AHMED, 'tentative'), attendee(LISA));
  return [
    // ── Work ──────────────────────────────────────────────────
    timed('demo-event-standup', CAL.team, 'Beacon standup', { day: 0, hour: 9, minute: 15, minutes: 15 }, {
      description: 'Daily, 15 minutes, standing.', recurrenceRules: weekly(rruleDay(0) === 'sa' || rruleDay(0) === 'su' ? 'mo' : rruleDay(0)),
      virtualLocations: zoom('93120044817'), participants: team, created: demoDate(-60),
    }),
    timed('demo-event-beacon-weekly', CAL.team, 'Beacon weekly', { day: 0, hour: 10, hours: 1 }, {
      description: 'Status, blockers, decisions. Notes in Documents/meeting-notes.md.',
      locations: room('Room Spree', '4th floor'), virtualLocations: zoom('93120044818'), participants: team,
    }),
    timed('demo-event-lunch-sarah', CAL.work, 'Lunch with Sarah: prototype v3', { day: 0, hour: 12, minute: 30, hours: 1 }, {
      description: 'Walk through the hero options over lunch.', locations: room('Café Kranzler', 'Rosenthaler Straße 38'),
      participants: people(owner(NORA), attendee(SARAH)),
    }),
    timed('demo-event-1on1-alice', CAL.work, '1:1 Alice', { day: 0, hour: 16, minutes: 30 }, {
      recurrenceRules: weekly(rruleDay(0) === 'sa' || rruleDay(0) === 'su' ? 'tu' : rruleDay(0)), participants: people(owner(ALICE), attendee(NORA)), created: demoDate(-90),
    }),
    timed(GONOGO_EVENT_ID, CAL.work, 'Beacon go / no-go review', { day: 1, hour: 14, hours: 1 }, {
      uid: 'beacon-gonogo-2026@meridianlabs.example',
      description: '1. Soak test results (Ahmed)\n2. Rollback plan (Nora)\n3. Open bugs, BEA-412 in particular (Priya)\n4. Decision',
      locations: room('Room Spree', '4th floor'), virtualLocations: zoom('93120044901'),
      isOrigin: false, replyTo: { imip: `mailto:${ALICE.email}` }, organizerCalendarAddress: `mailto:${ALICE.email}`,
      participants: people(owner(ALICE), attendee(NORA, 'needs-action'), attendee(BOB), attendee(PRIYA), attendee(AHMED), attendee(LISA, 'tentative'), attendee(MICHAEL)),
      created: demoDate(-1, -1), updated: demoDate(-1, -1),
    }),
    timed('demo-event-coffee-bob', CAL.work, 'Coffee with Bob', { day: 1, hour: 13, minute: 15, minutes: 30 }, {
      locations: room('Café Kranzler', 'Rosenthaler Straße 38'), participants: people(owner(BOB), attendee(NORA)),
    }),
    timed('demo-event-focus', CAL.work, 'Focus: rollback runbook v2', { day: 2, hour: 9, hours: 3 }, { description: 'No meetings. Work in Bob\'s comments.', freeBusyStatus: 'busy' }),
    timed('demo-event-design-review', CAL.work, 'Website redesign: v3 review', { day: 2, hour: 14, hours: 1 }, {
      participants: people(owner(NORA), attendee(SARAH), attendee(LISA)), virtualLocations: zoom('93120044950'),
    }),
    timed('demo-event-team-lunch', CAL.team, 'Team lunch', { day: 3, hour: 12, minute: 30, hours: 1, minutes: 30 }, {
      locations: room('Markthalle Neun', 'Eisenbahnstraße 42'), participants: team,
    }),
    timed('demo-event-canary-kickoff', CAL.team, 'Canary kickoff: 5% of tenants', { day: 6, hour: 9, hours: 1 }, {
      description: 'Flip the flag for the five canary tenants, then watch for 24 h.', participants: team, virtualLocations: zoom('93120044960'),
    }),
    allDay('demo-event-launch', CAL.team, 'Beacon general availability', 8, 1, { description: 'Blog post, changelog and status page go live at 10:00.', color: '#db2d54' }),
    allDay('demo-event-lisbon', CAL.work, 'Infra Summit, Lisbon', 9, 4, {
      description: 'LH 1796 out at 08:35, LH 1797 back. Hotel Tejo Vista, confirmation 4892.771.433.',
      locations: room('Centro de Congressos de Lisboa', 'Praça das Indústrias 1'),
    }),
    timed('demo-event-talk', CAL.work, 'Talk: Rolling back without rolling over', { day: 11, hour: 11, minute: 30, minutes: 40 }, {
      description: 'Auditorium 2. AV check 08:45.', locations: room('Auditorium 2', 'Centro de Congressos de Lisboa'), participants: people(owner(KENJI), attendee(NORA)),
    }),
    timed('demo-event-speakers-dinner', CAL.work, 'Speakers\' dinner', { day: 10, hour: 20, hours: 2 }, {
      locations: room('Cervejaria Ramiro', 'Av. Alm. Reis 1H, Lisboa'), participants: people(owner(KENJI), attendee(NORA)),
    }),
    timed('demo-event-board', CAL.work, 'Board meeting: engineering update', { day: -2, hour: 15, hours: 1 }, {
      participants: people(owner(JAMES), attendee(NORA), attendee(MICHAEL)), locations: room('Room Havel', '5th floor'),
    }),
    timed('demo-event-soak-start', CAL.team, 'Soak test start', { day: -6, hour: 8, minutes: 30 }, { participants: team }),

    // ── Personal ──────────────────────────────────────────────
    timed('demo-event-bookclub', CAL.personal, 'Book club', { day: 2, hour: 19, hours: 2 }, {
      description: 'Finish Le Guin, pick the next one. Bring snacks.', locations: room('Marcus\'s place', 'Kastanienallee 80'),
      participants: people(owner(MARCUS), attendee(NORA), attendee(EMMA), attendee(DAVID)),
    }),
    timed('demo-event-dinner-carlos', CAL.personal, 'Dinner with Carlos and co.', { day: 3, hour: 19, minute: 30, hours: 2, minutes: 30 }, {
      locations: room('The Garden Bistro', 'Oranienstraße 12'), participants: people(owner(CARLOS), attendee(NORA)),
    }),
    timed('demo-event-flea-market', CAL.personal, 'Flea market, Mauerpark', { day: 4, hour: 11, hours: 2 }, { freeBusyStatus: 'free' }),
    timed('demo-event-call-mom', CAL.personal, 'Call Mom', { day: 5, hour: 18, minutes: 45 }, { recurrenceRules: weekly(rruleDay(5)), created: demoDate(-200) }),
    timed('demo-event-dentist', CAL.personal, 'Dentist: check-up', { day: 7, hour: 10, hours: 1 }, {
      locations: room('Zahnarztpraxis Dr. Weber', 'Kastanienallee 21'),
    }),
    timed('demo-event-yoga', CAL.personal, 'Yoga', { day: -1, hour: 7, hours: 1 }, { recurrenceRules: weekly(rruleDay(-1)), created: demoDate(-120), freeBusyStatus: 'free' }),

    // ── Birthdays ─────────────────────────────────────────────
    allDay('demo-event-bday-carlos', CAL.birthdays, 'Carlos Rivera\'s birthday', -3),
    allDay('demo-event-bday-alice', CAL.birthdays, 'Alice Johnson\'s birthday', 12),
    allDay('demo-event-bday-emma', CAL.birthdays, 'Emma Wilson\'s birthday', 5),
  ];
}

/**
 * The iMIP request behind the go/no-go invitation mail. The demo client
 * serves this as the .ics blob and returns the matching event from
 * parseCalendarEvents, so the invitation banner can offer an RSVP.
 */
export function createGoNoGoInvitationIcs(): string {
  const event = createDemoCalendarEvents().find((e) => e.id === GONOGO_EVENT_ID)!;
  const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const attendees = Object.values(event.participants ?? {}).filter((p) => !p.roles.owner).map((p) =>
    `ATTENDEE;CN=${p.name};ROLE=REQ-PARTICIPANT;PARTSTAT=${p.participationStatus.toUpperCase()};RSVP=TRUE:mailto:${p.email}`);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Meridian Labs//Bulwark Demo//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${stamp(event.created ?? event.utcStart!)}`,
    `DTSTART:${stamp(event.utcStart!)}`,
    `DTEND:${stamp(event.utcEnd!)}`,
    `SUMMARY:${event.title}`,
    `DESCRIPTION:${(event.description ?? '').replace(/\n/g, '\\n')}`,
    'LOCATION:Room Spree\\, 4th floor',
    `ORGANIZER;CN=${ALICE.name}:mailto:${ALICE.email}`,
    ...attendees,
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
