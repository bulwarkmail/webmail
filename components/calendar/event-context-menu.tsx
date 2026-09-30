"use client";

import { useTranslations } from "next-intl";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Pencil,
  Copy,
  Download,
  ClipboardCopy,
  Link as LinkIcon,
  CalendarArrowUp as CalendarLinkIcon,
  Trash2,
} from "@/components/icons";
import type { CalendarEvent } from "@/lib/jmap/types";
import { buildCalendarPath } from "@/lib/deep-links";
import { useCopyLink } from "@/hooks/use-copy-link";

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
}: EventContextMenuProps) {
  const t = useTranslations("calendar");
  const tDeepLink = useTranslations("deep_link");
  const copyLink = useCopyLink();

  const handle = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const hasMeetingLink = !!(
    event.virtualLocations && Object.values(event.virtualLocations).some((v) => v.uri)
  );

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
      <ContextMenuItem icon={Pencil} label={t("events.edit")} onClick={handle(onEdit)} />
      <ContextMenuItem icon={Copy} label={t("events.duplicate")} onClick={handle(onDuplicate)} />
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Download}
        label={t("events.export_ics")}
        onClick={handle(onExportICS)}
      />
      <ContextMenuItem
        icon={ClipboardCopy}
        label={t("events.copy_title")}
        onClick={handle(onCopyTitle)}
      />
      {hasMeetingLink && onCopyMeetingLink && (
        <ContextMenuItem
          icon={LinkIcon}
          label={t("events.copy_link")}
          onClick={handle(onCopyMeetingLink)}
        />
      )}
      {/* Permalink into Bulwark (#733) - distinct from the meeting URL above,
          which points at whatever conferencing tool the organiser used. */}
      <ContextMenuItem
        icon={CalendarLinkIcon}
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
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Trash2}
        label={t("events.delete")}
        onClick={handle(onDelete)}
        destructive
      />
    </ContextMenu>
  );
}
