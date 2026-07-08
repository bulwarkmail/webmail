'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
} from 'lucide-react';
import { useTranslations, useFormatter } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email, CalendarEvent } from '@/lib/jmap/types';
import {
  findCalendarAttachment,
  getInvitationMethod,
  getInvitationActorSummary,
  getInvitationTrustAssessment,
  formatEventSummary,
  findParticipantByEmail,
  extractMethodFromRawIcs,
  type InvitationMethod,
  type InvitationTrustAssessment,
} from '@/lib/calendar-invitation';
import { cn } from '@/lib/utils';
import { sanitizeColor } from '@/components/calendar/event-card';
import { RecipientPopover } from './recipient-popover';

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
  formatDateTime: (dateStr: string | null) => string,
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
    ? `${formatDateTime(currentSummary.start)}${currentSummary.end ? ` - ${formatDateTime(currentSummary.end)}` : ''}`
    : t('change_empty');
  const proposedSchedule = proposedSummary.start
    ? `${formatDateTime(proposedSummary.start)}${proposedSummary.end ? ` - ${formatDateTime(proposedSummary.end)}` : ''}`
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

  if ((currentEvent.description ?? '') !== (proposedEvent.description ?? '') && proposedEvent.description) {
    changes.push({
      label: t('change_description'),
      before: currentEvent.description || t('change_empty'),
      after: proposedEvent.description,
    });
  }

  return changes;
}

function buildParticipantsForRsvp(
  event: Partial<CalendarEvent>,
  participantId: string,
  status: 'accepted' | 'tentative' | 'declined',
): Record<string, NonNullable<CalendarEvent['participants']>[string]> | null {
  if (!event.participants) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(event.participants).map(([id, participant]) => [
      id,
      {
        ...participant,
        participationStatus: id === participantId ? status : participant.participationStatus,
      },
    ]),
  );
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
  const format = useFormatter();
  const router = useRouter();
  const client = useAuthStore((s) => s.client);
  const currentUserEmail = useAuthStore((s) => s.primaryIdentity?.email);
  const calendarInvitationParsingEnabled = useSettingsStore((s) => s.calendarInvitationParsingEnabled);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const { calendars, supportsCalendar, importEvents, rsvpEvent, updateEvent, events: storeEvents, setSelectedDate } = useCalendarStore();

  const [state, setState] = useState<BannerState>('loading');
  const [parsedEvent, setParsedEvent] = useState<Partial<CalendarEvent> | null>(null);
  const [rsvpStatus, setRsvpStatus] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showCalendarPicker, setShowCalendarPicker] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<{ top: number; left: number } | null>(null);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string>('');
  const [rawIcsMethod, setRawIcsMethod] = useState<InvitationMethod>('unknown');
  const [isCollapsed, setIsCollapsed] = useState(false);

  const attachment = findCalendarAttachment(email);

  const parseEvent = useCallback(async () => {
    if (!client || !attachment || !calendarInvitationParsingEnabled) return;
    setState('loading');
    setActionNotice(null);
    setActionError(null);
    try {
      // JMAP strips parameters from Content-Type (RFC 8621), so method=REQUEST
      // is lost. Fetch raw ICS to extract METHOD as a reliable fallback - in
      // parallel with parsing to save a roundtrip.
      const [events, rawText] = await Promise.all([
        client.parseCalendarEvents(client.getCalendarsAccountId(), attachment.blobId),
        (async () => {
          try {
            const blob = await client.fetchBlob(attachment.blobId, 'invite.ics', 'text/calendar');
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
      if (parsed.uid && supportsCalendar) {
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
    } catch {
      setState('error');
    }
  }, [calendarInvitationParsingEnabled, client, attachment, supportsCalendar]);

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

  if (!attachment || !calendarInvitationParsingEnabled) return null;

  const detectedMethod = parsedEvent ? getInvitationMethod(parsedEvent, { email, attachment }) : 'unknown';
  const method = detectedMethod !== 'unknown' ? detectedMethod : rawIcsMethod;
  const summary = parsedEvent ? formatEventSummary(parsedEvent) : null;
  const isCancellation = method === 'cancel';
  const isResponseOnly = method === 'reply' || method === 'refresh' || method === 'counter' || method === 'declinecounter';
  const showDetails = !isCollapsed;
  const allowsRsvp = method === 'request';
  const allowsImport = method === 'request' || method === 'publish' || method === 'add' || method === 'unknown';

  const existingEvent = parsedEvent?.uid
    ? storeEvents.find((e) => e.uid === parsedEvent.uid)
    : null;

  const currentUserParticipant = existingEvent && currentUserEmail
    ? findParticipantByEmail(existingEvent, currentUserEmail)
    : null;

  const fallbackParsedParticipant = !currentUserParticipant && parsedEvent && currentUserEmail
    ? findParticipantByEmail(parsedEvent, currentUserEmail)
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
  const userIsSender = Boolean(
    currentUserEmail && email.from?.[0]?.email?.toLowerCase() === currentUserEmail.toLowerCase()
  );
  const bannerTitle = getBannerTitle(t, method);
  const bannerInfo = getBannerInfo(t, method, userIsOrganizer, supportsCalendar);
  const trustAssessment = parsedEvent && !userIsSender ? getInvitationTrustAssessment(parsedEvent, email, method) : null;
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
  const proposalPatch = existingEvent && parsedEvent ? buildProposalPatch(existingEvent, parsedEvent) : null;

  const resolveExistingEventForRsvp = async () => {
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
    const calId = selectedCalendarId || calendars.find((c) => c.isDefault)?.id || calendars[0]?.id;
    setActionNotice(null);
    setActionError(null);
    setIsProcessing(true);
    const replyToForRsvp = parsedEvent.replyTo
      || (parsedEvent.organizerCalendarAddress ? { imip: parsedEvent.organizerCalendarAddress } : null);

    // The iMIP REPLY to the organizer is sent by the server: rsvpEvent /
    // updateEvent below pass sendSchedulingMessages=true to CalendarEvent/set
    // and Stalwart queues the iTIP REPLY itself. A manual client-side reply
    // here produced duplicate emails.
    try {
      const eventForRsvp = existingEvent
        ? await resolveExistingEventForRsvp()
        : null;
      const existingEventParticipant = eventForRsvp && currentUserEmail
        ? findParticipantByEmail(eventForRsvp, currentUserEmail)
        : null;
      const canFallbackToParsedParticipant = Boolean(
        existingEvent
        && myParticipant
        && (!eventForRsvp?.participants || Object.keys(eventForRsvp.participants).length === 0)
      );
      if (eventForRsvp && existingEventParticipant) {
        await rsvpEvent(client, eventForRsvp.id, existingEventParticipant.id, status, replyToForRsvp);
        setRsvpStatus(status);
        setActionNotice(t('rsvp_sent'));
        setState('parsed');
      } else if (eventForRsvp && canFallbackToParsedParticipant && myParticipant) {
        const repairedParticipants = buildParticipantsForRsvp(parsedEvent, myParticipant.id, status);

        if (!repairedParticipants) {
          setActionError(t('action_failed'));
        } else {
          await updateEvent(client, eventForRsvp.id, {
            participants: repairedParticipants,
            // Stalwart routes the iTIP REPLY via the stored ORGANIZER
            // (organizerCalendarAddress; the RFC 8984 replyTo is retired).
            // Only repair a missing organizer - attendees may not modify it.
            ...(replyToForRsvp?.imip && !eventForRsvp.organizerCalendarAddress
              ? { organizerCalendarAddress: replyToForRsvp.imip }
              : {}),
          }, true);
          setRsvpStatus(status);
          setActionNotice(t('rsvp_sent'));
          setState('parsed');
        }
      } else if (eventForRsvp) {
        setActionError(t('action_failed'));
      } else if (calId) {
        const imported = await importEvents(client, [parsedEvent], calId);
        if (imported > 0) {
          const newEvent = useCalendarStore.getState().events.find(
            (e) => e.uid === parsedEvent.uid
          );
          const participant = myParticipant
            || (newEvent && currentUserEmail ? findParticipantByEmail(newEvent, currentUserEmail) : null);
          if (newEvent && participant) {
            await rsvpEvent(client, newEvent.id, participant.id, status, replyToForRsvp);
            setRsvpStatus(status);
            setActionNotice(t('rsvp_sent'));
          } else {
            setActionNotice(t('added'));
          }
          setState('parsed');
        } else {
          setActionError(t('action_failed'));
        }
      } else {
        setActionError(t('action_failed'));
      }
    } catch (err) {
      console.error('[CalendarInvitation] RSVP failed:', err);
      setActionError(t('action_failed'));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleViewInCalendar = () => {
    const targetDate = existingEvent?.utcStart
      || existingEvent?.start
      || parsedEvent?.utcStart
      || parsedEvent?.start;

    if (targetDate) {
      const parsedDate = new Date(targetDate);
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
      const count = await importEvents(client, [parsedEvent], calId);
      if (count > 0) {
        setActionNotice(t('added'));
        setState('parsed');
      } else {
        setActionError(t('action_failed'));
      }
    } catch {
      setActionError(t('action_failed'));
    } finally {
      setIsProcessing(false);
    }
  };

  const isAllDayEvent = parsedEvent?.showWithoutTime ?? false;

  const formatDateTime = (dateStr: string | null) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    if (isAllDayEvent) {
      return format.dateTime(date, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
    }
    return format.dateTime(date, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: timeFormat === '12h',
    });
  };

  const proposedChanges = method === 'counter' && existingEvent && parsedEvent
    ? buildInvitationChangeItems(t, existingEvent, parsedEvent, formatDateTime)
    : [];
  const canApplyProposal = Boolean(
    client
    && existingEvent?.id
    && userIsOrganizer
    && method === 'counter'
    && proposalPatch
  );
  const viewActionLabel = getViewActionLabel(t, method, userIsOrganizer);

  const handleApplyProposal = async () => {
    if (!client || !existingEvent?.id || !proposalPatch || isProcessing) {
      return;
    }

    setActionNotice(null);
    setActionError(null);
    setIsProcessing(true);

    try {
      await updateEvent(client, existingEvent.id, proposalPatch, true);
      setActionNotice(t('proposal_applied'));
      setState('parsed');
      setRsvpStatus(null);
    } catch {
      setActionError(t('action_failed'));
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
        <span className="text-sm text-destructive">{t('parse_error')}</span>
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
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
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
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground whitespace-nowrap">
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
                <span className="truncate">
                  {formatDateTime(summary.start)}
                  {summary.end && ` – ${formatDateTime(summary.end)}`}
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
              <span className="text-muted-foreground/80">{t('attendees', { count: summary.attendeeCount })}</span>
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
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                parsedEvent.status === 'cancelled'
                  ? "bg-destructive/15 text-destructive"
                  : "bg-warning/15 text-warning",
              )}>
                {t(`event_status_${parsedEvent.status}`)}
              </span>
            )}
            {existingEvent && (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                {t('already_in_calendar')}
              </span>
            )}
            {userIsOrganizer && (
              <span className="rounded-full bg-info/15 px-2 py-0.5 text-[11px] font-medium text-info">
                {t('organizer_role')}
              </span>
            )}
            {participationLabel && myParticipant && (
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                getParticipationTone(currentRsvp),
              )}>
                {t('your_response', { status: participationLabel })}
              </span>
            )}
            {actionNotice && (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                {actionNotice}
              </span>
            )}
          </div>
        )}

        {/* Info / actor messages */}
        {showDetails && (bannerInfo || actorMessage || actorSummary?.participationComment) && (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {bannerInfo && <p className="leading-relaxed">{bannerInfo}</p>}
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
                    setPickerPosition({ top: rect.bottom + 4, left: rect.left });
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
                  style={{ top: pickerPosition.top, left: pickerPosition.left }}
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
