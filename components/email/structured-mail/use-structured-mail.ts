"use client";

import { useEffect, useMemo, useState } from 'react';
import type { Email } from '@/lib/jmap/types';
import {
  loadAirportZones,
  mergeCandidates,
  needsAirportZones,
  readStructuredMailDetailed,
  resolveCards,
  type StructuredCard,
} from '@/lib/structured-mail';
import { getStructuredMailTrust, structuredHtmlPart } from '@/lib/structured-mail/trust';
import { useStructuredMailEnabled } from '@/lib/structured-mail-gate';
import { useAuthStore } from '@/stores/auth-store';
import { resolveEmailBlobContext, type EmailBlobContext } from '@/stores/email-store';
import { CARD_SOURCES } from './sources';

function mailDateOf(email: Pick<Email, 'sentAt' | 'receivedAt'>): Date {
  return new Date(email.sentAt ?? email.receivedAt);
}

async function resolveAll(cards: StructuredCard[]): Promise<StructuredCard[]> {
  if (!needsAirportZones(cards)) return resolveCards(cards);
  try {
    return resolveCards(cards, await loadAirportZones());
  } catch {
    // Without the table no flight card can be checked, so none is shown.
    return resolveCards(cards);
  }
}

/**
 * The booking, parcel and order cards of an open message: empty unless the
 * admin gate is on and the message passes getStructuredMailTrust. Cards that
 * need nothing asynchronous show at once; flights wait for the airport time
 * zone table, and cards from attachment sources (CARD_SOURCES) are merged in
 * once read, so a card never shows with unchecked times. A message whose
 * markup describes a booking (even one validation rejected) is read from the
 * markup alone: the sources aren't asked, so nothing is downloaded and a pass
 * can't revive a rejected or cancelled booking or show one booking twice.
 */
export function useStructuredMail(email: Email | null | undefined, blobSource?: EmailBlobContext): StructuredCard[] {
  const enabled = useStructuredMailEnabled();
  const client = useAuthStore((state) => state.client);
  const trusted = useMemo(() => !!email && enabled && getStructuredMailTrust(email).trusted, [email, enabled]);
  const html = email ? structuredHtmlPart(email)?.value : undefined;
  // An HTML part whose text hasn't loaded yet may still hold booking markup.
  const htmlPending = html === undefined && !!email?.htmlBody?.some((part) => part.type === 'text/html');

  const { cards: markup, hadBookingMarkup } = useMemo(() => {
    if (!trusted || !email || !html) return { cards: [] as StructuredCard[], hadBookingMarkup: false };
    return readStructuredMailDetailed(html, { mailDate: mailDateOf(email) });
    // email.id and the HTML identify the input; the rest of the object may change identity freely.
  }, [trusted, email?.id, html]); // eslint-disable-line react-hooks/exhaustive-deps
  const askSources = !hadBookingMarkup && !htmlPending;

  const immediate = useMemo(() => resolveCards(markup.filter((card) => card.kind !== 'flight')), [markup]);
  const [settled, setSettled] = useState<{ key: string; cards: StructuredCard[] } | null>(null);
  const settleKey = `${email?.id ?? ''}|${trusted}|${markup.length}|${askSources}`;

  useEffect(() => {
    if (!trusted || !email) return;
    const sources = askSources ? CARD_SOURCES : [];
    const needsWork = needsAirportZones(markup) || sources.length > 0;
    if (!needsWork) return;
    const controller = new AbortController();
    const blob = blobSource ?? resolveEmailBlobContext(email, client);
    (async () => {
      const fromSources = (await Promise.all(sources.map((source) =>
        source({ email, mailDate: mailDateOf(email), blob, signal: controller.signal }).catch(() => [] as StructuredCard[]),
      ))).flat();
      const combined = fromSources.length > 0
        ? mergeCandidates([...markup, ...fromSources].map((card) => ({ card, problems: [] })))
        : markup;
      const cards = await resolveAll(combined);
      if (!controller.signal.aborted) setSettled({ key: settleKey, cards });
    })();
    return () => controller.abort();
    // markup, askSources and settleKey change together with the message.
  }, [trusted, markup, settleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!trusted) return [];
  return settled?.key === settleKey ? settled.cards : immediate;
}
