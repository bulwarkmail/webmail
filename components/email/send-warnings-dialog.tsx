"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/** Something the composer asks about before a message goes out. */
export type SendWarning =
  | { kind: "subject" }
  | { kind: "text" }
  | { kind: "placeholders"; matches: string[] }
  | { kind: "attachment"; keyword: string }
  | { kind: "proofreading"; count: number };

interface SendWarningsDialogProps {
  /** What to ask about, in the order the composer checks it. Closed when null. */
  warnings: SendWarning[] | null;
  /** "Back to editing", Escape or a click outside. */
  onBack: () => void;
  /** "Send anyway". `dontAskAgain`: the box under a single warning that has a setting. */
  onSendAnyway: (dontAskAgain: boolean) => void;
  /** Asked before Schedule send: the button says "Schedule anyway". */
  scheduling?: boolean;
}

/** The warnings that can be switched off in Settings (subject and placeholders). */
const HAS_SETTING = new Set<SendWarning["kind"]>(["subject", "placeholders"]);

/**
 * One question before sending, whatever it found: a single warning keeps its
 * own title and text, several are listed in one dialog with one "Send anyway"
 * (two dialogs in a row asked about each in turn).
 */
export function SendWarningsDialog({ warnings, onBack, onSendAnyway, scheduling = false }: SendWarningsDialogProps) {
  const t = useTranslations("email_composer");
  const tSend = useTranslations("compose_send");
  const tProofreading = useTranslations("proofreading");
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [shownFor, setShownFor] = useState<SendWarning[] | null>(null);
  // A new question starts with the box unticked.
  if (warnings !== shownFor) {
    setShownFor(warnings);
    setDontAskAgain(false);
  }

  const items = warnings ?? [];
  const single = items.length === 1 ? items[0] : null;

  const placeholderChips = (matches: string[]) => (
    <ul className="mt-3 flex flex-wrap items-center gap-1.5" aria-label={t("placeholder_warning.found")}>
      {matches.slice(0, 5).map((p) => (
        <li key={p} className="max-w-full truncate rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground">{p}</li>
      ))}
      {matches.length > 5 && (
        <li className="text-xs text-muted-foreground">
          {t("placeholder_warning.more", { count: matches.length - 5 })}
        </li>
      )}
    </ul>
  );

  let title: string;
  let description: string | undefined;
  let backLabel = tSend("back");
  let sendLabel = tSend("send_anyway");
  let body: React.ReactNode = null;

  if (single?.kind === "subject") {
    title = t("empty_subject.title");
    description = t("empty_subject.message");
    backLabel = t("empty_subject.back");
    sendLabel = t("empty_subject.send_anyway");
  } else if (single?.kind === "text") {
    title = tSend("empty_text_title");
    description = tSend("empty_text_message");
  } else if (single?.kind === "placeholders") {
    title = t("placeholder_warning.title");
    description = t("placeholder_warning.message");
    backLabel = t("placeholder_warning.back");
    sendLabel = t("placeholder_warning.send_anyway");
    body = placeholderChips(single.matches);
  } else if (single?.kind === "attachment") {
    title = t("forgot_attachment.title");
    description = t("forgot_attachment.message", { keyword: single.keyword });
    backLabel = t("forgot_attachment.back");
    sendLabel = t("forgot_attachment.send_anyway");
  } else if (single?.kind === "proofreading") {
    title = tProofreading("send_warning.title");
    description = tProofreading("send_warning.body", { count: single.count });
    backLabel = tProofreading("send_warning.review");
    sendLabel = tProofreading("send_warning.send");
  } else {
    title = tSend(scheduling ? "schedule_warnings_title" : "warnings_title");
    body = (
      <ul className="mt-3 space-y-2 text-sm text-foreground" data-testid="send-warnings-list">
        {items.map((w) => (
          <li key={w.kind} className="flex gap-2">
            <span aria-hidden="true" className="text-muted-foreground">•</span>
            <div className="min-w-0">
              {w.kind === "subject" && tSend("warning_subject")}
              {w.kind === "text" && tSend("warning_text")}
              {w.kind === "attachment" && tSend("warning_attachment", { keyword: w.keyword })}
              {w.kind === "proofreading" && tSend("warning_proofreading", { count: w.count })}
              {w.kind === "placeholders" && (
                <>
                  {tSend("warning_placeholders")}
                  {placeholderChips(w.matches)}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  // Nothing goes out now: the message is scheduled (compose-p2-14).
  if (scheduling) sendLabel = tSend("schedule_anyway");

  return (
    <Dialog
      isOpen={items.length > 0}
      onClose={onBack}
      role="alertdialog"
      showClose={false}
      title={title}
      description={description}
      testId="send-warnings"
      footer={
        <>
          <Button variant="outline" onClick={onBack}>{backLabel}</Button>
          <Button data-testid={single?.kind === "proofreading" ? "proofreading-send-anyway" : "send-warnings-send"} onClick={() => onSendAnyway(dontAskAgain)}>{sendLabel}</Button>
        </>
      }
    >
      {body}
      {single && HAS_SETTING.has(single.kind) && (
        <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            className="rounded border-input"
          />
          {single.kind === "subject" ? t("empty_subject.dont_ask_again") : t("placeholder_warning.dont_ask_again")}
        </label>
      )}
    </Dialog>
  );
}
