"use client";

import { useTranslations } from "next-intl";
import { Button, type ButtonSize } from "@/components/ui/button";
import { Check } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { CalendarParticipant } from "@/lib/jmap/types";

type Status = CalendarParticipant["participationStatus"];

/**
 * Text in a participation status colour. The status fills (#22c55e,
 * #eab308) are too light for text on a light ground, so text uses the
 * darker shades (APP.md status colours).
 */
export const STATUS_TEXT: Record<string, string> = {
  accepted: "text-green-700 dark:text-green-400",
  declined: "text-red-600 dark:text-red-400",
  tentative: "text-amber-600 dark:text-amber-400",
  "needs-action": "text-muted-foreground",
};

/** Translation keys of the participation statuses. */
export const STATUS_LABEL: Record<string, string> = {
  accepted: "participants.accepted",
  declined: "participants.declined",
  tentative: "participants.tentative",
  "needs-action": "participants.needs_action",
};

/**
 * The statuses in plain words for the participant lists (pim-19): the
 * standard's "Needs action" reads "Not answered yet". Keys of ux_pim_event.
 */
export const PARTICIPANT_STATUS_WORDS: Record<string, string> = {
  accepted: "status_accepted",
  declined: "status_declined",
  tentative: "status_tentative",
  "needs-action": "status_needs_action",
  delegated: "status_delegated",
};

/** A participant's answer, as a short coloured word. */
export function ParticipantStatusBadge({ status, className }: { status: Status; className?: string }) {
  const t = useTranslations("ux_pim_event");
  return (
    <span className={cn("text-xs flex-shrink-0", STATUS_TEXT[status] ?? "", className)}>
      {t(PARTICIPANT_STATUS_WORDS[status] ?? PARTICIPANT_STATUS_WORDS["needs-action"])}
    </span>
  );
}

// The chosen answer is filled; dark text keeps it readable on the light
// green and yellow fills.
const CHOSEN: Record<string, string> = {
  accepted: "bg-success hover:bg-success/90 text-neutral-950 border-transparent",
  tentative: "bg-warning hover:bg-warning/90 text-neutral-950 border-transparent",
  declined: "bg-destructive hover:bg-destructive/90 text-destructive-foreground border-transparent",
};

const ANSWERS: { status: Status; label: string }[] = [
  { status: "accepted", label: "participants.accept" },
  { status: "tentative", label: "participants.maybe" },
  { status: "declined", label: "participants.decline" },
];

/** The three answers to an invitation, the current one filled. */
export function RsvpButtons({
  status,
  onRespond,
  size = "sm",
}: {
  status: Status | null;
  onRespond: (status: Status) => void;
  size?: ButtonSize;
}) {
  const t = useTranslations("calendar");
  return (
    <div className="flex flex-wrap gap-2">
      {ANSWERS.map((answer) => {
        const chosen = status === answer.status;
        return (
          <Button
            key={answer.status}
            size={size}
            variant="outline"
            aria-pressed={chosen}
            onClick={() => onRespond(answer.status)}
            className={chosen ? CHOSEN[answer.status] : STATUS_TEXT[answer.status]}
          >
            {chosen && <Check className="w-4 h-4 me-1" />}
            {t(answer.label)}
          </Button>
        );
      })}
    </div>
  );
}
