"use client";

import { useTranslations } from "next-intl";
import { Clock, ExternalLink, Package, ShoppingBag, Truck } from "@/components/icons";
import { formatMomentDate, formatMoney, isWebLink, shipmentItems, summarizeItems } from "@/lib/structured-mail/format";
import type { Item, OrderStatus, Parcel, Shipment } from "@/lib/structured-mail/types";
import { cn } from "@/lib/utils";
import { CardLink, CardShell, MetaRow, PILL_CLASS, useCardFormat } from "./card-parts";
import { CopyValueChip } from "./copy-value-chip";

const STATUS_TONE: Record<OrderStatus, string> = {
  payment_due: "bg-warning/15 text-warning",
  processing: "bg-muted text-muted-foreground",
  problem: "bg-destructive/15 text-destructive",
  in_transit: "bg-info/15 text-info",
  pickup_available: "bg-success/15 text-success",
  returned: "bg-muted text-muted-foreground",
  delivered: "bg-success/15 text-success",
  cancelled: "bg-destructive/15 text-destructive",
};

/** States in which an expected arrival date is out of date. */
const ARRIVED_OR_STOPPED = new Set<OrderStatus>(["delivered", "returned", "cancelled"]);

function OrderStatusPill({ status }: { status: OrderStatus }) {
  const t = useTranslations("email_viewer.structured_mail");
  const labels: Record<OrderStatus, string> = {
    payment_due: t("order_status_payment_due"),
    processing: t("order_status_processing"),
    problem: t("order_status_problem"),
    in_transit: t("order_status_in_transit"),
    pickup_available: t("order_status_pickup_available"),
    returned: t("order_status_returned"),
    delivered: t("order_status_delivered"),
    cancelled: t("order_status_cancelled"),
  };
  return <span className={cn(PILL_CLASS, STATUS_TONE[status])}>{labels[status]}</span>;
}

/** Product images, only when remote content may load for this message; https only, no referrer. */
function ItemImages({ items }: { items: Item[] }) {
  const shown = items.filter((item) => item.image && isWebLink(item.image) && item.image.url.toLowerCase().startsWith("https:"));
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pt-0.5">
      {shown.map((item, i) => (
        <img
          key={`${item.image!.url}-${i}`}
          src={item.image!.url}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-10 w-10 rounded-md border border-border bg-background object-cover"
        />
      ))}
    </div>
  );
}

/** Carrier, tracking number and expected date; no date once the order is delivered, returned or cancelled. */
function ParcelRows({ parcel, showExpected }: { parcel: Parcel; showExpected: boolean }) {
  const t = useTranslations("email_viewer.structured_mail");
  const { opts } = useCardFormat();
  const expectedBy = showExpected ? parcel.expectedBy : undefined;
  if (!parcel.carrier && !parcel.trackingNumber && !expectedBy) return null;
  return (
    <>
      {(parcel.carrier || parcel.trackingNumber) && (
        <MetaRow icon={Truck}>
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0">
            {parcel.carrier && <span className="text-foreground/90">{parcel.carrier}</span>}
            {!parcel.carrier && parcel.trackingNumber && <span>{t("tracking_number")}</span>}
            {parcel.trackingNumber && <CopyValueChip
                value={parcel.trackingNumber}
                copyLabel={t("copy_tracking_number", { value: parcel.trackingNumber })}
                copiedMessage={t("copied_tracking_number")}
              />}
          </span>
        </MetaRow>
      )}
      {expectedBy && (
        <MetaRow icon={Clock}>{t("expected_by", { date: formatMomentDate(expectedBy, opts) })}</MetaRow>
      )}
    </>
  );
}

interface ShipmentCardProps {
  shipment: Shipment;
  emailId?: string;
  allowRemoteImages: boolean;
}

export function ShipmentCard({ shipment, emailId, allowRemoteImages }: ShipmentCardProps) {
  const t = useTranslations("email_viewer.structured_mail");
  const { opts } = useCardFormat();
  const carrier = shipment.parcels.find((p) => p.carrier)?.carrier;
  const isParcel = !shipment.orderNumber && !shipment.merchant && shipment.parcels.length > 0;
  const kindLabel = isParcel ? t("kind_parcel") : t("kind_order");
  const title = shipment.merchant?.trim() || carrier || kindLabel;
  const eyebrow = shipment.merchant && carrier ? `${kindLabel} · ${carrier}` : kindLabel;
  const items = shipmentItems(shipment);
  const { shown, more, count } = summarizeItems(items);
  const total = shipment.total ? formatMoney(shipment.total, opts.locale) : undefined;
  // One Track button per distinct tracking page.
  const trackLinks = shipment.parcels.map((p) => p.trackingUrl)
    .filter((l, i, all): l is NonNullable<typeof l> => isWebLink(l) && all.findIndex((o) => o?.url === l!.url) === i);
  const hasOrderLink = isWebLink(shipment.orderUrl);
  const cancelled = shipment.status === "cancelled";

  return (
    <CardShell
      kind="shipment"
      name={t("region_shipment")}
      icon={isParcel ? Truck : ShoppingBag}
      cancelled={cancelled}
      eyebrow={eyebrow}
      title={title}
      pills={shipment.status ? <OrderStatusPill status={shipment.status} /> : undefined}
      actions={trackLinks.length > 0 || hasOrderLink ? (
        <>
          {trackLinks.map((link, i) => (
            <CardLink key={`${link.url}-${i}`} link={link} label={t("link_track")} icon={Truck} emailId={emailId} />
          ))}
          <CardLink link={shipment.orderUrl} label={t("link_view_order")} icon={ExternalLink} emailId={emailId} />
        </>
      ) : undefined}
    >
      {shipment.orderNumber && (
        <MetaRow icon={ShoppingBag}>
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0">
            <span>{t("order_number")}</span>
            <CopyValueChip
              value={shipment.orderNumber}
              copyLabel={t("copy_order_number", { value: shipment.orderNumber })}
              copiedMessage={t("copied_order_number")}
            />
          </span>
        </MetaRow>
      )}
      {shown.length > 0 && (
        <MetaRow icon={Package}>
          <span className="text-foreground/90">{shown.map((item) => item.name).join(", ")}</span>
          {more > 0 && <span> {t("items_more", { count: more })}</span>}
          {allowRemoteImages && <ItemImages items={shown} />}
        </MetaRow>
      )}
      {(items.length > 0 || total) && (
        <div className="ps-5 text-sm text-muted-foreground">
          {[items.length > 0 ? t("items_count", { count }) : undefined, total ? t("total", { total }) : undefined]
            .filter(Boolean).join(" · ")}
        </div>
      )}
      {shipment.parcels.map((parcel, i) => <ParcelRows key={`${parcel.trackingNumber ?? ""}-${i}`} parcel={parcel} showExpected={!ARRIVED_OR_STOPPED.has(shipment.status ?? "processing")} />)}
    </CardShell>
  );
}
