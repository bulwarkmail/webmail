"use client";

// Step 45: what an assistant proposal says about a series - how it repeats,
// whether one occurrence or the whole series changes, and that changed
// occurrences go back to the series when the series moves.
import { useXT } from "@/lib/xenaxio/i18n";
import type { ProposalSummary } from "@/lib/xenaxio/assistant";

/** "02.11.2026, 10:00" for a wall-clock time as the platform sends it. */
function formatLocal(local: string, locale: string): string {
  const date = new Date(`${local.slice(0, 16)}:00Z`);
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date);
}

/** Rows for the proposal's <dl>; nothing for a meeting that does not repeat. */
export function ProposalSeriesRows({ summary, locale }: { summary: ProposalSummary; locale: string }) {
  const t = useXT();
  const s = summary;
  const repeatChanged = !!s.changes?.includes("repeat");
  return (
    <>
      {s.scope ? (
        <>
          <dt className="text-muted-foreground">{t("assistant.proposal.scope")}</dt>
          <dd>{s.scope === "occurrence" && s.occurrence ? t("assistant.proposal.scope_occurrence", { when: formatLocal(s.occurrence, locale) }) : t("assistant.proposal.scope_series")}</dd>
        </>
      ) : null}
      {s.repeatText ? (
        <>
          <dt className="text-muted-foreground">{t("assistant.proposal.repeats")}</dt>
          <dd>
            {s.repeatText}
            {repeatChanged && s.repeatBefore ? <span className="block text-muted-foreground line-through">{s.repeatBefore}</span> : null}
          </dd>
        </>
      ) : null}
    </>
  );
}

/** Shown under the rows while the proposal waits. */
export function ProposalSeriesNote({ summary }: { summary: ProposalSummary }) {
  const t = useXT();
  if (!summary.resetsChangedOccurrences) return null;
  return <p className="text-muted-foreground">{t("assistant.proposal.reset_note", { count: summary.resetsChangedOccurrences })}</p>;
}
