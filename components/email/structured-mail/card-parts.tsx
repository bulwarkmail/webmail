"use client";

import type { ComponentType, ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ExternalLink } from "@/components/icons";
import { toAsciiDomain } from "@/lib/idn";
import { openExternalLink } from "@/lib/plugin-hook-result";
import { getRootDomain } from "@/lib/root-domain";
import { formatMoment, formatMomentTime, isOtherZone, isWebLink, type FormatOptions } from "@/lib/structured-mail/format";
import type { Link, Moment, ReservationStatus, StructuredCard } from "@/lib/structured-mail/types";
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

/** A host name in ASCII form, lower case, without a trailing dot. */
function asciiHost(host: string): string {
  return (toAsciiDomain(host) ?? host).toLowerCase().replace(/\.$/, "");
}

/**
 * The domain of a card's sender, in ASCII form: the From domain the receiving
 * server verified (a card shows only for such a message, see
 * lib/structured-mail/trust.ts). Empty without a From address.
 */
export function cardSenderDomain(from: { email?: string | null }[] | null | undefined): string {
  const address = from?.[0]?.email ?? "";
  const at = address.lastIndexOf("@");
  return at >= 0 ? asciiHost(address.slice(at + 1).trim()) : "";
}

/**
 * Whether `host` lies outside the sender's domain: neither the From domain
 * nor below it, and not under the same registrable domain either
 * (lib/root-domain.ts; a list of common suffixes, so that is the wider match
 * only). Without a sender domain every host is outside.
 */
export function isOutsideSender(host: string, senderDomain: string): boolean {
  if (!senderDomain) return true;
  const target = asciiHost(host);
  if (!target) return true;
  if (target === senderDomain || target.endsWith(`.${senderDomain}`)) return false;
  return getRootDomain(target) !== getRootDomain(senderDomain);
}

const chars = (...codes: number[]) => String.fromCodePoint(...codes);
const span = (from: number, to: number) => `${chars(from)}-${chars(to)}`;

/**
 * Characters a reader does not see: every format character (category Cf:
 * zero width space and joiners, soft hyphen, word joiner, byte order mark,
 * direction marks), the combining grapheme joiner, variation selectors and
 * the Hangul fillers.
 */
const INVISIBLE = new RegExp(
  `[\\p{Cf}${chars(0x34f, 0x115f, 0x1160, 0x3164, 0xffa0)}${span(0x180b, 0x180f)}${span(0xfe00, 0xfe0f)}${span(0xe0100, 0xe01ef)}]`,
  "gu",
);

/**
 * Full stops that read as the dot of a domain name and survive NFKC: the
 * ideographic one and other scripts' (the fullwidth and small full stop and
 * the one dot leader become a plain dot under NFKC already).
 */
const DOT_LIKE = new RegExp(`[${chars(0x3002, 0x06d4, 0x0701, 0x0702, 0x1362, 0x2e3c, 0xa4ff, 0xa60e, 0xa6f3)}]`, "gu");

/** Anything that cannot be part of a host name ends a word. */
const NOT_IN_HOST = /[^\p{L}\p{N}\p{M}.-]+/u;
const STARTS_WITH_LETTER = /^\p{L}/u;

/** The text as it reads on screen, in one spelling: NFKC, no invisible characters, plain dots, lower case. */
function comparableText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(DOT_LIKE, ".").toLowerCase();
}

/**
 * Whether a text from the mail names a domain outside the sender's. Every
 * word of the text in its comparable spelling that has a dot between two
 * labels and ends in a label of two or more characters starting with a
 * letter is read as a host name ("bigbank.example", "bigbank.example-secure",
 * "www.bigbank.example" in an address). One pass over the text.
 */
export function namesOtherDomain(text: string, senderDomain: string): boolean {
  for (const word of comparableText(text).split(NOT_IN_HOST)) {
    const labels = word.replace(/^[.-]+|[.-]+$/g, "").split(".").filter(Boolean);
    if (labels.length < 2) continue;
    const last = labels[labels.length - 1];
    if (last.length < 2 || !STARTS_WITH_LETTER.test(last)) continue;
    if (isOutsideSender(labels.join("."), senderDomain)) return true;
  }
  return false;
}

/**
 * Text from the markup as the card may show it: undefined when it names a
 * domain outside the sender's (namesOtherDomain), so a sender cannot present
 * a card as coming from another domain.
 */
export function brandText(text: string | undefined, senderDomain: string): string | undefined {
  const value = text?.trim();
  if (!value || namesOtherDomain(value, senderDomain)) return undefined;
  return value;
}

/** Strings in a card that are values of the app's own, never the sender's text as written. */
const MACHINE_KEYS = new Set(["key", "kind", "source", "status", "modified", "date", "time", "utc", "zone", "country", "currency", "amount"]);

function isCardLink(value: object): value is Link {
  const link = value as Partial<Link>;
  return typeof link.url === "string" && typeof link.host === "string";
}

function textForDisplay(value: unknown, senderDomain: string, key?: string): unknown {
  if (typeof value === "string") {
    return key !== undefined && MACHINE_KEYS.has(key) ? value : namesOtherDomain(value, senderDomain) ? "" : value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item !== "string" || !namesOtherDomain(item, senderDomain))
      .map((item) => textForDisplay(item, senderDomain));
  }
  if (value && typeof value === "object") {
    // A link's host is where the button leads, shown as such and marked when it is outside.
    if (isCardLink(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, textForDisplay(v, senderDomain, k)]));
  }
  return value;
}

/**
 * The card as it is shown: every text the sender wrote into it (names,
 * places, passengers, items, numbers) goes through namesOtherDomain, and a
 * text that names a domain outside the sender's is left out (an empty
 * string, or dropped from a list). Links stay as they are.
 */
export function cardForDisplay<T extends StructuredCard>(card: T, senderDomain: string): T {
  return textForDisplay(card, senderDomain) as T;
}

/**
 * A link from the mail with its host beside the label ("Track · dhl.de").
 * A host outside the sender's domain carries a mark. Opens like a link in the
 * message body: plugins may stop or redirect it, then a new tab without
 * opener or referrer.
 */
export function CardLink({ link, label, icon: Icon = ExternalLink, emailId, senderDomain }: { link?: Link; label: string; icon?: IconType; emailId?: string; senderDomain: string }) {
  const tTrust = useTranslations("sender_trust");
  if (!link || !isWebLink(link)) return null;
  const outside = isOutsideSender(link.host, senderDomain);
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={outside ? tTrust("outside_link_title", { host: link.host, domain: senderDomain }) : undefined}
      className={cn(ACTION_CLASS, "flex-wrap gap-y-0")}
      data-testid="structured-mail-link"
      data-outside={outside || undefined}
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
      {outside && (
        <span className={cn(PILL_CLASS, "bg-warning/15 text-warning")} data-testid="structured-mail-outside-link">
          {tTrust("outside_link")}
        </span>
      )}
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
  /** The verified sender domain (cardSenderDomain), named next to the brand the markup claims. */
  senderDomain: string;
}

/** The banner layout every card shares (CalendarInvitationBanner's look). */
export function CardShell({ name, icon: Icon, cancelled = false, eyebrow, title, titleLabel, pills, children, actions, kind, senderDomain }: CardShellProps) {
  const tTrust = useTranslations("sender_trust");
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
          <div className="text-[0.6875rem] font-semibold text-muted-foreground break-words">
            {eyebrow}
            {senderDomain && (
              <>
                {" · "}
                <span
                  className="font-normal [overflow-wrap:anywhere]"
                  title={tTrust("card_sender_title", { domain: senderDomain })}
                  data-testid="structured-mail-sender-domain"
                >
                  {tTrust("card_sender", { domain: senderDomain })}
                </span>
              </>
            )}
          </div>
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

/**
 * "Flight · Lufthansa"; the kind alone when the provider is missing, already
 * the title, or names a domain outside the sender's (brandText).
 */
export function eyebrowText(kind: string, provider: string | undefined, title: string, senderDomain: string): string {
  const p = brandText(provider, senderDomain);
  return p && p.toLowerCase() !== title.trim().toLowerCase() ? `${kind} · ${p}` : kind;
}
