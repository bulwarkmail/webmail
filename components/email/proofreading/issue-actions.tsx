"use client";

// What one issue says and what can be done about it: the message, up to five
// suggestions, Ignore, Add to dictionary (spelling) and Turn off this rule.
// Used in the popup on an underline and, in the plain-text composer, in the
// issue list.

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { DismissAction, PlacedIssue } from "@/lib/proofreading/composer-proofreader";

export const KIND_DOT: Record<PlacedIssue["kind"], string> = {
  spelling: "bg-[var(--text-issue-spelling)]",
  grammar: "bg-[var(--text-issue-grammar)]",
  style: "bg-[var(--text-issue-style)]",
  other: "bg-[var(--text-issue-other)]",
};

const itemClass =
  "inline-flex min-h-8 items-center rounded-md px-2.5 text-sm outline-none transition-colors " +
  "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-10";

interface Props {
  issue: PlacedIssue;
  onApply: (issue: PlacedIssue, replacement: string) => void;
  onDismiss: (issue: PlacedIssue, action: DismissAction) => void;
  /** The issue list puts the word first; the popup has it in the text. */
  showWord?: boolean;
  /** Shown when a suggestion could not be put in (the text changed). */
  error?: string | null;
  /** id for the message, which the popup is described by. */
  messageId?: string;
}

export function IssueHeading({ issue }: { issue: PlacedIssue }) {
  const t = useTranslations("proofreading");
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", KIND_DOT[issue.kind])} aria-hidden="true" />
      <span>{t(`kind.${issue.kind}`)}</span>
      <span aria-hidden="true">·</span>
      <span className="truncate">{issue.checkerLabel}</span>
    </span>
  );
}

function Suggestions({ issue, onApply }: Pick<Props, "issue" | "onApply">) {
  const t = useTranslations("proofreading");
  if (!issue.annotation.replacements.length) {
    return <p className="text-sm text-muted-foreground">{t("popup.no_suggestions")}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={t("popup.suggestions")}>
      {issue.annotation.replacements.map((r) => (
        <button
          key={r}
          type="button"
          data-popup-item=""
          data-testid="proofreading-replacement"
          aria-label={t("popup.replace_with", { text: r })}
          className={cn(itemClass, "border border-border bg-background font-medium")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onApply(issue, r)}
        >
          <bdi dir="auto">{r}</bdi>
        </button>
      ))}
    </div>
  );
}

export function IssueActions({ issue, onApply, onDismiss, showWord = false, error, messageId }: Props) {
  const t = useTranslations("proofreading");
  const a = issue.annotation;
  return (
    <div className="flex flex-col gap-2">
      <IssueHeading issue={issue} />
      <p id={messageId} className="text-sm text-foreground" dir="auto">
        {showWord && <><bdi className="font-semibold">{a.text}</bdi>{": "}</>}
        {a.message}
      </p>
      <Suggestions issue={issue} onApply={onApply} />
      {issue.alternatives.map((alt) => (
        <div key={alt.key} className="flex flex-col gap-1.5 border-t border-border pt-2">
          <span className="text-xs text-muted-foreground">{t("popup.also", { checker: alt.checkerLabel })}</span>
          <p className="text-sm" dir="auto">{alt.annotation.message}</p>
          <Suggestions issue={alt} onApply={onApply} />
        </div>
      ))}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-1 border-t border-border pt-2">
        <button type="button" data-popup-item="" className={itemClass} onMouseDown={(e) => e.preventDefault()} onClick={() => onDismiss(issue, "ignore")}>
          {t("popup.ignore")}
        </button>
        {issue.kind === "spelling" && (
          <button type="button" data-popup-item="" className={itemClass} onMouseDown={(e) => e.preventDefault()} onClick={() => onDismiss(issue, "dictionary")}>
            {t("popup.add_to_dictionary")}
          </button>
        )}
        {a.ruleId && (
          <button
            type="button"
            data-popup-item=""
            className={itemClass}
            title={a.ruleLabel}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onDismiss(issue, "disable-rule")}
          >
            {t("popup.disable_rule")}
          </button>
        )}
      </div>
    </div>
  );
}

/** What a screen reader reads for an issue in the list: the word first, as it shows. */
export function issueListLabel(t: ReturnType<typeof useTranslations>, issue: PlacedIssue): string {
  const a = issue.annotation;
  const text = a.replacements.length
    ? t("list_item", { word: a.text, message: a.message, suggestion: a.replacements[0] })
    : t("list_item_no_suggestion", { word: a.text, message: a.message });
  return `${text} (${t(`kind.${issue.kind}`)})`;
}
