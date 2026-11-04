"use client";

import { useTranslations } from "next-intl";
import {
  ContextMenu,
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
  /** Only the answers: the menu of the "?" / "Reply" marker. */
  answersOnly?: boolean;
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
  answersOnly = false,
}: EventContextMenuProps) {
  const t = useTranslations("calendar");
  const tDeepLink = useTranslations("deep_link");
  const tCommon = useTranslations("common");
  const copyLink = useCopyLink();

  const handle = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const hasMeetingLink = !!findMeetingLink(event);

  const answers = onRespond ? (
    <>
      {responseStatus !== "accepted" && (
        <ContextMenuItem icon={Check} label={t("participants.accept")} onClick={handle(() => onRespond("accepted"))} testId="grid-answer-accepted" />
      )}
      {responseStatus !== "tentative" && (
        <ContextMenuItem icon={HelpCircle} label={t("participants.maybe")} onClick={handle(() => onRespond("tentative"))} testId="grid-answer-tentative" />
      )}
      {responseStatus !== "declined" && (
        <ContextMenuItem icon={X} label={t("participants.decline")} onClick={handle(() => onRespond("declined"))} testId="grid-answer-declined" />
      )}
    </>
  ) : null;

  if (answersOnly && answers) {
    return (
      <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
        {answers}
      </ContextMenu>
    );
  }

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
      {answers && (
        <>
          {answers}
          <ContextMenuSeparator />
        </>
      )}
      {editable && <ContextMenuItem icon={Pencil} label={t("events.edit")} onClick={handle(onEdit)} />}
      <ContextMenuItem icon={CopyPlus} label={t("events.duplicate")} onClick={handle(onDuplicate)} />
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
      {onPrint && <ContextMenuItem icon={Printer} label={tCommon("print")} onClick={handle(onPrint)} />}
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
