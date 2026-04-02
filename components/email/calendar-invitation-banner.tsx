'use client';

import { useState, useEffect, useCallback } from 'react';
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

function getMethodAccentClass(method: InvitationMethod, actorStatus?: string | null): string {
  switch (method) {
    case 'cancel':
    case 'declinecounter':
      return 'border-l-red-500 dark:border-l-red-400';
    case 'request':
    case 'add':
      return 'border-l-blue-500 dark:border-l-blue-400';
    case 'counter':
      return 'border-l-amber-500 dark:border-l-amber-400';
    case 'reply':
      switch (actorStatus) {
        case 'accepted': return 'border-l-green-500 dark:border-l-green-400';
        case 'tentative': return 'border-l-amber-500 dark:border-l-amber-400';
        case 'declined': return 'border-l-red-500 dark:border-l-red-400';
        default: return 'border-l-blue-500 dark:border-l-blue-400';
      }
    default:
      return 'border-l-slate-400 dark:border-l-slate-500';
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
  const [selectedCalendarId, setSelectedCalendarId] = useState<string>('');
  const [rawIcsMethod, setRawIcsMethod] = useState<InvitationMethod>('unknown');

  const attachment = findCalendarAttachment(email);

  const parseEvent = useCallback(async () => {
    if (!client || !attachment || !calendarInvitationParsingEnabled) return;
    setState('loading');
    setActionNotice(null);
    setActionError(null);
    try {
      const events = await client.parseCalendarEvents(client.getCalendarsAccountId(), attachment.blobId);
      if (events.length > 0) {
        const parsed = events[0];
        setParsedEvent(parsed);

        // JMAP strips parameters from Content-Type (RFC 8621), so method=REQUEST
        // is lost. Fetch raw ICS to extract METHOD as a reliable fallback.
        try {
          const blob = await client.fetchBlob(attachment.blobId, 'invite.ics', 'text/calendar');
          const rawText = await blob.text();
          const icsMethod = extractMethodFromRawIcs(rawText);
          if (icsMethod !== 'unknown') {
            setRawIcsMethod(icsMethod);
          }
        } catch { /* ignore - fall back to heuristic detection */ }

        if (parsed.uid && supportsCalendar) {
          const storeHasIt = useCalendarStore.getState().events.some((e) => e.uid === parsed.uid);
          if (!storeHasIt) {
            try {
              const serverEvents = await client.queryCalendarEvents({});
              const matching = serverEvents.filter((e) => e.uid === parsed.uid);
              if (matching.length > 0) {
                useCalendarStore.setState((s) => {
                  const existingIds = new Set(s.events.map((e) => e.id));
                  const newEvents = matching.filter((e) => !existingIds.has(e.id));
                  return newEvents.length > 0 ? { events: [...s.events, ...newEvents] } : s;
                });
              }
            } catch { /* ignore lookup failure */ }
          }
        }
        setState('parsed');
      } else {
        setState('error');
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

  if (!attachment || !calendarInvitationParsingEnabled) return null;

  const detectedMethod = parsedEvent ? getInvitationMethod(parsedEvent, { email, attachment }) : 'unknown';
  const method = detectedMethod !== 'unknown' ? detectedMethod : rawIcsMethod;
  const summary = parsedEvent ? formatEventSummary(parsedEvent) : null;
  const isCancellation = method === 'cancel';
  const isResponseOnly = method === 'reply' || method === 'refresh' || method === 'counter' || method === 'declinecounter';
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
  const actionFeedback = actionNotice;
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

    const imipStatus = status.toUpperCase() as 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';
    const organizerEmail = parsedEvent?.replyTo?.imip?.replace('mailto:', '')
      || parsedEvent?.organizerCalendarAddress?.replace('mailto:', '')
      || summary?.organizerEmail
      || null;

    // Send the iMIP REPLY email to the organizer (client-side scheduling).
    // Called after updating the local calendar event. Best-effort — if it
    // fails we still report the RSVP as sent since the calendar was updated.
    const sendImipReply = async () => {
      if (!organizerEmail || !parsedEvent?.uid || !currentUserEmail) {
        return;
      }

      try {
        await client.sendImipReply({
          organizerEmail,
          organizerName: summary?.organizer || undefined,
          attendeeEmail: currentUserEmail,
          attendeeName: myParticipant?.participant.name || undefined,
          uid: parsedEvent.uid,
          summary: parsedEvent.title,
          dtStart: parsedEvent.start || undefined,
          dtEnd: summary?.end || undefined,
          timeZone: parsedEvent.timeZone || undefined,
          isAllDay: parsedEvent.showWithoutTime || false,
          sequence: parsedEvent.sequence,
          status: imipStatus,
        });
      } catch {
        // Best-effort: don't block the RSVP success notification
      }
    };

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
        await sendImipReply();
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
            replyTo: replyToForRsvp ?? undefined,
          }, true);
          await sendImipReply();
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
            await sendImipReply();
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

  const accentClass = getMethodAccentClass(method, actorSummary?.participationStatus);

  if (state === 'loading') {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 flex items-center gap-2.5">
        <Calendar className="w-4 h-4 text-primary flex-shrink-0" />
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('loading')}</span>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 flex items-center gap-2.5">
        <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
        <span className="text-sm text-destructive">{t('parse_error')}</span>
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border border-border overflow-hidden border-l-4", accentClass)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-muted/30 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          {isCancellation ? (
            <CalendarX className="w-4 h-4 text-destructive flex-shrink-0" />
          ) : (
            <Calendar className="w-4 h-4 text-primary flex-shrink-0" />
          )}
          <span className="text-sm font-medium text-foreground truncate">{bannerTitle}</span>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3 space-y-2.5">
        <div className="lg:flex lg:gap-6">
          {/* Left: Event info */}
          <div className="lg:flex-1 space-y-2.5 min-w-0">
            {/* Event title */}
            {summary?.title && (
              <div className="flex items-start justify-between gap-2">
                <h3 className={cn(
                  "text-base font-semibold leading-snug",
                  isCancellation ? "line-through text-muted-foreground" : "text-foreground"
                )}>
                  {summary.title}
                </h3>
                {parsedEvent?.sequence != null && parsedEvent.sequence > 0 && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground flex-shrink-0 whitespace-nowrap">
                    {t('event_updated', { sequence: parsedEvent.sequence })}
                  </span>
                )}
              </div>
            )}

            {/* Event details */}
            <div className="lg:flex lg:items-center lg:gap-4 lg:flex-wrap space-y-1 lg:space-y-0">
              {summary?.start && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>
                    {formatDateTime(summary.start)}
                    {summary.end && ` – ${formatDateTime(summary.end)}`}
                  </span>
                </div>
              )}
              {summary?.location && (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{summary.location}</span>
                </div>
              )}
              {summary?.organizer && (
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Users className="w-3.5 h-3.5 flex-shrink-0" />
                  {t('organizer', { name: summary.organizer })}
                </span>
              )}
              {summary && summary.attendeeCount > 0 && (
                <span className="text-sm text-muted-foreground">{t('attendees', { count: summary.attendeeCount })}</span>
              )}
            </div>
          </div>

          {/* Right: Info & actor messages on large screens */}
          <div className="lg:flex-shrink-0 lg:text-right lg:max-w-xs mt-2.5 lg:mt-0 space-y-1">
            {bannerInfo && (
              <p className="text-xs text-muted-foreground leading-relaxed">{bannerInfo}</p>
            )}
            {actorMessage && (
              <p className="text-xs text-muted-foreground">{actorMessage}</p>
            )}
            {actorSummary?.participationComment && (
              <p className="text-xs text-muted-foreground italic">
                {t('actor_note', { comment: actorSummary.participationComment })}
              </p>
            )}
          </div>
        </div>

        {/* Status badges */}
        {(existingEvent || userIsOrganizer || (participationLabel && myParticipant) || actionFeedback || (parsedEvent?.status && parsedEvent.status !== 'confirmed')) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {parsedEvent?.status && parsedEvent.status !== 'confirmed' && (
              <span className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                parsedEvent.status === 'cancelled'
                  ? "bg-destructive/15 text-destructive"
                  : "bg-warning/15 text-warning"
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
                getParticipationTone(currentRsvp)
              )}>
                {t('your_response', { status: participationLabel })}
              </span>
            )}
            {actionFeedback && (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                {actionFeedback}
              </span>
            )}
          </div>
        )}

        {/* Proposed changes */}
        {proposedChanges.length > 0 && (
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

        {/* Trust warning */}
        {trustMessage && trustAssessment && (
          <div className={cn(
            'flex items-start gap-1.5 text-xs rounded-md px-3 py-2',
            trustAssessment.level === 'warning'
              ? 'bg-destructive/10 text-destructive border border-destructive/20'
              : 'bg-warning/10 text-warning border border-warning/20'
          )}>
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{trustMessage}</span>
          </div>
        )}

        {/* Action error */}
        {actionError && (
          <div className="flex items-start gap-1.5 text-xs text-destructive rounded-md px-3 py-2 bg-destructive/10 border border-destructive/20">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{actionError}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-4 py-2.5 border-t border-border bg-muted/20 flex items-center gap-2 flex-wrap">
        {canRespond && (
          <>
            <button
              onClick={() => handleRsvp('accepted')}
              disabled={isProcessing}
              aria-pressed={currentRsvp === 'accepted'}
              className={cn(
                "inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md transition-colors min-h-[36px] disabled:opacity-50 border",
                currentRsvp === 'accepted'
                  ? "bg-success/15 text-success border-success/20"
                  : "text-muted-foreground hover:text-success border-border hover:border-success/30 hover:bg-success/10"
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
                  ? "bg-warning/15 text-warning border-warning/20"
                  : "text-muted-foreground hover:text-warning border-border hover:border-warning/30 hover:bg-warning/10"
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
                  ? "bg-destructive/15 text-destructive border-destructive/20"
                  : "text-muted-foreground hover:text-destructive border-border hover:border-destructive/30 hover:bg-destructive/10"
              )}
            >
              <X className="w-3.5 h-3.5" />
              {t('decline')}
            </button>

            <div className="w-px h-5 bg-border" />
          </>
        )}

        {supportsCalendar && !existingEvent && allowsImport && !isResponseOnly && !isCancellation && (
          <div className="relative">
            <button
              onClick={() => {
                if (calendars.length <= 1) {
                  handleImport();
                } else {
                  setShowCalendarPicker(!showCalendarPicker);
                }
              }}
              disabled={isProcessing}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px] disabled:opacity-50"
            >
              <CalendarCheck className="w-3.5 h-3.5" />
              {t('add_to_calendar')}
              {calendars.length > 1 && <ChevronDown className="w-3 h-3" />}
            </button>

            {showCalendarPicker && calendars.length > 1 && (
              <div className="absolute left-0 top-full mt-1 w-52 bg-background rounded-lg shadow-lg border border-border z-10 py-1">
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
                    className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2"
                  >
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: sanitizeColor(cal.color) }}
                    />
                    <span className="truncate text-foreground">{cal.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
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
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground ml-auto" />
        )}
      </div>
    </div>
  );
}
