'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { answerInvitation } from '@/lib/calendar-rsvp';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  Calendar,
  CalendarCheck,
  CalendarX,
  Clock,
  MapPin,
  Users,
  Loader2,
  Check,
  HelpCircle,
  X,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from '@/components/icons';
import { useTranslations, useLocale } from 'next-intl';
import { InvitationPrintSync } from '@/lib/print/invitation-print';
import { useRouter } from '@/i18n/navigation';
import { isDocumentRTL } from '@/i18n/direction';
import { useAuthStore } from '@/stores/auth-store';
import { useShallow } from "zustand/react/shallow";
import { useEmailStore } from '@/stores/email-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email, CalendarEvent } from '@/lib/jmap/types';
import {
  findCalendarAttachment,
  getInvitationMethod,
  getInvitationActorSummary,
  getInvitationTrustAssessment,
  formatEventSummary,
  formatInvitationSchedule,
  invitationAnsweredAt,
  invitationAnsweredKey,
  findParticipantByEmails,
  extractMethodFromRawIcs,
  type EventSummary,
  type InvitationMethod,
  type InvitationTrustAssessment,
} from '@/lib/calendar-invitation';
import { participantsAskedAgain } from '@/lib/calendar-participants';
import { planCancellationRemoval, sameRecurrenceId, type CancellationRemoval } from '@/lib/calendar-cancellation';
import { cn } from '@/lib/utils';
import { getEventStartDate } from '@/lib/calendar-utils';
import { descriptionAsText } from '@/lib/calendar-description';
import { sanitizeColor } from '@/components/calendar/event-card';
import { RecipientPopover } from './recipient-popover';
import { useCalendarErrorMessage } from '@/hooks/use-calendar-error-message';
import { useAccountOwner } from '@/components/calendar/answer-bars';
import { resolveTimeZone } from '@/lib/timezone';

interface InvitationChangeItem {
  label: string;
  before: string;
  after: string;
}

function getBannerTitle(t: ReturnType<typeof useTranslations>, method: InvitationMethod): string {
  switch (method) {
    case 'publish':
      return t('published_title');
    case 'reply':
      return t('response_title');
    case 'add':
      return t('update_title');
    case 'counter':
      return t('counter_title');
    case 'refresh':
      return t('refresh_title');
    case 'declinecounter':
      return t('declined_counter_title');
    case 'cancel':
      return t('cancelled_title');
    case 'request':
    case 'unknown':
    default:
      return t('title');
  }
}

function getActorMessage(
  t: ReturnType<typeof useTranslations>,
  method: InvitationMethod,
  actorName: string,
  actorStatus: string | null,
): string | null {
  switch (method) {
    case 'reply':
      return actorStatus
        ? t('actor_response_info', { name: actorName, status: actorStatus })
        : t('actor_sent_info', { name: actorName });
    case 'counter':
      return t('actor_counter_info', { name: actorName });
    case 'refresh':
      return t('actor_refresh_info', { name: actorName });
    case 'declinecounter':
      return t('actor_declined_counter_info', { name: actorName });
    case 'request':
    case 'publish':
    case 'add':
    case 'cancel':
      return t('actor_sent_info', { name: actorName });
    default:
      return null;
  }
}

function getBannerInfo(
  t: ReturnType<typeof useTranslations>,
  method: InvitationMethod,
  userIsOrganizer: boolean,
  supportsCalendar: boolean,
): string | null {
  if (!supportsCalendar) {
    return t('no_calendar');
  }

  switch (method) {
    case 'request':
      return t('request_info');
    case 'publish':
      return t('published_info');
    case 'reply':
      return t(userIsOrganizer ? 'response_info_organizer' : 'response_info');
    case 'add':
      return t('update_info');
    case 'cancel':
      return t('cancel_info');
    case 'counter':
      return t(userIsOrganizer ? 'counter_info_organizer' : 'counter_info');
    case 'refresh':
      return t(userIsOrganizer ? 'refresh_info_organizer' : 'refresh_info');
    case 'declinecounter':
      return t('declined_counter_info');
    default:
      return null;
  }
}

function getTrustMessage(
  t: ReturnType<typeof useTranslations>,
  trustAssessment: InvitationTrustAssessment,
): string | null {
  switch (trustAssessment.reason) {
    case 'authentication_failed':
      return t('authentication_failed_info');
    case 'authentication_missing':
      return t('authentication_missing_info');
    case 'sender_mismatch':
      return t('sender_mismatch_info', {
        sender: trustAssessment.senderEmail ?? '',
        organizer: trustAssessment.organizerEmail ?? '',
      });
    case 'sender_mismatch_unverified':
      return t('sender_mismatch_unverified_info', {
        sender: trustAssessment.senderEmail ?? '',
        organizer: trustAssessment.organizerEmail ?? '',
      });
    case 'attendee_mismatch':
      return t('attendee_mismatch_info', {
        sender: trustAssessment.senderEmail ?? '',
        attendee: trustAssessment.attendeeEmail ?? '',
      });
    case 'attendee_mismatch_unverified':
      return t('attendee_mismatch_unverified_info', {
        sender: trustAssessment.senderEmail ?? '',
        attendee: trustAssessment.attendeeEmail ?? '',
      });
    default:
      return null;
  }
}

function getParticipationLabel(
  t: ReturnType<typeof useTranslations>,
  status: string | null,
): string | null {
  switch (status) {
    case 'accepted':
      return t('response_accepted');
    case 'tentative':
      return t('response_tentative');
    case 'declined':
      return t('response_declined');
    case 'delegated':
      return t('response_delegated');
    case 'needs-action':
      return t('response_needed');
    default:
      return null;
  }
}

function getParticipationTone(status: string | null): string {
  switch (status) {
    case 'accepted':
      return 'bg-success/15 text-success';
    case 'tentative':
      return 'bg-warning/15 text-warning';
    case 'declined':
      return 'bg-destructive/15 text-destructive';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

function hasMeaningfulDifference<T>(left: T | null | undefined, right: T | null | undefined): boolean {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

function getViewActionLabel(
  t: ReturnType<typeof useTranslations>,
  method: InvitationMethod,
  userIsOrganizer: boolean,
): string {
  if (method === 'counter' && userIsOrganizer) {
    return t('review_proposal');
  }

  if (method === 'refresh' && userIsOrganizer) {
    return t('review_request');
  }

  return t('view_in_calendar');
}

/**
 * The event in the calendar a counter proposal is about. An attendee's
 * proposal for one occurrence of a recurring meeting names that occurrence
 * by its recurrence id, one for the whole meeting names none. Matched on the
 * uid alone, the first event with it got the proposal - any occurrence in
 * view. A proposal for a whole series of which only occurrences are in view
 * has no event here, and is not applied to one of them.
 */
function counterTarget(events: CalendarEvent[], proposal: Partial<CalendarEvent>): CalendarEvent | null {
  const sameUid = events.filter((event) => event.uid === proposal.uid);
  if (!proposal.recurrenceId) return sameUid.find((event) => !event.recurrenceId) ?? null;
  return sameUid.find((event) => sameRecurrenceId(event, proposal)) ?? null;
}

function buildProposalPatch(
  currentEvent: Partial<CalendarEvent> | null,
  proposedEvent: Partial<CalendarEvent> | null,
): Partial<CalendarEvent> | null {
  if (!currentEvent || !proposedEvent) {
    return null;
  }

  const patch: Partial<CalendarEvent> = {};

  if (typeof proposedEvent.title === 'string' && proposedEvent.title !== currentEvent.title) {
    patch.title = proposedEvent.title;
  }

  if (typeof proposedEvent.description === 'string' && proposedEvent.description !== currentEvent.description) {
    patch.description = proposedEvent.description;
  }

  if (typeof proposedEvent.descriptionContentType === 'string' && proposedEvent.descriptionContentType !== currentEvent.descriptionContentType) {
    patch.descriptionContentType = proposedEvent.descriptionContentType;
  }

  if (typeof proposedEvent.start === 'string' && proposedEvent.start !== currentEvent.start) {
    patch.start = proposedEvent.start;
  }

  if (typeof proposedEvent.duration === 'string' && proposedEvent.duration !== currentEvent.duration) {
    patch.duration = proposedEvent.duration;
  }

  if ((proposedEvent.timeZone ?? null) !== (currentEvent.timeZone ?? null)) {
    patch.timeZone = proposedEvent.timeZone ?? null;
  }

  if ((proposedEvent.showWithoutTime ?? false) !== (currentEvent.showWithoutTime ?? false)) {
    patch.showWithoutTime = proposedEvent.showWithoutTime ?? false;
  }

  if (hasMeaningfulDifference(proposedEvent.locations, currentEvent.locations)) {
    patch.locations = proposedEvent.locations ?? null;
  }

  if (hasMeaningfulDifference(proposedEvent.virtualLocations, currentEvent.virtualLocations)) {
    patch.virtualLocations = proposedEvent.virtualLocations ?? null;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function buildInvitationChangeItems(
  t: ReturnType<typeof useTranslations>,
  currentEvent: Partial<CalendarEvent> | null,
  proposedEvent: Partial<CalendarEvent> | null,
  formatSchedule: (summary: EventSummary) => string,
): InvitationChangeItem[] {
  if (!currentEvent || !proposedEvent) {
    return [];
  }

  const currentSummary = formatEventSummary(currentEvent);
  const proposedSummary = formatEventSummary(proposedEvent);
  const changes: InvitationChangeItem[] = [];

  if (currentSummary.title !== proposedSummary.title && proposedSummary.title) {
    changes.push({
      label: t('change_title'),
      before: currentSummary.title || t('change_empty'),
      after: proposedSummary.title,
    });
  }

  const currentSchedule = currentSummary.start
    ? formatSchedule(currentSummary)
    : t('change_empty');
  const proposedSchedule = proposedSummary.start
    ? formatSchedule(proposedSummary)
    : t('change_empty');
  if (currentSchedule !== proposedSchedule && proposedSummary.start) {
    changes.push({
      label: t('change_time'),
      before: currentSchedule,
      after: proposedSchedule,
    });
  }

  if ((currentSummary.location ?? '') !== (proposedSummary.location ?? '') && proposedSummary.location) {
    changes.push({
      label: t('change_location'),
      before: currentSummary.location || t('change_empty'),
      after: proposedSummary.location,
    });
  }

  const currentDescription = descriptionAsText(currentEvent);
  const proposedDescription = descriptionAsText(proposedEvent);
  if (currentDescription !== proposedDescription && proposedDescription) {
    changes.push({
      label: t('change_description'),
      before: currentDescription || t('change_empty'),
      after: proposedDescription,
    });
  }

  return changes;
}

function getMethodIconTone(method: InvitationMethod, actorStatus?: string | null): string {
  switch (method) {
    case 'cancel':
    case 'declinecounter':
      return 'bg-destructive/15 text-destructive';
    case 'counter':
      return 'bg-warning/15 text-warning';
    case 'reply':
      switch (actorStatus) {
        case 'accepted': return 'bg-success/15 text-success';
        case 'tentative': return 'bg-warning/15 text-warning';
        case 'declined': return 'bg-destructive/15 text-destructive';
        default: return 'bg-primary/15 text-primary';
      }
    case 'request':
    case 'add':
    case 'publish':
      return 'bg-primary/15 text-primary';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

interface CalendarInvitationBannerProps {
  email: Email;
}

type BannerState = 'loading' | 'parsed' | 'rsvp-sent' | 'imported' | 'error';

export function CalendarInvitationBanner({ email }: CalendarInvitationBannerProps) {
  const t = useTranslations('email_viewer.calendar_invitation');
  const tEvent = useTranslations('ux_pim_event');
  const describeError = useCalendarErrorMessage();
  const locale = useLocale();
  const router = useRouter();
  const client = useAuthStore((s) => s.client);
  const getClientForAccount = useAuthStore((s) => s.getClientForAccount);
  const viewingAccountId = useEmailStore((s) => s.viewingAccountId);
  const selectedMailboxId = useEmailStore((s) => s.selectedMailbox);
  const viewMailboxes = useEmailStore((s) => (
    s.viewingAccountId ? (s.accountMailboxes[s.viewingAccountId] ?? s.mailboxes) : s.mailboxes
  ));
  // Blobs are per-account, so the invitation must be parsed and fetched through
  // the login the message is reachable from - its source stamp in aggregate
  // views, the per-account sidebar's viewing account otherwise - and against its
  // owning JMAP account. Against any other account Stalwart answers
  // CalendarEvent/parse with an error. Calendar actions (import / RSVP) keep
  // using the active client, whose calendars the calendar store holds. (#867)
  const sourceClientId = email.sourceClientAccountId ?? viewingAccountId ?? null;
  const parseClient = (sourceClientId ? getClientForAccount?.(sourceClientId) : undefined) ?? client;
  // An undecorated message opened directly in a shared/group folder (the
  // "Shared" sidebar section) has no source stamp, but its blob lives in the
  // folder owner's account, reached through the viewing client - mirrors
  // resolveViewAccountId in the email store. Otherwise the blob is in the
  // client's own mail account.
  const viewedMailbox = viewMailboxes.find((m) => m.id === selectedMailboxId);
  const sharedOwnerAccountId = viewedMailbox?.isShared ? viewedMailbox.accountId : undefined;
  const blobAccountId = email.sourceAccountId ?? sharedOwnerAccountId ?? parseClient?.getAccountId();
  // Every address the user sends as, primary first: an invite may be
  // addressed to an alias identity (#1283).
  const identityEmails = useAuthStore(useShallow((s) => {
    const emails = [s.primaryIdentity?.email, ...s.identities.map((identity) => identity.email)]
      .filter((address): address is string => Boolean(address))
      .map((address) => address.toLowerCase());
    return Array.from(new Set(emails));
  }));
  const calendarInvitationParsingEnabled = useSettingsStore((s) => s.calendarInvitationParsingEnabled);
  const storeCalendars = useCalendarStore((s) => s.calendars);
  // An invitation in a group mailbox or in a mailbox another person shared
  // (a delegate reading the boss's mail) is answered in that account's
  // calendar, as that account: as the group without SENT-BY, as the person
  // with SENT-BY naming the user (lib/calendar-delegate.ts). Only for an
  // account of the active login, whose calendars the store holds.
  const mailAccountId = email.sourceAccountId ?? sharedOwnerAccountId ?? null;
  const ownAccountIds = [client?.getAccountId?.(), client?.getCalendarsAccountId?.()];
  const sharedMailAccount = mailAccountId && parseClient === client && !ownAccountIds.includes(mailAccountId)
    ? mailAccountId
    : null;
  const sharedAccountCalendars = sharedMailAccount ? storeCalendars.filter((c) => c.accountId === sharedMailAccount && !c.isTasksOnly) : [];
  const sharedCalendar = sharedAccountCalendars.find((c) => c.isDefault) ?? sharedAccountCalendars[0] ?? null;
  const mailOwner = useAccountOwner(
    client,
    sharedMailAccount,
    sharedCalendar?.accountName ?? (sharedMailAccount ? client?.getAccountInfo?.(sharedMailAccount)?.name : undefined),
  );
  const answerAs = sharedMailAccount && mailOwner ? mailOwner : null;
  // The addresses that pick "your" participant in the invitation.
  const actingEmails = answerAs ? answerAs.emails : identityEmails;
  // Answering for a person (not a group) names the user with SENT-BY.
  // Set below, once the function exists; the parse callback reads it late.
  const loadSharedCopyRef = useRef<(uid: string) => Promise<CalendarEvent | null>>(async () => null);
  const answerOptions = answerAs && !answerAs.isGroup && identityEmails[0]
    ? { sentBy: `mailto:${identityEmails[0]}` }
    : undefined;
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  // The user's zone, as getEffectiveTimeZone resolves it.
  const userTimeZone = resolveTimeZone(useSettingsStore((s) => s.timeZone));
  const { calendars, supportsCalendar, importEvents, rsvpEvent, updateEvent, deleteEvent, events: storeEvents, setSelectedDate } = useCalendarStore(useShallow((state) => ({
    calendars: state.calendars,
    supportsCalendar: state.supportsCalendar,
    importEvents: state.importEvents,
    rsvpEvent: state.rsvpEvent,
    updateEvent: state.updateEvent,
    deleteEvent: state.deleteEvent,
    events: state.events,
    setSelectedDate: state.setSelectedDate,
  })));

  const [state, setState] = useState<BannerState>('loading');
  const [parsedEvent, setParsedEvent] = useState<Partial<CalendarEvent> | null>(null);
  const [rsvpStatus, setRsvpStatus] = useState<string | null>(null);
  const [answeredAt, setAnsweredAt] = useState<Date | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showCalendarPicker, setShowCalendarPicker] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string>('');
  const [rawIcsMethod, setRawIcsMethod] = useState<InvitationMethod>('unknown');
  const [isCollapsed, setIsCollapsed] = useState(false);
  // Underlying failure shown under the generic parse error, so "wrong account"
  // or a network failure is distinguishable from an unparsable file.
  const [parseError, setParseError] = useState<string | null>(null);
  // What removing a cancelled meeting from the calendar takes, read from the
  // events stored with its uid; null until known.
  const [cancelRemoval, setCancelRemoval] = useState<CancellationRemoval | null>(null);

  const attachment = findCalendarAttachment(email);

  const parseEvent = useCallback(async () => {
    if (!client || !parseClient || !blobAccountId || !attachment || !calendarInvitationParsingEnabled) return;
    setState('loading');
    setActionNotice(null);
    setActionError(null);
    setParseError(null);
    try {
      // JMAP strips parameters from Content-Type (RFC 8621), so method=REQUEST
      // is lost. Fetch raw ICS to extract METHOD as a reliable fallback - in
      // parallel with parsing to save a roundtrip.
      const [events, rawText] = await Promise.all([
        parseClient.parseCalendarEvents(blobAccountId, attachment.blobId),
        (async () => {
          try {
            const blob = await parseClient.fetchBlob(attachment.blobId, 'invite.ics', 'text/calendar', blobAccountId);
            return await blob.text();
          } catch {
            return null;
          }
        })(),
      ]);

      if (events.length === 0) {
        setState('error');
        return;
      }

      const parsed = events[0];
      setParsedEvent(parsed);

      if (rawText) {
        const icsMethod = extractMethodFromRawIcs(rawText);
        if (icsMethod !== 'unknown') {
          setRawIcsMethod(icsMethod);
        }
      }

      setState('parsed');

      // Hydrate the calendar store with the matching event in the background -
      // only needed for the "already in calendar" pill, must not block the banner.
      // Filter by UID server-side; the previous unfiltered query fetched up to
      // 1000 events plus multiple /get batches just to find one match.
      if (parsed.uid && supportsCalendar && sharedMailAccount) {
        // The copy in the shared or group account the message belongs to.
        void loadSharedCopyRef.current(parsed.uid).catch(() => { /* ignore lookup failure */ });
      } else if (parsed.uid && supportsCalendar) {
        const storeHasIt = useCalendarStore.getState().events.some((e) => e.uid === parsed.uid);
        if (!storeHasIt) {
          client.queryCalendarEvents({ uid: parsed.uid })
            .then((matching) => {
              if (matching.length === 0) return;
              useCalendarStore.setState((s) => {
                const existingIds = new Set(s.events.map((e) => e.id));
                const newEvents = matching.filter((e) => !existingIds.has(e.id));
                return newEvents.length > 0 ? { events: [...s.events, ...newEvents] } : s;
              });
            })
            .catch(() => { /* ignore lookup failure */ });
        }
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
      setState('error');
    }
  }, [calendarInvitationParsingEnabled, client, parseClient, blobAccountId, attachment, supportsCalendar, sharedMailAccount]);

  useEffect(() => {
    if (attachment && calendarInvitationParsingEnabled) {
      parseEvent();
    }
  }, [calendarInvitationParsingEnabled, email.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (calendars.length > 0 && !selectedCalendarId) {
      const defaultCal = calendars.find((c) => c.isDefault) || calendars[0];
      setSelectedCalendarId(defaultCal.id);
    }
  }, [calendars, selectedCalendarId]);

  useEffect(() => {
    if (!showCalendarPicker) return;
    const close = () => setShowCalendarPicker(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [showCalendarPicker]);

  const detectedMethod = parsedEvent && attachment ? getInvitationMethod(parsedEvent, { email, attachment }) : 'unknown';
  const method = detectedMethod !== 'unknown' ? detectedMethod : rawIcsMethod;
  const isCancellation = method === 'cancel';

  useEffect(() => {
    setCancelRemoval(null);
    if (!client || !supportsCalendar || !isCancellation || !parsedEvent?.uid) return;
    let current = true;
    client.queryCalendarEvents({ uid: parsedEvent.uid })
      .then((stored) => {
        if (current) setCancelRemoval(planCancellationRemoval(stored, parsedEvent));
      })
      .catch(() => { /* no remove action then */ });
    return () => { current = false; };
  }, [client, supportsCalendar, isCancellation, parsedEvent]);

  if (!attachment || !calendarInvitationParsingEnabled) return null;

  const summary = parsedEvent ? formatEventSummary(parsedEvent) : null;
  const isResponseOnly = method === 'reply' || method === 'refresh' || method === 'counter' || method === 'declinecounter';
  const showDetails = !isCollapsed;
  const allowsRsvp = method === 'request';
  const allowsImport = method === 'request' || method === 'publish' || method === 'add' || method === 'unknown';

  /** Finds the invitation's copy in the shared or group account and adds it to the store. */
  async function loadSharedCopy(uid: string): Promise<CalendarEvent | null> {
    if (!client || !sharedMailAccount) return null;
    const known = useCalendarStore.getState().events.find((e) => e.uid === uid && e.accountId === sharedMailAccount);
    if (known) return known;
    const found = await client.queryCalendarEvents({ uid }, undefined, undefined, sharedMailAccount);
    // As the store holds a shared account's events: prefixed ids, store calendar ids.
    const accountCalendars = useCalendarStore.getState().calendars.filter((c) => c.accountId === sharedMailAccount);
    const mapped = found.map((e): CalendarEvent => ({
      ...e,
      id: `${sharedMailAccount}:${e.id}`,
      originalId: e.id,
      originalCalendarIds: e.calendarIds,
      calendarIds: Object.fromEntries(Object.entries(e.calendarIds ?? {}).map(([id, on]) => [
        accountCalendars.find((c) => (c.originalId ?? c.id) === id)?.id ?? `${sharedMailAccount}:${id}`, on,
      ])),
      accountId: sharedMailAccount,
      accountName: accountCalendars[0]?.accountName,
      isShared: true,
    }));
    if (mapped.length === 0) return null;
    useCalendarStore.setState((s) => {
      const ids = new Set(s.events.map((e) => e.id));
      const added = mapped.filter((e) => !ids.has(e.id));
      return added.length > 0 ? { events: [...s.events, ...added] } : s;
    });
    return mapped.find((e) => !e.recurrenceId) ?? mapped[0];
  }

  loadSharedCopyRef.current = loadSharedCopy;

  // The copy in the account the message belongs to. For the user's own
  // mailbox that is their own calendar: a calendar shared with them by
  // someone invited too holds that person's copy under the same uid, and
  // answering there would answer for them (or, on Stalwart 0.16, for
  // whichever address it picks; the duplicate attendees and wrong senders of
  // #634).
  const existingEvent = parsedEvent?.uid
    ? storeEvents.find((e) => e.uid === parsedEvent.uid && (sharedMailAccount ? e.accountId === sharedMailAccount : !e.isShared))
    : null;

  const currentUserParticipant = existingEvent
    ? findParticipantByEmails(existingEvent, actingEmails)
    : null;

  const fallbackParsedParticipant = !currentUserParticipant && parsedEvent
    ? findParticipantByEmails(parsedEvent, actingEmails)
    : null;

  const participantForUser = currentUserParticipant || fallbackParsedParticipant;
  // Accept participant if they have attendee role OR if they are not exclusively an organizer
  // Some JMAP servers may not set roles.attendee explicitly in CalendarEvent/parse results
  const isOnlyOrganizer = participantForUser?.participant.roles
    ? (participantForUser.participant.roles.owner || participantForUser.participant.roles.chair)
      && !participantForUser.participant.roles.attendee
    : false;
  const myParticipant = participantForUser && !isOnlyOrganizer ? participantForUser : null;

  const currentRsvp = rsvpStatus
    || myParticipant?.participant.participationStatus
    || null;
  const userIsOrganizer = Boolean(isOnlyOrganizer);
  const senderAddress = email.from?.[0]?.email?.toLowerCase();
  const userIsSender = Boolean(senderAddress && identityEmails.includes(senderAddress));
  const bannerTitle = getBannerTitle(t, method);
  // Once answered, the banner says so instead of asking (pim-23).
  const answeredDate = myParticipant
    ? invitationAnsweredAt(
      rsvpStatus ? answeredAt : null,
      myParticipant.participant,
      currentUserParticipant ? existingEvent?.updated : null,
    )
    : null;
  const answeredKey = myParticipant && supportsCalendar ? invitationAnsweredKey(method, currentRsvp, !!answeredDate) : null;
  const answeredInfo = answeredKey
    ? tEvent(answeredKey, {
      date: answeredDate
        ? new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: userTimeZone }).format(answeredDate)
        : '',
    })
    : null;
  const bannerInfo = answeredInfo ?? getBannerInfo(t, method, userIsOrganizer, supportsCalendar);
  const trustAssessment = parsedEvent && !userIsSender ? getInvitationTrustAssessment(parsedEvent, email, method, identityEmails) : null;
  const trustMessage = trustAssessment ? getTrustMessage(t, trustAssessment) : null;
  const participationLabel = getParticipationLabel(t, currentRsvp);
  const actorSummary = parsedEvent ? getInvitationActorSummary(parsedEvent, method) : null;
  const actorName = actorSummary?.name || actorSummary?.email || t('actor_unknown');
  const actorStatus = getParticipationLabel(t, actorSummary?.participationStatus ?? null);
  const actorMessage = actorSummary ? getActorMessage(t, method, actorName, actorStatus) : null;
  // For REQUEST method, allow RSVP even if we can't find the user in participants:
  // the email was sent TO the user, so they are an attendee. handleRsvp handles
  // the import-then-find-participant flow for this case.
  const canRespond = supportsCalendar && allowsRsvp && !isResponseOnly && !userIsOrganizer
    && (Boolean(myParticipant) || method === 'request');
  // A counter proposal applies to the occurrence it names, or to the meeting itself.
  const proposalTarget = method === 'counter' && parsedEvent ? counterTarget(storeEvents, parsedEvent) : existingEvent;
  const proposalPatch = proposalTarget && parsedEvent ? buildProposalPatch(proposalTarget, parsedEvent) : null;
  // Applying a proposal sends it to every attendee. It has to come from one
  // of the meeting's participants: anyone who learned the uid can write one,
  // naming any attendee as the one proposing.
  const proposalFromParticipant = Boolean(
    proposalTarget && senderAddress && findParticipantByEmails(proposalTarget, [senderAddress]),
  );
  // A cancellation that fails authentication, or comes from someone other
  // than the organizer without passing it, does not get to remove anything.
  const canRemoveCancelled = Boolean(
    client
    && supportsCalendar
    && isCancellation
    && !userIsSender
    && trustAssessment?.level !== 'warning'
    && (cancelRemoval?.kind === 'delete' || cancelRemoval?.kind === 'exclude')
  );
  const cancellationOutdated = isCancellation && cancelRemoval?.kind === 'outdated';

  const resolveExistingEventForRsvp = async () => {
    if (sharedMailAccount) return existingEvent;
    if (!client || !existingEvent) {
      return existingEvent;
    }

    if (existingEvent.participants && Object.keys(existingEvent.participants).length > 0) {
      return existingEvent;
    }

    const hydratedEvent = await client.getCalendarEvent(existingEvent.id);
    if (!hydratedEvent) {
      return existingEvent;
    }

    useCalendarStore.setState((state) => ({
      events: state.events.map((event) => event.id === hydratedEvent.id ? hydratedEvent : event),
    }));

    return hydratedEvent;
  };

  const handleRsvp = async (status: 'accepted' | 'tentative' | 'declined') => {
    if (!client || !parsedEvent || isProcessing) return;
    // An invitation of a shared or group mailbox goes into that account's calendar.
    const calId = sharedMailAccount
      ? sharedCalendar?.id
      : selectedCalendarId || calendars.find((c) => c.isDefault)?.id || calendars[0]?.id;
    setActionNotice(null);
    setActionError(null);
    setIsProcessing(true);
    try {
      const outcome = await answerInvitation({
        client,
        store: { rsvpEvent, updateEvent, importEvents, events: () => useCalendarStore.getState().events },
        parsedEvent,
        existingEvent,
        myParticipant,
        actingEmails,
        calendarId: calId,
        sharedMailAccount,
        answerOptions,
        resolveExisting: () => (existingEvent
          ? resolveExistingEventForRsvp()
          : parsedEvent.uid ? loadSharedCopy(parsedEvent.uid) : Promise.resolve(null)),
      }, status);
      // 'stopped': a plugin stopped it and said why; keep the old answer.
      if (outcome === 'answered') {
        setRsvpStatus(status);
        setAnsweredAt(new Date());
        setActionNotice(t('rsvp_sent'));
        setState('parsed');
      } else if (outcome === 'added') {
        setActionNotice(t('added'));
        setState('parsed');
      } else if (outcome === 'failed') {
        setActionError(t('action_failed'));
      }
    } catch (err) {
      console.error('[CalendarInvitation] RSVP failed:', err);
      setActionError(describeError(err, t('action_failed')));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleViewInCalendar = () => {
    const target = existingEvent?.start ? existingEvent : parsedEvent;
    if (target?.start) {
      const parsedDate = getEventStartDate({
        start: target.start,
        utcStart: target.utcStart ?? null,
        showWithoutTime: target.showWithoutTime ?? false,
        timeZone: target.timeZone,
      });
      if (!Number.isNaN(parsedDate.getTime())) {
        setSelectedDate(parsedDate);
      }
    }

    setShowCalendarPicker(false);
    router.push('/calendar');
  };

  const handleImport = async (calendarId?: string) => {
    const calId = calendarId || selectedCalendarId || calendars.find((c) => c.isDefault)?.id || calendars[0]?.id;
    if (!client || !parsedEvent || !calId || isProcessing) {
      if (!calId) setActionError(t('action_failed'));
      return;
    }
    setActionNotice(null);
    setActionError(null);
    setIsProcessing(true);
    try {
      const count = await importEvents(client, [parsedEvent], calId, { throwIfNoneImported: true });
      if (count === null) return;
      if (count > 0) {
        setActionNotice(t('added'));
        setState('parsed');
      } else {
        setActionError(t('action_failed'));
      }
    } catch (err) {
      setActionError(describeError(err, t('action_failed')));
    } finally {
      setIsProcessing(false);
    }
  };

  const formatSchedule = (eventSummary: EventSummary) => formatInvitationSchedule(eventSummary, {
    locale,
    timeZone: userTimeZone,
    hour12: timeFormat === '12h',
  });

  const proposedChanges = method === 'counter' && proposalTarget && parsedEvent
    ? buildInvitationChangeItems(t, proposalTarget, parsedEvent, formatSchedule)
    : [];
  const canApplyProposal = Boolean(
    client
    && proposalTarget?.id
    && userIsOrganizer
    && method === 'counter'
    && proposalPatch
    && proposalFromParticipant
  );
  const viewActionLabel = getViewActionLabel(t, method, userIsOrganizer);

  const handleApplyProposal = async () => {
    if (!client || !proposalTarget?.id || !proposalPatch || isProcessing) {
      return;
    }

    setActionNotice(null);
    setActionError(null);
    setIsProcessing(true);

    try {
      // A proposal for another time moves the event: its attendees are asked
      // again, as the editor and a drag ask them (participantsAskedAgain).
      const moves = (['start', 'duration', 'timeZone', 'showWithoutTime'] as const).some((key) => key in proposalPatch);
      const participants = moves ? participantsAskedAgain(proposalTarget) : null;
      if (!(await updateEvent(client, proposalTarget.id, participants ? { ...proposalPatch, participants } : proposalPatch, true))) return;
      setActionNotice(t('proposal_applied'));
      setState('parsed');
      setRsvpStatus(null);
    } catch (err) {
      setActionError(describeError(err, t('action_failed')));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRemoveCancelled = async () => {
    const cancel = parsedEvent;
    if (!client || !cancel?.uid || isProcessing) return;
    setActionNotice(null);
    setActionError(null);
    setIsProcessing(true);
    try {
      // Planned again on the events as they are now: the calendar may have
      // changed since the mail was opened.
      const removal = planCancellationRemoval(await client.queryCalendarEvents({ uid: cancel.uid }), cancel);
      setCancelRemoval(removal);
      // No scheduling messages: the organizer cancelled it, there is no one
      // to tell.
      if (removal.kind === 'delete') {
        for (const id of removal.ids) {
          if (!(await deleteEvent(client, id, false))) return;
        }
      } else if (removal.kind === 'exclude') {
        if (!(await updateEvent(client, removal.id, removal.patch, false))) return;
      } else {
        return;
      }
      // Occurrences of it in view go as well.
      useCalendarStore.setState((s) => ({
        events: s.events.filter((event) => event.uid !== cancel.uid
          || (Boolean(cancel.recurrenceId) && !sameRecurrenceId(event, cancel))),
      }));
      setCancelRemoval({ kind: 'none' });
      setActionNotice(t('removed_from_calendar'));
    } catch (err) {
      setActionError(describeError(err, t('action_failed')));
    } finally {
      setIsProcessing(false);
    }
  };

  if (state === 'loading') {
    return (
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-muted text-muted-foreground flex items-center justify-center flex-shrink-0 shadow-sm">
          <Calendar className="w-5 h-5" />
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{t('loading')}</span>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-destructive/15 text-destructive flex items-center justify-center flex-shrink-0 shadow-sm">
          <AlertCircle className="w-5 h-5" />
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm text-destructive">{t('parse_error')}</span>
          {parseError && (
            <span className="text-xs text-muted-foreground truncate" title={parseError}>{parseError}</span>
          )}
        </div>
      </div>
    );
  }

  const iconTone = getMethodIconTone(method, actorSummary?.participationStatus);

  const hasStatusPills = Boolean(
    existingEvent
    || userIsOrganizer
    || (participationLabel && myParticipant)
    || actionNotice
    || (parsedEvent?.status && parsedEvent.status !== 'confirmed')
  );

  const showActionsRow = showDetails && (
    canRespond
    || (supportsCalendar && !existingEvent && allowsImport && !isResponseOnly && !isCancellation)
    || canApplyProposal
    || (supportsCalendar && (existingEvent || parsedEvent))
    || !supportsCalendar
  );

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md transition-colors",
        isCollapsed && "cursor-pointer hover:bg-muted/50",
      )}
      onClick={isCollapsed ? () => setIsCollapsed(false) : undefined}
      onKeyDown={isCollapsed ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setIsCollapsed(false);
        }
      } : undefined}
      role={isCollapsed ? 'button' : undefined}
      tabIndex={isCollapsed ? 0 : undefined}
      aria-expanded={isCollapsed ? false : undefined}
    >
      {/* When and where, for the printout of this message: its print copy has no card. */}
      {summary && (
        <InvitationPrintSync
          emailId={email.id}
          print={{
            heading: bannerTitle,
            rows: ([
              [t('change_title'), summary.title ?? ''],
              [t('change_time'), summary.start ? formatSchedule(summary) : ''],
              [t('change_location'), summary.location ?? ''],
              [t('organizer_label'), summary.organizer ? (summary.organizerEmail && summary.organizerEmail !== summary.organizer ? `${summary.organizer} <${summary.organizerEmail}>` : summary.organizer) : ''],
            ] as Array<[string, string]>).filter(([, value]) => value),
          }}
        />
      )}
      {/* Avatar-style icon */}
      <div className={cn(
        "w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm",
        iconTone,
      )}>
        {isCancellation ? (
          <CalendarX className="w-5 h-5" />
        ) : (
          <Calendar className="w-5 h-5" />
        )}
      </div>

      {/* Content column */}
      <div className="flex-1 min-w-0 space-y-2">
        {/* Eyebrow + title + collapse */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[0.6875rem] font-semibold text-muted-foreground">
              {bannerTitle}
            </div>
            {summary?.title && (
              <h3 className={cn(
                "text-sm font-semibold leading-snug break-words",
                isCancellation ? "line-through text-muted-foreground" : "text-foreground",
              )}>
                {summary.title}
              </h3>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-shrink-0">
            {parsedEvent?.sequence != null && parsedEvent.sequence > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground whitespace-nowrap">
                {t('event_updated', { sequence: parsedEvent.sequence })}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsCollapsed((prev) => !prev);
              }}
              aria-expanded={!isCollapsed}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5 transition-colors"
            >
              {isCollapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
              {isCollapsed ? t('expand') : t('collapse')}
            </button>
          </div>
        </div>

        {/* Meta rows */}
        {showDetails && summary && (summary.start || summary.location || summary.attendeeCount > 0) && (
          <div className="flex flex-col gap-1 text-sm text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1">
            {summary.start && (
              <span className="flex items-center gap-1.5 min-w-0">
                <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate" data-testid="invitation-when">
                  {formatSchedule(summary)}
                </span>
              </span>
            )}
            {summary.location && (
              <span className="flex items-center gap-1.5 min-w-0">
                <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{summary.location}</span>
              </span>
            )}
            {summary.attendeeCount > 0 && (
              <span className="text-muted-foreground">{t('attendees', { count: summary.attendeeCount })}</span>
            )}
          </div>
        )}

        {/* Organizer row (clickable, left-aligned) */}
        {showDetails && summary?.organizer && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground min-w-0">
            <Users className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="flex-shrink-0">{t('organizer_label')}</span>
            {summary.organizerEmail ? (
              <RecipientPopover
                name={summary.organizer}
                email={summary.organizerEmail}
                className="text-sm truncate"
              />
            ) : (
              <span className="truncate text-foreground">{summary.organizer}</span>
            )}
          </div>
        )}

        {/* Status pills */}
        {showDetails && hasStatusPills && (
          <div className="flex flex-wrap items-center gap-1.5">
            {parsedEvent?.status && parsedEvent.status !== 'confirmed' && (
              <span className={cn(
                "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
                parsedEvent.status === 'cancelled'
                  ? "bg-destructive/15 text-destructive"
                  : "bg-warning/15 text-warning",
              )}>
                {t(`event_status_${parsedEvent.status}`)}
              </span>
            )}
            {existingEvent && (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-[0.6875rem] font-medium text-success">
                {t('already_in_calendar')}
              </span>
            )}
            {userIsOrganizer && (
              <span className="rounded-full bg-info/15 px-2 py-0.5 text-[0.6875rem] font-medium text-info">
                {t('organizer_role')}
              </span>
            )}
            {participationLabel && myParticipant && (
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[0.6875rem] font-medium',
                getParticipationTone(currentRsvp),
              )}>
                {t('your_response', { status: participationLabel })}
              </span>
            )}
            {actionNotice && (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-[0.6875rem] font-medium text-success">
                {actionNotice}
              </span>
            )}
          </div>
        )}

        {/* Info / actor messages */}
        {showDetails && (bannerInfo || actorMessage || actorSummary?.participationComment) && (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {bannerInfo && <p className="leading-relaxed">{bannerInfo}</p>}
            {cancellationOutdated && <p className="leading-relaxed">{t('cancel_outdated')}</p>}
            {actorMessage && <p>{actorMessage}</p>}
            {actorSummary?.participationComment && (
              <p className="italic">{t('actor_note', { comment: actorSummary.participationComment })}</p>
            )}
          </div>
        )}

        {/* Trust warning */}
        {showDetails && trustMessage && trustAssessment && (
          <div className={cn(
            'flex items-start gap-2 text-sm rounded-md px-3 py-2 border',
            trustAssessment.level === 'warning'
              ? 'bg-destructive/10 text-destructive border-destructive/30'
              : 'bg-warning/10 text-warning border-warning/30',
          )}>
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="flex-1">{trustMessage}</span>
          </div>
        )}

        {/* Proposed changes */}
        {showDetails && proposedChanges.length > 0 && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs">
            <div className="font-medium text-foreground mb-1.5">{t('proposed_changes')}</div>
            <div className="space-y-1.5">
              {proposedChanges.map((change) => (
                <div key={change.label}>
                  <span className="font-medium text-foreground">{change.label}: </span>
                  <span className="text-muted-foreground">{t('change_from_to', { before: change.before, after: change.after })}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action error */}
        {showDetails && actionError && (
          <div className="flex items-start gap-2 text-sm rounded-md px-3 py-2 bg-destructive/10 text-destructive border border-destructive/30">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="flex-1">{actionError}</span>
          </div>
        )}

        {/* Actions */}
        {showActionsRow && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {canRespond && (
            <>
              <button
                onClick={() => handleRsvp('accepted')}
                disabled={isProcessing}
                aria-pressed={currentRsvp === 'accepted'}
                className={cn(
                  "inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md transition-colors min-h-[36px] disabled:opacity-50 border",
                  currentRsvp === 'accepted'
                    ? "bg-success/15 text-success border-success/30"
                    : "text-muted-foreground hover:text-success border-border hover:border-success/30 hover:bg-success/10",
                )}
              >
                <Check className="w-3.5 h-3.5" />
                {t('accept')}
              </button>
              <button
                onClick={() => handleRsvp('tentative')}
                disabled={isProcessing}
                aria-pressed={currentRsvp === 'tentative'}
                className={cn(
                  "inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md transition-colors min-h-[36px] disabled:opacity-50 border",
                  currentRsvp === 'tentative'
                    ? "bg-warning/15 text-warning border-warning/30"
                    : "text-muted-foreground hover:text-warning border-border hover:border-warning/30 hover:bg-warning/10",
                )}
              >
                <HelpCircle className="w-3.5 h-3.5" />
                {t('maybe')}
              </button>
              <button
                onClick={() => handleRsvp('declined')}
                disabled={isProcessing}
                aria-pressed={currentRsvp === 'declined'}
                className={cn(
                  "inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md transition-colors min-h-[36px] disabled:opacity-50 border",
                  currentRsvp === 'declined'
                    ? "bg-destructive/15 text-destructive border-destructive/30"
                    : "text-muted-foreground hover:text-destructive border-border hover:border-destructive/30 hover:bg-destructive/10",
                )}
              >
                <X className="w-3.5 h-3.5" />
                {t('decline')}
              </button>
              <div className="w-px h-5 bg-border mx-1" />
            </>
          )}

          {supportsCalendar && !existingEvent && allowsImport && !isResponseOnly && !isCancellation && (
            <>
              <button
                ref={pickerTriggerRef}
                onClick={() => {
                  if (calendars.length <= 1) {
                    handleImport();
                    return;
                  }
                  if (showCalendarPicker) {
                    setShowCalendarPicker(false);
                    return;
                  }
                  if (pickerTriggerRef.current) {
                    const rect = pickerTriggerRef.current.getBoundingClientRect();
                    setPickerPosition(
                      isDocumentRTL()
                        ? { top: rect.bottom + 4, right: window.innerWidth - rect.right }
                        : { top: rect.bottom + 4, left: rect.left }
                    );
                  }
                  setShowCalendarPicker(true);
                }}
                disabled={isProcessing}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px] disabled:opacity-50"
              >
                <CalendarCheck className="w-3.5 h-3.5" />
                {t('add_to_calendar')}
                {calendars.length > 1 && <ChevronDown className="w-3 h-3" />}
              </button>

              {showCalendarPicker && calendars.length > 1 && pickerPosition && typeof document !== 'undefined' && createPortal(
                <div
                  className="fixed w-52 bg-background rounded-lg shadow-lg border border-border z-50 py-1"
                  style={{ top: pickerPosition.top, left: pickerPosition.left, right: pickerPosition.right }}
                >
                  <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    {t('select_calendar')}
                  </div>
                  {calendars.map((cal) => (
                    <button
                      key={cal.id}
                      onClick={() => {
                        setShowCalendarPicker(false);
                        handleImport(cal.id);
                      }}
                      className="w-full px-3 py-1.5 text-sm text-start hover:bg-muted flex items-center gap-2"
                    >
                      <span
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: sanitizeColor(cal.color) }}
                      />
                      <span className="truncate text-foreground">{cal.name}</span>
                    </button>
                  ))}
                </div>,
                document.body,
              )}
            </>
          )}

          {canRemoveCancelled && (
            <button
              onClick={handleRemoveCancelled}
              disabled={isProcessing}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive px-3 py-1.5 rounded-md border border-border hover:border-destructive/30 hover:bg-destructive/10 transition-colors min-h-[36px] disabled:opacity-50"
            >
              <CalendarX className="w-3.5 h-3.5" />
              {t('remove_from_calendar')}
            </button>
          )}

          {canApplyProposal && (
            <button
              onClick={handleApplyProposal}
              disabled={isProcessing}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px] disabled:opacity-50"
            >
              <CalendarCheck className="w-3.5 h-3.5" />
              {t('apply_proposal')}
            </button>
          )}

          {supportsCalendar && (existingEvent || parsedEvent) && (
            <button
              onClick={handleViewInCalendar}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-muted transition-colors min-h-[36px]"
            >
              <Calendar className="w-3.5 h-3.5" />
              {viewActionLabel}
              <ArrowRight className="w-3 h-3" />
            </button>
          )}

          {!supportsCalendar && (
            <span className="text-xs text-muted-foreground italic">{t('no_calendar')}</span>
          )}

          {isProcessing && (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground ms-auto" />
          )}
        </div>
        )}
      </div>
    </div>
  );
}
