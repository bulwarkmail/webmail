"use client";

// Step 46: the assistant proposes a task (create_task) or a change to one
// (update_task); nothing happens until the user confirms it here.
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Bell, Check, CheckSquare, Flag, Mail } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { ProposalSummary } from "@/lib/xenaxio/assistant";
import { useXT } from "@/lib/xenaxio/i18n";

export type TaskProposalState = "pending" | "running" | "done" | "rejected" | "expired" | "already" | "failed" | string;

export interface TaskProposal {
  id: string;
  tool: string;
  summary: ProposalSummary;
  state: TaskProposalState;
}

/** "Fr., 30.10.2026" or "Fr., 30.10.2026, 09:00" from the local date the platform sends. */
export function formatDue(due: string | null | undefined, locale: string): string {
  if (!due) return "";
  const asUtc = new Date(due.length === 10 ? `${due}T00:00:00Z` : `${due}:00Z`);
  if (Number.isNaN(asUtc.getTime())) return due;
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(asUtc);
  if (due.length === 10) return day;
  return `${day}, ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(asUtc)}`;
}

/** Which heading the card gets: a new task, marking one done, or another change. */
export function taskCardKind(tool: string, summary: ProposalSummary): "create" | "done" | "update" {
  if (tool === "create_task") return "create";
  return summary.changes?.length === 1 && summary.changes[0] === "done" ? "done" : "update";
}

export function TaskCard({ proposal, locale, onDecide }: { proposal: TaskProposal; locale: string; onDecide: (p: TaskProposal, confirm: boolean) => void }) {
  const t = useXT();
  const s = proposal.summary;
  const kind = taskCardKind(proposal.tool, s);
  const label = (key: string) => t(`assistant.task.${key}`);
  const changed = (what: string) => kind !== "create" && !!s.changes?.includes(what);
  const was = (text?: string | null) => (text ? <span className="block text-muted-foreground line-through">{text}</span> : null);
  const priority = (p?: string) => (p && p !== "none" ? label(`priority_${p}`) : label("priority_none"));
  const status = (st?: string) => (st === "done" ? label("status_done") : label("status_open"));
  const settled = proposal.state !== "pending" && proposal.state !== "running";
  const done = proposal.state === "done";
  const showPriority = (s.priority && s.priority !== "none") || changed("priority");
  const stateText = done ? label(`done_${kind}`) : proposal.state === "failed" ? label("failed") : t(`assistant.proposal.${proposal.state}`);
  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-sm">
        <CheckSquare className="h-4 w-4 text-primary" />
        {label(`title_${kind}`)}
      </p>
      <p className={cn("font-medium text-sm break-words", kind === "done" && "line-through")}>
        {s.title}
        {changed("title") && was(s.before?.title)}
      </p>
      <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-1">
        <dt className="text-muted-foreground">{label("due")}</dt>
        <dd>
          {s.due ? formatDue(s.due, locale) : <span className="text-muted-foreground">{label("no_due")}</span>}
          {changed("due") && was(s.before?.due ? formatDue(s.before.due, locale) : label("no_due"))}
        </dd>
        {showPriority ? (
          <>
            <dt className="text-muted-foreground">{label("priority")}</dt>
            <dd className="flex flex-wrap items-center gap-1">
              {s.priority === "high" && <Flag className="h-3.5 w-3.5 text-red-500" />}
              {priority(s.priority)}
              {changed("priority") && was(priority(s.before?.priority))}
            </dd>
          </>
        ) : null}
        {s.reminder || changed("reminder") ? (
          <>
            <dt className="text-muted-foreground">{label("reminder")}</dt>
            <dd className="flex items-center gap-1">
              {s.reminder && <Bell className="h-3.5 w-3.5" />}
              {s.reminder ? label("reminder_at_due") : label("reminder_none")}
            </dd>
          </>
        ) : null}
        {changed("done") || changed("reopened") ? (
          <>
            <dt className="text-muted-foreground">{label("status")}</dt>
            <dd>
              {status(s.status)}
              {was(status(s.before?.status))}
            </dd>
          </>
        ) : null}
        {s.email ? (
          <>
            <dt className="text-muted-foreground">{label("from_email")}</dt>
            <dd className="flex min-w-0 items-start gap-1 break-words">
              <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {s.email.subject || "—"}
                {s.email.from ? <span className="block text-muted-foreground">{s.email.from}</span> : null}
              </span>
            </dd>
          </>
        ) : null}
        {s.description && (kind === "create" || changed("description")) ? (
          <>
            <dt className="text-muted-foreground">{label("description")}</dt>
            <dd className="line-clamp-4 whitespace-pre-line break-words">{s.description}</dd>
          </>
        ) : null}
      </dl>
      {proposal.state === "pending" && kind === "create" && <p className="text-muted-foreground">{label("note")}</p>}
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
      {done && (
        <Link href="/calendar/tasks" className="inline-block text-muted-foreground underline hover:text-foreground">
          {label("open_list")}
        </Link>
      )}
    </div>
  );
}
