"use client";

import { useTranslations } from "next-intl";
import { addDays, format, nextMonday, parseISO } from "date-fns";
import {
  ContextMenu,
  ContextMenuCheckItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubMenu,
} from "@/components/ui/context-menu";
import { Briefcase, Calendar as CalendarIcon, CalendarDays, CalendarEvent, CalendarX, Check, Eye, FolderInput, RotateCcw, Sun, Trash2 } from "@/components/icons";
import { displayNow } from "@/lib/timezone";
import type { Calendar, CalendarTask } from "@/lib/jmap/types";
import { useCollectionNames } from "@/hooks/use-collection-names";

/** What the menu's Due date items set: a day, or no date. */
export type TaskDueChoice = "today" | "tomorrow" | "next-week" | "none";

/**
 * The task's new `due` and `showWithoutTime` for a choice, from today in the display time
 * zone. A task with a time keeps its time on the new day.
 */
export function dueFor(task: Pick<CalendarTask, "due" | "showWithoutTime">, choice: TaskDueChoice, now: Date = displayNow()): Pick<CalendarTask, "due" | "showWithoutTime"> {
  if (choice === "none") return { due: null, showWithoutTime: task.showWithoutTime };
  const day = choice === "today" ? now : choice === "tomorrow" ? addDays(now, 1) : nextMonday(now);
  const date = format(day, "yyyy-MM-dd");
  if (task.due && !task.showWithoutTime) return { due: `${date}T${format(parseISO(task.due), "HH:mm")}:00`, showWithoutTime: false };
  return { due: date, showWithoutTime: true };
}

interface TaskContextMenuProps {
  task: CalendarTask;
  position: { x: number; y: number };
  isOpen: boolean;
  onClose: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onOpen: () => void;
  onToggleComplete: () => void;
  onSetDue?: (choice: TaskDueChoice) => void;
  /** The lists the task can go to; the one it's in is marked. */
  lists?: Calendar[];
  onMoveTo?: (calendarId: string) => void;
  onDelete?: () => void;
}

/**
 * A task's right-click menu (pim-p3-10), as events, contacts and files have: open it,
 * tick it off, give it a day, move it to another list, delete it (Del).
 */
export function TaskContextMenu({ task, position, isOpen, onClose, menuRef, onOpen, onToggleComplete, onSetDue, lists, onMoveTo, onDelete }: TaskContextMenuProps) {
  const t = useTranslations("calendar");
  const tPc = useTranslations("ux_p3_pim_pc");
  const shownName = useCollectionNames();
  const done = task.progress === "completed";
  const handle = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const moveTargets = lists ?? [];

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose} label={task.title || t("tasks.no_title")}>
      <ContextMenuItem icon={Eye} label={tPc("task_open")} onClick={handle(onOpen)} shortcut="Enter" />
      <ContextMenuItem icon={done ? RotateCcw : Check} label={done ? t("tasks.mark_incomplete") : t("tasks.mark_complete")} onClick={handle(onToggleComplete)} testId="task-menu-toggle" />
      {onSetDue && (
        <ContextMenuSubMenu icon={CalendarDays} label={t("tasks.due_date")} testId="task-menu-due">
          <ContextMenuItem icon={CalendarEvent} label={t("tasks.due_today")} onClick={handle(() => onSetDue("today"))} />
          <ContextMenuItem icon={Sun} label={t("tasks.due_tomorrow")} onClick={handle(() => onSetDue("tomorrow"))} />
          <ContextMenuItem icon={Briefcase} label={tPc("due_next_week")} onClick={handle(() => onSetDue("next-week"))} />
          {task.due && <ContextMenuItem icon={CalendarX} label={tPc("due_none")} onClick={handle(() => onSetDue("none"))} />}
          <ContextMenuSeparator />
          <ContextMenuItem icon={CalendarIcon} label={tPc("due_pick")} onClick={handle(onOpen)} />
        </ContextMenuSubMenu>
      )}
      {onMoveTo && moveTargets.length > 1 && (
        <ContextMenuSubMenu icon={FolderInput} label={tPc("move_to_list")} testId="task-menu-move">
          {moveTargets.map((list) => (
            <ContextMenuCheckItem
              key={list.id}
              kind="radio"
              label={shownName.calendar(list)}
              checked={!!task.calendarIds?.[list.id]}
              onClick={handle(() => { if (!task.calendarIds?.[list.id]) onMoveTo(list.id); })}
            />
          ))}
        </ContextMenuSubMenu>
      )}
      {onDelete && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem icon={Trash2} label={t("tasks.delete")} shortcut="Del" onClick={handle(onDelete)} destructive testId="task-menu-delete" />
        </>
      )}
    </ContextMenu>
  );
}
