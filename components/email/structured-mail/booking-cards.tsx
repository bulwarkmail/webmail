"use client";

import { Fragment, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, Bed, Bus, Car, Clock, MapPin, Phone, Plane, Restaurant, Ticket, Train, Users } from "@/components/icons";
import {
  formatAddress,
  formatMomentDate,
  formatMomentTime,
  formatPlace,
  isOtherZone,
  isWebLink,
  legPlaceLabel,
  legService,
  nightsBetween,
  routeRuns,
  routeTitle,
  sameLocalDate,
} from "@/lib/structured-mail/format";
import type {
  Booking,
  EventBooking,
  Link,
  LodgingBooking,
  Moment,
  RentalCarBooking,
  RestaurantBooking,
  TransportBooking,
  TransportLeg,
} from "@/lib/structured-mail/types";
import { cn } from "@/lib/utils";
import {
  ACTION_CHIP_CLASS,
  BookingStatusPill,
  CardLink,
  CardShell,
  MetaRow,
  PILL_CLASS,
  When,
  eyebrowText,
  useCardFormat,
} from "./card-parts";
import { CopyValueChip } from "./copy-value-chip";

export interface BookingCardProps<B extends Booking = Booking> {
  booking: B;
  emailId?: string;
  /** Slot in the action row, for "Add to calendar". */
  calendarActions?: (booking: Booking) => ReactNode;
}

const TRANSPORT_ICON = { flight: Plane, train: Train, bus: Bus } as const;

interface CardLinkSpec {
  link?: Link;
  label: string;
}

/**
 * The action row: reference chip, the links this card shows and the
 * calendar slot. Undefined when there is none of them, so no empty row.
 */
function bookingActions(booking: Booking, calendarActions: BookingCardProps["calendarActions"], emailId: string | undefined, links: CardLinkSpec[]): ReactNode {
  const shown = links.filter((l) => isWebLink(l.link));
  if (!booking.reference && !calendarActions && shown.length === 0) return undefined;
  return (
    <BookingActions booking={booking} calendarActions={calendarActions}>
      {shown.map((l) => <CardLink key={l.label} link={l.link} label={l.label} emailId={emailId} />)}
    </BookingActions>
  );
}

function BookingActions({ booking, calendarActions, children }: Pick<BookingCardProps, "booking" | "calendarActions"> & { children: ReactNode }) {
  const t = useTranslations("email_viewer.structured_mail");
  return (
    <>
      {booking.reference && (
        <CopyValueChip
          value={booking.reference}
          label={t("reference")}
          copyLabel={t("copy_reference", { value: booking.reference })}
          copiedMessage={t("copied_reference")}
          className={ACTION_CHIP_CLASS}
        />
      )}
      {children}
      {calendarActions?.(booking)}
    </>
  );
}

function PassengersRow({ names }: { names: string[] }) {
  const t = useTranslations("email_viewer.structured_mail");
  if (names.length === 0) return null;
  return (
    <MetaRow icon={Users}>
      <span className="sr-only">{t("passengers")}: </span>
      {names.join(", ")}
    </MetaRow>
  );
}

function Leg({ leg, kind, bookingCancelled }: { leg: TransportLeg; kind: TransportBooking["kind"]; bookingCancelled: boolean }) {
  const t = useTranslations("email_viewer.structured_mail");
  const cancelled = leg.status === "cancelled";
  const service = legService(leg);
  const Icon = TRANSPORT_ICON[kind];
  const arrival = leg.arrival;

  return (
    <div className="space-y-0.5 min-w-0" data-testid="structured-mail-leg" data-cancelled={cancelled || undefined}>
      {(service || (cancelled && !bookingCancelled)) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          {service && (
            <span className={cn("flex items-center gap-1.5 min-w-0 font-medium text-foreground", cancelled && "line-through text-muted-foreground")}>
              <Icon aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="break-words">{service}</span>
            </span>
          )}
          {cancelled && !bookingCancelled && (
            <span className={cn(PILL_CLASS, "bg-destructive/15 text-destructive")}>{t("status_cancelled")}</span>
          )}
        </div>
      )}
      <MetaRow icon={Clock}>
        <When at={leg.departure.at} struck={cancelled} />
        <span className={cn(cancelled && "line-through")}> · <bdi>{legPlaceLabel(leg.departure.place, kind)}</bdi></span>
      </MetaRow>
      {arrival && (
        <MetaRow icon={ArrowRight}>
          {arrival.at && <When at={arrival.at} timeOnly={sameLocalDate(arrival.at, leg.departure.at)} struck={cancelled} />}
          <span className={cn(cancelled && "line-through")}>{arrival.at ? " · " : ""}<bdi>{legPlaceLabel(arrival.place, kind)}</bdi></span>
        </MetaRow>
      )}
      {leg.seats.length > 0 && (
        <MetaRow icon={Ticket}>
          <span>{t("seats")}: </span>
          {leg.seats.map((seat, i) => (
            <Fragment key={`${seat.passenger ?? ""}-${seat.seat}-${i}`}>
              {i > 0 && ", "}
              {seat.passenger && <><bdi>{seat.passenger}</bdi> </>}
              <bdi dir="ltr" data-testid="structured-mail-seat">{seat.seat}</bdi>
            </Fragment>
          ))}
        </MetaRow>
      )}
    </div>
  );
}

/**
 * "FRA → JFK → FRA" as parts: every stop isolated in a <bdi>, and ArrowRight,
 * which globals.css mirrors under [dir=rtl], between them, so the arrows
 * point the reading direction whatever script the names are in.
 */
function RouteTitle({ runs }: { runs: string[][] }) {
  return (
    <>
      {runs.map((run, r) => (
        <Fragment key={r}>
          {r > 0 && ", "}
          {run.map((stop, i) => (
            <Fragment key={i}>
              {i > 0 && <ArrowRight aria-hidden="true" className="inline-block w-3.5 h-3.5 mx-1 align-[-0.125em]" />}
              <bdi data-testid="structured-mail-stop">{stop}</bdi>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </>
  );
}

export function TransportCard({ booking, emailId, calendarActions }: BookingCardProps<TransportBooking>) {
  const t = useTranslations("email_viewer.structured_mail");
  const kindLabel = booking.kind === "flight" ? t("kind_flight") : booking.kind === "train" ? t("kind_train") : t("kind_bus");
  const name = booking.kind === "flight" ? t("region_flight") : booking.kind === "train" ? t("region_train") : t("region_bus");
  const title = routeTitle(booking);
  const runs = routeRuns(booking);
  const cancelled = booking.status === "cancelled";
  return (
    <CardShell
      kind={booking.kind}
      name={name}
      icon={TRANSPORT_ICON[booking.kind]}
      cancelled={cancelled}
      eyebrow={eyebrowText(kindLabel, booking.provider, title)}
      title={<RouteTitle runs={runs} />}
      titleLabel={runs.map((run) => run.reduce((from, to) => t("route", { from, to }))).join(", ")}
      pills={booking.status && booking.status !== "confirmed" ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, emailId, [{ link: booking.links.checkin, label: t("link_check_in") }, { link: booking.links.manage, label: t("link_manage") }, { link: booking.links.ticket, label: t("link_ticket") }])}
    >
      <div className="flex flex-col gap-2 min-w-0">
        {booking.legs.map((leg, i) => (
          <Leg key={`${leg.departure.at.date}-${leg.number ?? ""}-${i}`} leg={leg} kind={booking.kind} bookingCancelled={cancelled} />
        ))}
      </div>
      <PassengersRow names={booking.passengers} />
    </CardShell>
  );
}

/** "Fri, Dec 4, from 15:00" / "Sun, Dec 6, until 11:00" / the date alone. */
function StayEnd({ label, at, edge }: { label: string; at: Moment; edge: "from" | "until" }) {
  const t = useTranslations("email_viewer.structured_mail");
  const { opts } = useCardFormat();
  const time = formatMomentTime(at, opts);
  return (
    <MetaRow icon={Clock}>
      <span>{label} </span>
      <span className="text-foreground/90">{formatMomentDate(at, opts)}</span>
      {time && (
        <>
          <span>, </span>
          <span className="text-foreground/90">{edge === "from" ? t("from_time", { time }) : t("until_time", { time })}</span>
          <LocalHint at={at} />
        </>
      )}
    </MetaRow>
  );
}

/** Only the "local time" mark of a moment (the time itself is already written). */
function LocalHint({ at }: { at: Moment }) {
  const t = useTranslations("email_viewer.structured_mail");
  const { readerZone } = useCardFormat();
  // When renders the mark next to its own text; here the text is the from/until phrase.
  return isOtherZone(at, readerZone) ? (
    <span className="ms-1 text-xs text-muted-foreground" title={t("local_time_title")} data-testid="local-time-hint">{t("local_time")}</span>
  ) : null;
}

export function LodgingCard({ booking, emailId, calendarActions }: BookingCardProps<LodgingBooking>) {
  const t = useTranslations("email_viewer.structured_mail");
  const { opts } = useCardFormat();
  const nights = nightsBetween(booking.checkin, booking.checkout);
  const address = formatAddress(booking.address, opts.locale);
  return (
    <CardShell
      kind="lodging"
      name={t("region_lodging")}
      icon={Bed}
      cancelled={booking.status === "cancelled"}
      eyebrow={eyebrowText(t("kind_lodging"), booking.provider, booking.name)}
      title={booking.name}
      pills={booking.status && booking.status !== "confirmed" ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, emailId, [{ link: booking.links.manage, label: t("link_manage") }, { link: booking.links.checkin, label: t("link_check_in") }])}
    >
      {address && <MetaRow icon={MapPin}>{address}</MetaRow>}
      <StayEnd label={t("check_in_label")} at={booking.checkin} edge="from" />
      <StayEnd label={t("check_out_label")} at={booking.checkout} edge="until" />
      {nights !== undefined && <MetaRow icon={Bed}>{t("nights", { count: nights })}</MetaRow>}
      {booking.phone && <MetaRow icon={Phone}><span dir="ltr">{booking.phone}</span></MetaRow>}
      <PassengersRow names={booking.passengers} />
    </CardShell>
  );
}

export function RentalCarCard({ booking, emailId, calendarActions }: BookingCardProps<RentalCarBooking>) {
  const t = useTranslations("email_viewer.structured_mail");
  const title = booking.company?.trim() || t("kind_rentalcar");
  const pickupPlace = formatPlace(booking.pickup.place);
  const dropoffPlace = formatPlace(booking.dropoff.place);
  return (
    <CardShell
      kind="rentalcar"
      name={t("region_rentalcar")}
      icon={Car}
      cancelled={booking.status === "cancelled"}
      eyebrow={eyebrowText(t("kind_rentalcar"), booking.provider, title)}
      title={title}
      pills={booking.status && booking.status !== "confirmed" ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, emailId, [{ link: booking.links.manage, label: t("link_manage") }])}
    >
      <MetaRow icon={Clock}>
        <span>{t("pickup")} </span>
        <When at={booking.pickup.at} />
        {pickupPlace && <span> · {pickupPlace}</span>}
      </MetaRow>
      <MetaRow icon={ArrowRight}>
        <span>{t("dropoff")} </span>
        <When at={booking.dropoff.at} />
        {dropoffPlace && <span> · {dropoffPlace}</span>}
      </MetaRow>
      {booking.car && <MetaRow icon={Car}>{booking.car}</MetaRow>}
      <PassengersRow names={booking.passengers} />
    </CardShell>
  );
}

export function EventCard({ booking, emailId, calendarActions }: BookingCardProps<EventBooking>) {
  const t = useTranslations("email_viewer.structured_mail");
  const { opts } = useCardFormat();
  const venueName = booking.venue?.name?.trim();
  const venueAddress = formatAddress(booking.venue?.address, opts.locale);
  // "Stadtpark, Parkweg 2, Hamburg"; the name alone, or the address alone, when that's all there is.
  const venue = venueName && venueAddress
    ? (venueAddress.includes(venueName) ? venueAddress : `${venueName}, ${venueAddress}`)
    : venueName || venueAddress || formatPlace(booking.venue);
  const end = booking.end;
  return (
    <CardShell
      kind="event"
      name={t("region_event")}
      icon={Ticket}
      cancelled={booking.status === "cancelled"}
      eyebrow={eyebrowText(t("kind_event"), booking.provider, booking.name)}
      title={booking.name}
      pills={booking.status && booking.status !== "confirmed" ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, emailId, [{ link: booking.links.ticket, label: t("link_ticket") }, { link: booking.links.manage, label: t("link_manage") }])}
    >
      <MetaRow icon={Clock}>
        <When at={booking.start} />
        {end && (end.time || !sameLocalDate(end, booking.start)) && (
          <>
            <span> – </span>
            <When at={end} timeOnly={sameLocalDate(end, booking.start) && !!booking.start.time} />
          </>
        )}
      </MetaRow>
      {venue && <MetaRow icon={MapPin}>{venue}</MetaRow>}
      {booking.tickets.length > 0 && (
        <MetaRow icon={Ticket}>
          <span>{t("tickets")}: </span>
          <bdi dir="ltr" className="font-mono break-all" data-testid="structured-mail-tickets">{booking.tickets.join(", ")}</bdi>
        </MetaRow>
      )}
      <PassengersRow names={booking.passengers} />
    </CardShell>
  );
}

export function RestaurantCard({ booking, emailId, calendarActions }: BookingCardProps<RestaurantBooking>) {
  const t = useTranslations("email_viewer.structured_mail");
  const { opts } = useCardFormat();
  const address = formatAddress(booking.address, opts.locale);
  return (
    <CardShell
      kind="restaurant"
      name={t("region_restaurant")}
      icon={Restaurant}
      cancelled={booking.status === "cancelled"}
      eyebrow={eyebrowText(t("kind_restaurant"), booking.provider, booking.name)}
      title={booking.name}
      pills={booking.status && booking.status !== "confirmed" ? <BookingStatusPill status={booking.status} /> : undefined}
      actions={bookingActions(booking, calendarActions, emailId, [{ link: booking.links.manage, label: t("link_manage") }])}
    >
      <MetaRow icon={Clock}><When at={booking.start} /></MetaRow>
      {address && <MetaRow icon={MapPin}>{address}</MetaRow>}
      {booking.partySize !== undefined && booking.partySize > 0 && (
        <MetaRow icon={Users}>{t("party_size", { count: booking.partySize })}</MetaRow>
      )}
    </CardShell>
  );
}
