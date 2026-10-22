"use client";

// Step 15: what happened to each recipient of a sent message — delivered,
// still being delivered, delayed (with the next attempt) or not delivered and
// why. The platform learns it from the mail server; this only shows it.
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { CheckCircle, ChevronDown, ChevronRight, Clock, HelpCircle, Send, XCircle } from "@/components/icons";
import { type RecipientDelivery, xenaxio } from "@/lib/xenaxio/api";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";
import { cn } from "@/lib/utils";

/** Ask again while something is still on its way; stop after half an hour. */
const POLL_MS = 30_000;
const POLL_FOR_MS = 30 * 60_000;

const pending = (r: RecipientDelivery) => r.state === "queued" || r.state === "deferred";

export function DeliveryStatus({ emailId }: { emailId: string }) {
  const t = useXT();
  const locale = useLocale();
  const [recipients, setRecipients] = useState<RecipientDelivery[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!XENAXIO_BFF) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    setRecipients(null);
    const load = async () => {
      try {
        const { recipients: list } = await xenaxio.delivery(emailId);
        if (cancelled) return;
        setRecipients(list);
        // A problem is shown right away, without a click.
        if (list.some((r) => r.state === "failed" || r.state === "deferred")) setOpen(true);
        if (list.some(pending) && Date.now() - started < POLL_FOR_MS) timer = setTimeout(load, POLL_MS);
      } catch {
        if (!cancelled) setRecipients([]);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [emailId]);

  if (!recipients || recipients.length === 0) return null;

  const time = (iso?: string) =>
    iso ? new Date(iso).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  const count = (state: RecipientDelivery["state"]) => recipients.filter((r) => r.state === state).length;
  const failed = count("failed");
  const delayed = count("deferred");
  const onTheWay = count("queued");
  const delivered = count("delivered");

  const summary =
    failed > 0
      ? t("delivery.summary_failed", { failed, total: recipients.length })
      : delayed > 0
        ? t("delivery.summary_delayed", { delayed, total: recipients.length })
        : onTheWay > 0
          ? t("delivery.summary_on_the_way")
          : delivered === recipients.length
            ? t("delivery.summary_delivered")
            : t("delivery.summary_partly", { delivered, total: recipients.length });
  const tone = failed > 0 ? "text-destructive" : delayed > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
  const SummaryIcon = failed > 0 ? XCircle : delayed > 0 ? Clock : onTheWay > 0 ? Send : CheckCircle;

  return (
    <div className="py-1" data-testid="delivery-status">
      <button
        type="button"
        className={cn("flex items-center gap-1.5 text-sm hover:underline", tone)}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <SummaryIcon className="w-4 h-4 shrink-0" />
        <span>{summary}</span>
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1.5 ps-5">
          {recipients.map((r) => (
            <li key={r.address} className="text-sm">
              <div className="flex flex-wrap items-center gap-x-2">
                <StateIcon state={r.state} />
                <span className="font-medium break-all">{r.address}</span>
                <span className="text-muted-foreground">
                  {r.state === "deferred" && r.nextRetry
                    ? t("delivery.state.deferred_next", { time: time(r.nextRetry) })
                    : t(`delivery.state.${r.state}`)}
                  {r.state === "delivered" && r.at ? ` · ${time(r.at)}` : ""}
                </span>
              </div>
              {(r.state === "failed" || r.state === "deferred") && (
                <div className="ps-6 text-muted-foreground">
                  {r.reason && <p>{t(`delivery.reason.${r.state === "deferred" && r.reason === "other" ? "temporary" : r.reason}`)}</p>}
                  {r.reply && <p className="text-xs font-mono break-words opacity-80">{r.reply}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StateIcon({ state }: { state: RecipientDelivery["state"] }) {
  const cls = "w-4 h-4 shrink-0";
  switch (state) {
    case "delivered":
      return <CheckCircle className={cn(cls, "text-green-600 dark:text-green-400")} aria-hidden />;
    case "failed":
      return <XCircle className={cn(cls, "text-destructive")} aria-hidden />;
    case "deferred":
      return <Clock className={cn(cls, "text-amber-600 dark:text-amber-400")} aria-hidden />;
    case "queued":
      return <Send className={cn(cls, "text-muted-foreground")} aria-hidden />;
    default:
      return <HelpCircle className={cn(cls, "text-muted-foreground")} aria-hidden />;
  }
}
