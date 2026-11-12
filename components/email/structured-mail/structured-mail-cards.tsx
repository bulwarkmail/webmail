"use client";

import { useMemo, type ReactNode } from "react";
import type { Email } from "@/lib/jmap/types";
import type { Booking, StructuredCard } from "@/lib/structured-mail/types";
import { EventCard, LodgingCard, RentalCarCard, RestaurantCard, TransportCard } from "./booking-cards";
import { cardForDisplay, cardSenderDomain, useTopLevelDomainsLoaded } from "./card-parts";
import { ShipmentCard } from "./shipment-card";

export interface StructuredMailCardsProps {
  /** Resolved cards from useStructuredMail; nothing renders for an empty list. */
  cards: StructuredCard[];
  /**
   * The message the cards come from: its id goes to the external-link hook,
   * its From domain (verified, or there would be no cards) names the sender
   * on every card and decides which links lead outside.
   */
  email: Pick<Email, "id"> & Partial<Pick<Email, "from">>;
  /** Whether remote content may load for this message: product images show only then. */
  allowRemoteImages: boolean;
  /** Rendered in each booking card's action row ("Add to calendar"); nothing when undefined. */
  calendarActions?: (booking: Booking) => ReactNode;
}

/**
 * The booking, parcel and order cards shown above an open message. Every text
 * of a card is shown as cardForDisplay leaves it: nothing that names a domain
 * outside the sender's. A card cardForDisplay does not draw is left out, and
 * with no card left the message shows as it would without them.
 */
export function StructuredMailCards({ cards, email, allowRemoteImages, calendarActions }: StructuredMailCardsProps) {
  const senderDomain = cardSenderDomain(email.from);
  // Until the top-level domains have loaded, every dotted name counts as a domain; the cards are checked again once they have.
  const listLoaded = useTopLevelDomainsLoaded();
  const shown = useMemo(
    () => cards.flatMap((card) => cardForDisplay(card, senderDomain) ?? []),
    [cards, senderDomain, listLoaded], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 min-w-0" data-testid="structured-mail-cards" data-plugin-list-avoid="">
      {shown.map((card, i) => {
        const props = { emailId: email.id, calendarActions, senderDomain };
        switch (card.kind) {
          case "flight":
          case "train":
          case "bus":
            return <TransportCard key={`${card.key}-${i}`} booking={card} {...props} />;
          case "lodging":
            return <LodgingCard key={`${card.key}-${i}`} booking={card} {...props} />;
          case "rentalcar":
            return <RentalCarCard key={`${card.key}-${i}`} booking={card} {...props} />;
          case "event":
            return <EventCard key={`${card.key}-${i}`} booking={card} {...props} />;
          case "restaurant":
            return <RestaurantCard key={`${card.key}-${i}`} booking={card} {...props} />;
          case "shipment":
            return <ShipmentCard key={`${card.key}-${i}`} shipment={card} emailId={email.id} allowRemoteImages={allowRemoteImages} senderDomain={senderDomain} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
