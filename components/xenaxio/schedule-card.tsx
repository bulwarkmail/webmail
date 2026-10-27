"use client";

// Step 47: the assistant proposes a scheduled task (schedule_task), a change
// to one (update_schedule) or deleting one (delete_schedule); nothing happens
// until the user confirms it here.
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { CalendarClock, Check, Mail, Send } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { ProposalSummary } from "@/lib/xenaxio/assistant";
import { useXT } from "@/lib/xenaxio/i18n";

export interface ScheduleProposal {
  id: string;
  tool: string;
  summary: ProposalSummary;
  state: string;
}

/** "Do., 29.10.2026, 08:00" from the local time the platform sends. */
export function formatRun(local: string, locale: string): string {
  const asUtc = new Date(`${local.slice(0, 16)}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return local;
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(asUtc);
  return `${day}, ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(asUtc)}`;
}

/** Which heading the card gets. */
export function scheduleCardKind(tool: string, summary: ProposalSummary): "create" | "update" | "pause" | "resume" | "delete" {
  if (tool === "schedule_task") return "create";
  if (tool === "delete_schedule") return "delete";
  const only = summary.changes?.length === 1 && summary.changes[0] === "status";
  if (only && summary.status === "paused") return "pause";
  if (only && summary.status === "active") return "resume";
  return "update";
}

export function ScheduleCard({ proposal, locale, onDecide }: { proposal: ScheduleProposal; locale: string; onDecide: (p: ScheduleProposal, confirm: boolean) => void }) {
  const t = useXT();
  const s = proposal.summary;
  const kind = scheduleCardKind(proposal.tool, s);
  const label = (key: string, values?: Record<string, string | number>) => t(`assistant.schedule.${key}`, values);
  const changed = (what: string) => kind === "update" && !!s.changes?.includes(what);
  const was = (text?: string | null) => (text ? <span className="block text-muted-foreground line-through">{text}</span> : null);
  const settled = proposal.state !== "pending" && proposal.state !== "running";
  const done = proposal.state === "done";
  const stateText = done ? label(`done_${kind}`) : proposal.state === "failed" ? label("failed") : proposal.state === "schedule_limit" ? label("limit") : t(`assistant.proposal.${proposal.state}`);
  const yesNo = (on?: boolean) => (on ? label("yes") : label("no"));
  const sendTo = s.sendTo ?? [];
  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-sm">
        <CalendarClock className="h-4 w-4 text-primary" />
        {label(`title_${kind}`)}
      </p>
      <p className={cn("font-medium text-sm break-words", kind === "delete" && "line-through")}>
        {s.title}
        {changed("title") && was(s.before?.title)}
      </p>
      {s.instruction && (kind === "create" || kind === "delete" || changed("instruction")) && (
        <p className="border-l-2 border-primary/40 pl-2 text-sm whitespace-pre-line break-words">{s.instruction}</p>
      )}
      <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-1">
        <dt className="text-muted-foreground">{label("when")}</dt>
        <dd className="break-words">
          {s.when}
          {s.timeZone ? <span className="text-muted-foreground"> ({s.timeZone})</span> : null}
          {changed("rule") && was(s.before?.when)}
        </dd>
        {s.nextRuns && s.nextRuns.length > 0 && kind !== "delete" && kind !== "pause" ? (
          <>
            <dt className="text-muted-foreground">{label("next")}</dt>
            <dd>{s.nextRuns.map((r) => formatRun(r, locale)).join(" · ")}</dd>
          </>
        ) : null}
        {kind !== "delete" && kind !== "pause" && kind !== "resume" ? (
          <>
            <dt className="text-muted-foreground">{label("email_copy")}</dt>
            <dd className="flex items-center gap-1">
              {s.emailCopy && <Mail className="h-3.5 w-3.5" />}
              {yesNo(s.emailCopy)}
              {changed("emailCopy") && was(yesNo(s.before?.emailCopy))}
            </dd>
            <dt className="text-muted-foreground">{label("may_send")}</dt>
            <dd className="break-words">
              {s.maySend ? (
                <span className="flex items-start gap-1">
                  <Send className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {label("may_send_to", { to: sendTo.join(", ") })}
                </span>
              ) : (
                label("drafts_only")
              )}
              {(changed("maySend") || changed("sendTo")) && was(s.before?.maySend ? label("may_send_to", { to: (s.before.sendTo ?? []).join(", ") }) : label("drafts_only"))}
            </dd>
          </>
        ) : null}
      </dl>
      {proposal.state === "pending" && kind === "create" && <p className="text-muted-foreground">{label("note")}</p>}
      {proposal.state === "pending" && s.maySend && kind !== "delete" && <p className="text-amber-700 dark:text-amber-400">{label("send_warning")}</p>}
      {settled ? (
        <p className={cn(done ? "text-primary" : "text-muted-foreground", "flex items-center gap-1")}>
          {done && <Check className="h-3.5 w-3.5" />}
          {stateText}
        </p>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" disabled={proposal.state === "running"} onClick={() => onDecide(proposal, true)}>
            {proposal.state === "running" ? label("running") : t("assistant.proposal.confirm")}
          </Button>
          <Button size="sm" variant="outline" disabled={proposal.state === "running"} onClick={() => onDecide(proposal, false)}>
            {t("assistant.proposal.reject")}
          </Button>
        </div>
      )}
      <Link href="/workspace/assistant" className="inline-block text-muted-foreground underline hover:text-foreground">
        {label("all")}
      </Link>
    </div>
  );
}
