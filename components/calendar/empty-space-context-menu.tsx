"use client";

import { useTranslations } from "next-intl";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { Plus, CalendarDays, CheckSquare, Clock } from "@/components/icons";

interface Position {
  x: number;
  y: number;
}

interface EmptySpaceContextMenuProps {
  position: Position;
  isOpen: boolean;
  onClose: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onNewEvent: () => void;
  onNewAllDayEvent: () => void;
  onNewTask?: () => void;
  onGoToToday: () => void;
  showAllDayOption?: boolean;
}

export function EmptySpaceContextMenu({
  position,
  isOpen,
  onClose,
  menuRef,
  onNewEvent,
  onNewAllDayEvent,
  onNewTask,
  onGoToToday,
  showAllDayOption = true,
}: EmptySpaceContextMenuProps) {
  const t = useTranslations("calendar");

  const handle = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
      <ContextMenuItem icon={Plus} label={t("events.new_event")} onClick={handle(onNewEvent)} />
      {showAllDayOption && (
        <ContextMenuItem
          icon={CalendarDays}
          label={t("events.new_all_day_event")}
          onClick={handle(onNewAllDayEvent)}
        />
      )}
      {onNewTask && (
        <ContextMenuItem
          icon={CheckSquare}
          label={t("events.new_task")}
          onClick={handle(onNewTask)}
        />
      )}
      <ContextMenuSeparator />
      <ContextMenuItem icon={Clock} label={t("events.go_to_today")} onClick={handle(onGoToToday)} />
    </ContextMenu>
  );
}
