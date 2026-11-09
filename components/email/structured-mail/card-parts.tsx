"use client";

import type { ComponentType, ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ExternalLink } from "@/components/icons";
import { openExternalLink } from "@/lib/plugin-hook-result";
import { formatMoment, formatMomentTime, isOtherZone, isWebLink, type FormatOptions } from "@/lib/structured-mail/format";
import type { Link, Moment, ReservationStatus } from "@/lib/structured-mail/types";
import { resolveTimeZone } from "@/lib/timezone";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";

type IconType = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export const ACTION_CLASS =
  "inline-flex max-w-full min-w-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px]";
export const PILL_CLASS = "rounded-full px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap";
/** The copy chip in an action row, as tall as the buttons beside it. */
export const ACTION_CHIP_CLASS = "min-h-[36px] px-3 text-sm";

/** Locale, clock and the reader's zone, for formatting a card's times. */
export function useCardFormat(): { opts: FormatOptions; readerZone: string } {
  const locale = useLocale();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const timeZone = useSettingsStore((s) => s.timeZone);
  return {
    opts: { locale, hour12: timeFormat === "12h" ? true : timeFormat === "24h" ? false : undefined },
    readerZone: resolveTimeZone(timeZone),
  };
}

/**
 * A time as the mail gave it, at the place. `timeOnly` leaves out the date
 * (an arrival on the departure day). Marked "local time" when the place's
 * clock differs from the reader's at that instant.
 */
export function When({ at, timeOnly = false, struck = false }: { at: Moment; timeOnly?: boolean; struck?: boolean }) {
  const t = useTranslations("email_viewer.structured_mail");
  const { opts, readerZone } = useCardFormat();
  const text = timeOnly && at.time ? formatMomentTime(at, opts) : formatMoment(at, opts);
  const other = isOtherZone(at, readerZone);
  return (
    <>
      <span className={cn("text-foreground/90 whitespace-nowrap", struck && "line-through")}>{text}</span>
      {other && (
        <span className="ms-1 text-xs text-muted-foreground" title={t("local_time_title")} data-testid="local-time-hint">
          {t("local_time")}
        </span>
      )}
    </>
  );
}

/** One meta row: a small icon and text that wraps instead of overflowing. */
export function MetaRow({ icon: Icon, children, className }: { icon: IconType; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-1.5 min-w-0", className)}>
      <Icon aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0 mt-[0.1875rem]" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

const STATUS_TONE: Record<Exclude<ReservationStatus, "confirmed">, string> = {
  cancelled: "bg-destructive/15 text-destructive",
  pending: "bg-warning/15 text-warning",
  hold: "bg-warning/15 text-warning",
};

/** Cancelled, Pending or On hold; nothing for a confirmed booking. */
export function BookingStatusPill({ status }: { status?: ReservationStatus }) {
  const t = useTranslations("email_viewer.structured_mail");
  if (!status || status === "confirmed") return null;
  const label = status === "cancelled" ? t("status_cancelled") : status === "pending" ? t("status_pending") : t("status_hold");
  return <span className={cn(PILL_CLASS, STATUS_TONE[status])}>{label}</span>;
}

/**
 * A link from the mail with its host beside the label ("Track · dhl.de").
 * Opens like a link in the message body: plugins may stop or redirect it,
 * then a new tab without opener or referrer.
 */
export function CardLink({ link, label, icon: Icon = ExternalLink, emailId }: { link?: Link; label: string; icon?: IconType; emailId?: string }) {
  if (!link || !isWebLink(link)) return null;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(ACTION_CLASS, "flex-wrap gap-y-0")}
      data-testid="structured-mail-link"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void openExternalLink({ href: link.url, target: "_blank", emailId, text: label });
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        void openExternalLink({ href: link.url, target: "_blank", emailId, text: label });
      }}
    >
      <Icon aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="whitespace-nowrap">{label}</span>
      {/* The host is how a reader judges the link: wrapped, never cut off. */}
      <span className="max-w-full [overflow-wrap:anywhere] text-muted-foreground/80">· {link.host}</span>
    </a>
  );
}

interface CardShellProps {
  /** Accessible name of the region ("Flight booking"). */
  name: string;
  icon: IconType;
  /** Destructive tone and a struck-through title. */
  cancelled?: boolean;
  eyebrow: string;
  title: ReactNode;
  /** What screen readers hear instead of a title drawn from parts (a route with arrow icons). */
  titleLabel?: string;
  pills?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  kind: string;
}

/** The banner layout every card shares (CalendarInvitationBanner's look). */
export function CardShell({ name, icon: Icon, cancelled = false, eyebrow, title, titleLabel, pills, children, actions, kind }: CardShellProps) {
  return (
    <section aria-label={name} className="flex items-start gap-3 min-w-0" data-testid="structured-mail-card" data-kind={kind}>
      <div
        aria-hidden="true"
        className={cn(
          "w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm",
          cancelled ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
        )}
      >
        <Icon aria-hidden="true" className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <div className="min-w-0">
          <div className="text-[0.6875rem] font-semibold text-muted-foreground break-words">{eyebrow}</div>
          <h3 className={cn("text-sm font-semibold leading-snug break-words", cancelled ? "line-through text-muted-foreground" : "text-foreground")}>
            {titleLabel ? (
              <>
                <span className="sr-only">{titleLabel}</span>
                <span aria-hidden="true" data-testid="structured-mail-title-visual">{title}</span>
              </>
            ) : title}
          </h3>
        </div>
        {pills && <div className="flex flex-wrap items-center gap-1.5">{pills}</div>}
        {children && <div className="flex flex-col gap-1 text-sm text-muted-foreground">{children}</div>}
        {actions && <div className="flex flex-wrap items-center gap-1.5 pt-0.5" data-testid="structured-mail-actions">{actions}</div>}
      </div>
    </section>
  );
}

/** "Flight · Lufthansa"; the kind alone when the provider is missing or already the title. */
export function eyebrowText(kind: string, provider: string | undefined, title: string): string {
  const p = provider?.trim();
  return p && p.toLowerCase() !== title.trim().toLowerCase() ? `${kind} · ${p}` : kind;
}
