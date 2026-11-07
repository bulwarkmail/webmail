"use client";

// xenaxio step 118, part C: the board — a view, not a thing of its own. The
// same component lays out the tasks of a project in its columns and the
// projects themselves by status (later: port calls, mandates). Cards move with
// the mouse, a finger (after a short hold) and the keyboard (@dnd-kit, as in
// steps 104 and 106); the parent saves the move and may refuse it.
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";

export interface BoardLane {
  id: string;
  title: string;
  /** Shown faded: the done column, a closed status. */
  done?: boolean;
  /** Extra controls in the header (menu, count). */
  header?: ReactNode;
  /** Below the cards (a field to add one). */
  footer?: ReactNode;
}

export interface BoardItem {
  id: string;
  laneId: string;
}

type Layout = Record<string, string[]>;

function layoutOf(lanes: BoardLane[], items: BoardItem[]): Layout {
  const out: Layout = Object.fromEntries(lanes.map((l) => [l.id, [] as string[]]));
  for (const item of items) (out[item.laneId] ??= []).push(item.id);
  return out;
}

function laneOf(layout: Layout, id: string): string | null {
  if (id in layout) return id;
  for (const [lane, ids] of Object.entries(layout)) if (ids.includes(id)) return lane;
  return null;
}

function SortableCard({ id, disabled, children }: { id: string; disabled: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("touch-manipulation", isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

function Lane({ lane, ids, disabled, render, emptyText }: { lane: BoardLane; ids: string[]; disabled: boolean; render: (id: string) => ReactNode; emptyText: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: lane.id, disabled });
  return (
    <section
      aria-label={lane.title}
      data-board-lane={lane.id}
      className={cn("flex w-[85vw] max-w-[300px] shrink-0 snap-start flex-col rounded-lg bg-muted/60 sm:w-72", lane.done && "bg-muted/40")}
    >
      <header className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <h3 className={cn("min-w-0 flex-1 truncate text-sm font-semibold", lane.done && "text-muted-foreground")}>{lane.title}</h3>
        <span className="text-xs tabular-nums text-muted-foreground">{ids.length}</span>
        {lane.header}
      </header>
      <div ref={setNodeRef} className={cn("flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 pt-1", isOver && "rounded-md bg-primary/5")}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {ids.map((id) => (
            <SortableCard key={id} id={id} disabled={disabled}>
              {render(id)}
            </SortableCard>
          ))}
        </SortableContext>
        {ids.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">{emptyText}</p>}
      </div>
      {lane.footer && <div className="px-2 pb-2">{lane.footer}</div>}
    </section>
  );
}

export function Board({
  lanes,
  items,
  render,
  onMove,
  disabled = false,
  emptyText,
  after,
  label,
}: {
  lanes: BoardLane[];
  items: BoardItem[];
  render: (id: string) => ReactNode;
  /** A card was dropped: its lane and place among the other cards of that lane. */
  onMove: (id: string, laneId: string, index: number) => void;
  disabled?: boolean;
  emptyText: string;
  /** After the last lane (e.g. "add column"). */
  after?: ReactNode;
  label: string;
}) {
  const [layout, setLayout] = useState<Layout>(() => layoutOf(lanes, items));
  const [active, setActive] = useState<string | null>(null);
  const source = useMemo(() => layoutOf(lanes, items), [lanes, items]);
  // The parent's data wins whenever it changes (a saved move, a refused one, a colleague's change).
  useEffect(() => setLayout(source), [source]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (e: DragStartEvent) => setActive(String(e.active.id));

  // Between lanes the card moves while dragging, so the others make room.
  const onDragOver = (e: DragOverEvent) => {
    const over = e.over ? String(e.over.id) : null;
    const id = String(e.active.id);
    if (!over) return;
    setLayout((cur) => {
      const from = laneOf(cur, id);
      const to = laneOf(cur, over);
      if (!from || !to || from === to) return cur;
      const target = cur[to]!.filter((x) => x !== id);
      const at = over === to ? target.length : Math.max(0, target.indexOf(over));
      target.splice(at, 0, id);
      return { ...cur, [from]: cur[from]!.filter((x) => x !== id), [to]: target };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null);
    const id = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    const to = over ? laneOf(layout, over) : null;
    if (!over || !to) {
      setLayout(source);
      return;
    }
    // A move between lanes already happened while dragging; here the card only takes its place in the lane.
    let ids = layout[to]!;
    const from = ids.indexOf(id);
    if (from !== -1 && over !== to && over !== id) ids = arrayMove(ids, from, ids.indexOf(over));
    const index = ids.indexOf(id);
    if (index === -1) return;
    setLayout((cur) => ({ ...cur, [to]: ids }));
    if (laneOf(source, id) === to && source[to]!.indexOf(id) === index) return;
    onMove(id, to, index);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => (setActive(null), setLayout(source))}>
      <div role="list" aria-label={label} className="flex min-h-0 flex-1 snap-x gap-3 overflow-x-auto overscroll-x-contain p-3 sm:p-4">
        {lanes.map((lane) => (
          <Lane key={lane.id} lane={lane} ids={layout[lane.id] ?? []} disabled={disabled} render={render} emptyText={emptyText} />
        ))}
        {after}
      </div>
      <DragOverlay>{active ? <div className="rotate-1 cursor-grabbing shadow-lg">{render(active)}</div> : null}</DragOverlay>
    </DndContext>
  );
}
