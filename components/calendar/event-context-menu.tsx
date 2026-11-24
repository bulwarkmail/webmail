"use client";

import { useTranslations } from "next-intl";
import {
  ContextMenu,
  ContextMenuHeader,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Pencil,
  CopyPlus,
  Copy,
  Download,
  Video,
  Link as LinkIcon,
  Trash2,
  Printer,
  Check,
  HelpCircle,
  X,
  CalendarPlus,
  Forward,
} from "@/components/icons";
import type { CalendarEvent, CalendarParticipant } from "@/lib/jmap/types";
import { buildCalendarPath } from "@/lib/deep-links";
import { useCopyLink } from "@/hooks/use-copy-link";
import { findMeetingLink } from "@/lib/event-links";

interface Position {
  x: number;
  y: number;
}

interface EventContextMenuProps {
  event: CalendarEvent;
  position: Position;
  isOpen: boolean;
  onClose: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onEdit: () => void;
  onDuplicate: () => void;
  onExportICS: () => void;
  onCopyTitle: () => void;
  onCopyMeetingLink?: () => void;
  onDelete: () => void;
  /** Prints the event on a sheet of its own. */
  onPrint?: () => void;
  /** False for an event the user can't change (a birthday, a subscription, a read-only share): no Edit or Delete. */
  editable?: boolean;
  /**
   * Answer the invitation from the grid (pim-9): Accept, Maybe and Decline
   * at the top. Only for an event the user is invited to.
   */
  onRespond?: (status: CalendarParticipant["participationStatus"]) => void;
  /** The answer given so far; its item is left out. */
  responseStatus?: CalendarParticipant["participationStatus"] | null;
  /**
   * Answer for the owner of a shared calendar (#1760), above the user's
   * own answer, each under a heading.
   */
  ownerAnswer?: {
    name: string;
    status: CalendarParticipant["participationStatus"] | null;
    onRespond: (status: CalendarParticipant["participationStatus"]) => void;
  };
  /** Only the answers: the menu of the "?" / "Reply" marker. */
  answersOnly?: boolean;
  /** "Copy to <address>", one per other signed-in account (pim-p2-16). */
  copyTo?: Array<{ address: string; onCopy: () => void }>;
  /** "Copy to calendar…" for an event the user can't change, such as a subscription's (#1513). */
  onCopyToCalendar?: () => void;
  /** Opened over a dialog or popover: drawn at z-[70] rather than z-50. */
  overDialog?: boolean;
  /** Forward the meeting's invitation in the composer (#1797). Only for a meeting. */
  onForward?: () => void;
}

export function EventContextMenu({
  event,
  position,
  isOpen,
  onClose,
  menuRef,
  onEdit,
  onDuplicate,
  onExportICS,
  onCopyTitle,
  onCopyMeetingLink,
  onDelete,
  onPrint,
  editable = true,
  onRespond,
  responseStatus,
  ownerAnswer,
  answersOnly = false,
  copyTo = [],
  onCopyToCalendar,
  overDialog = false,
  onForward,
}: EventContextMenuProps) {
  const tP2 = useTranslations("ux_p2_pim_cal");
  const t = useTranslations("calendar");
  const tDeepLink = useTranslations("deep_link");
  const tP3 = useTranslations("ux_p3_pim_cal");
  const tDelegate = useTranslations("calendar_delegate");
  const tForward = useTranslations("calendar_forward");
  const copyLink = useCopyLink();

  const handle = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const hasMeetingLink = !!findMeetingLink(event);

  const answerItems = (
    status: CalendarParticipant["participationStatus"] | null | undefined,
    respond: (status: CalendarParticipant["participationStatus"]) => void,
    testId: string,
  ) => (
    <>
      {status !== "accepted" && (
        <ContextMenuItem icon={Check} label={t("participants.accept")} onClick={handle(() => respond("accepted"))} testId={`${testId}-accepted`} />
      )}
      {status !== "tentative" && (
        <ContextMenuItem icon={HelpCircle} label={t("participants.maybe")} onClick={handle(() => respond("tentative"))} testId={`${testId}-tentative`} />
      )}
      {status !== "declined" && (
        <ContextMenuItem icon={X} label={t("participants.decline")} onClick={handle(() => respond("declined"))} testId={`${testId}-declined`} />
      )}
    </>
  );
  const ownAnswers = onRespond ? answerItems(responseStatus, onRespond, "grid-answer") : null;
  const answers = ownerAnswer ? (
    <>
      <ContextMenuHeader>{tDelegate("answer_for", { name: ownerAnswer.name })}</ContextMenuHeader>
      {answerItems(ownerAnswer.status, ownerAnswer.onRespond, "grid-answer-owner")}
      {ownAnswers && (
        <>
          <ContextMenuHeader>{t("participants.rsvp_label")}</ContextMenuHeader>
          {ownAnswers}
        </>
      )}
    </>
  ) : ownAnswers;

  if (answersOnly && answers) {
    return (
      <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose} overDialog={overDialog}>
        {answers}
      </ContextMenu>
    );
  }

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose} overDialog={overDialog}>
      {answers && (
        <>
          {answers}
          <ContextMenuSeparator />
        </>
      )}
      {editable && <ContextMenuItem icon={Pencil} label={t("events.edit")} onClick={handle(onEdit)} />}
      <ContextMenuItem icon={CopyPlus} label={t("events.duplicate")} onClick={handle(onDuplicate)} />
      {onForward && (
        <ContextMenuItem icon={Forward} label={tForward("menu")} onClick={handle(onForward)} testId="event-forward" />
      )}
      {copyTo.map((target) => (
        <ContextMenuItem
          key={target.address}
          icon={CalendarPlus}
          label={tP2("copy_to_account", { address: target.address })}
          onClick={handle(target.onCopy)}
          testId="event-copy-to-account"
        />
      ))}
      {onCopyToCalendar && (
        <ContextMenuItem
          icon={CalendarPlus}
          label={tP2("copy_to_calendar")}
          onClick={handle(onCopyToCalendar)}
          testId="event-copy-to-calendar"
        />
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Download}
        label={t("events.export_ics")}
        onClick={handle(onExportICS)}
      />
      <ContextMenuItem
        icon={Copy}
        label={t("events.copy_title")}
        onClick={handle(onCopyTitle)}
      />
      {hasMeetingLink && onCopyMeetingLink && (
        <ContextMenuItem
          icon={Video}
          label={t("events.copy_link")}
          onClick={handle(onCopyMeetingLink)}
        />
      )}
      {/* Permalink into Bulwark (#733) - distinct from the meeting URL above,
          which points at whatever conferencing tool the organiser used. */}
      <ContextMenuItem
        icon={LinkIcon}
        label={tDeepLink("copy_event")}
        onClick={handle(() => {
          void copyLink(buildCalendarPath({
            view: "month",
            date: null,
            eventId: event.id,
            accountId: event.accountId,
          }));
        })}
      />
      {/* It opens the print dialog: "Print…", as in the File menu (pim-p3-17). */}
      {onPrint && <ContextMenuItem icon={Printer} label={tP3("print")} onClick={handle(onPrint)} />}
      {editable && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={Trash2}
            label={t("events.delete")}
            onClick={handle(onDelete)}
            destructive
          />
        </>
      )}
    </ContextMenu>
  );
}
