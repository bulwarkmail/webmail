"use client";

import type { ReactNode } from "react";
import type { Email } from "@/lib/jmap/types";
import type { Booking, StructuredCard } from "@/lib/structured-mail/types";
import { EventCard, LodgingCard, RentalCarCard, RestaurantCard, TransportCard } from "./booking-cards";
import { ShipmentCard } from "./shipment-card";

export interface StructuredMailCardsProps {
  /** Resolved cards from useStructuredMail; nothing renders for an empty list. */
  cards: StructuredCard[];
  /** The message the cards come from (its id goes to the external-link hook). */
  email: Pick<Email, "id">;
  /** Whether remote content may load for this message: product images show only then. */
  allowRemoteImages: boolean;
  /** Rendered in each booking card's action row ("Add to calendar"); nothing when undefined. */
  calendarActions?: (booking: Booking) => ReactNode;
}

/** The booking, parcel and order cards shown above an open message. */
export function StructuredMailCards({ cards, email, allowRemoteImages, calendarActions }: StructuredMailCardsProps) {
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 min-w-0" data-testid="structured-mail-cards">
      {cards.map((card, i) => {
        const props = { emailId: email.id, calendarActions };
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
            return <ShipmentCard key={`${card.key}-${i}`} shipment={card} emailId={email.id} allowRemoteImages={allowRemoteImages} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
