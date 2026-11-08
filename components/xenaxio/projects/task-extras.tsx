"use client";

// xenaxio step 124: parts of a task's panel — the checklist (A: tick, reorder by
// dragging or the keyboard, make an item a task), the history (F) and the comment
// field with @mentions (C: only people of the project; the platform gets their ids).
import { type FormEvent, type KeyboardEvent, useMemo, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useXT } from "@/lib/xenaxio/i18n";
import type { ChecklistItem, PersonRef, TaskEvent } from "@/lib/xenaxio/projects";

type Draft = { id?: string; text: string; done?: boolean };

function Item({ item, canEdit, onToggle, onRemove, onToTask }: { item: ChecklistItem; canEdit: boolean; onToggle: () => void; onRemove: () => void; onToTask: () => void }) {
  const t = useXT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !canEdit });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("group flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/60", isDragging && "opacity-50")}>
      {canEdit && (
        <button type="button" className="cursor-grab touch-none text-muted-foreground opacity-60 hover:opacity-100" aria-label={t("projects.checklist_drag")} {...attributes} {...listeners}>
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      <input type="checkbox" className="h-4 w-4" checked={item.done} disabled={!canEdit} onChange={onToggle} aria-label={item.text} />
      <span className={cn("min-w-0 flex-1 break-words text-sm", item.done && "text-muted-foreground line-through")}>{item.text}</span>
      {canEdit && (
        <span className="flex shrink-0 gap-1 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <button type="button" className="rounded px-1 text-xs text-primary hover:underline" onClick={onToTask}>
            {t("projects.checklist_to_task")}
          </button>
          <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label={t("projects.checklist_remove")}>
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
    </li>
  );
}

export function Checklist({ items, canEdit, onSave, onToTask }: { items: ChecklistItem[]; canEdit: boolean; onSave: (next: Draft[]) => void; onToTask: (itemId: string) => void }) {
  const t = useXT();
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const done = items.filter((i) => i.done).length;

  const onDragEnd = (e: DragEndEvent) => {
    const from = items.findIndex((i) => i.id === e.active.id);
    const to = e.over ? items.findIndex((i) => i.id === e.over!.id) : -1;
    if (from < 0 || to < 0 || from === to) return;
    onSave(arrayMove(items, from, to));
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const clean = text.trim().slice(0, 200);
    if (!clean || items.length >= 50) return;
    onSave([...items, { text: clean, done: false }]);
    setText("");
  };

  if (!canEdit && items.length === 0) return null;
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("projects.checklist")}</span>
        {items.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{t("projects.checklist_count", { done, total: items.length })}</span>}
      </div>
      {items.length > 0 && (
        <div className="h-1 overflow-hidden rounded bg-muted" aria-hidden="true">
          <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((done / items.length) * 100)}%` }} />
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-0.5">
            {items.map((i) => (
              <Item
                key={i.id}
                item={i}
                canEdit={canEdit}
                onToggle={() => onSave(items.map((x) => (x.id === i.id ? { ...x, done: !x.done } : x)))}
                onRemove={() => onSave(items.filter((x) => x.id !== i.id))}
                onToTask={() => onToTask(i.id)}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {canEdit &&
        items.length < 50 &&
        (adding ? (
          <form onSubmit={add} className="flex gap-2">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("projects.checklist_item")} aria-label={t("projects.checklist_item")} maxLength={200} autoFocus onKeyDown={(e) => e.key === "Escape" && setAdding(false)} />
            <Button type="submit" size="sm" disabled={!text.trim()}>
              {t("projects.task_add_short")}
            </Button>
          </form>
        ) : (
          <button type="button" className="flex items-center gap-1 rounded px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            {t("projects.checklist_add")}
          </button>
        ))}
    </div>
  );
}

export function History({ events }: { events: TaskEvent[] }) {
  const t = useXT();
  const locale = useLocale();
  const value = (e: TaskEvent, v: string | null) => {
    if (v === null || v === "") return "—";
    if (e.field === "done") return v === "done" ? t("projects.history_done") : t("projects.history_open");
    if (e.field === "priority") return t(`projects.priority.${v}`);
    if (e.field === "due") return new Date(`${v}T12:00:00`).toLocaleDateString(locale);
    return v;
  };
  if (events.length === 0) return <p className="text-sm text-muted-foreground">{t("projects.history_none")}</p>;
  return (
    <ol className="space-y-1.5 text-sm">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="text-muted-foreground">
          <span className="text-foreground">{e.author?.name ?? "—"}</span> {t(`projects.history_field.${e.field}`)}
          {e.field !== "created" && (
            <>
              {": "}
              <span className="line-through decoration-muted-foreground/60">{value(e, e.from)}</span> → <span className="text-foreground">{value(e, e.to)}</span>
            </>
          )}
          <span className="ml-1 text-xs">· {new Date(e.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span>
        </li>
      ))}
    </ol>
  );
}

/** The mentions still in the text: "@Name" of a picked person. */
export function mentionsIn(text: string, picked: PersonRef[]): string[] {
  return [...new Set(picked.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id))];
}

export function MentionInput({ people, onSend, disabled }: { people: PersonRef[]; onSend: (body: string, mentions: string[]) => Promise<boolean>; disabled?: boolean }) {
  const t = useXT();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<PersonRef[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);

  const options = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return people.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().startsWith(q)).slice(0, 6);
  }, [people, query]);

  const change = (value: string, caret: number) => {
    setText(value);
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(value.slice(0, caret));
    setQuery(m ? m[2]! : null);
    setActive(0);
  };

  const pick = (p: PersonRef) => {
    const el = input.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${p.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur : [...cur, p]));
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    if (await onSend(body, mentionsIn(body, picked))) {
      setText("");
      setPicked([]);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length > 0) {
      if (e.key === "ArrowDown") return e.preventDefault(), setActive((a) => (a + 1) % options.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setActive((a) => (a - 1 + options.length) % options.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), pick(options[active]!);
      if (e.key === "Escape") return e.preventDefault(), setQuery(null);
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
  };

  return (
    <form onSubmit={submit} className="relative space-y-1.5">
      <textarea
        ref={input}
        className="min-h-16 w-full rounded-md border border-input bg-background p-2 text-sm"
        value={text}
        disabled={disabled}
        maxLength={4000}
        placeholder={`${t("projects.comment_add")} · ${t("projects.mention_hint")}`}
        aria-label={t("projects.comment_add")}
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls="task-mention-options"
        aria-autocomplete="list"
        onChange={(e) => change(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onKeyDown={onKey}
      />
      {options.length > 0 && (
        <ul id="task-mention-options" role="listbox" aria-label={t("projects.mention_pick")} className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {options.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={cn("flex w-full flex-col rounded px-2 py-1 text-left text-sm", i === active ? "bg-muted" : "hover:bg-muted/60")}
                onMouseDown={(e) => (e.preventDefault(), pick(p))}
              >
                <span>{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={disabled || !text.trim()}>
          {t("projects.comment_send")}
        </Button>
      </div>
    </form>
  );
}

/** A comment's text with the mentioned names stressed. */
export function CommentBody({ body, people }: { body: string; people: PersonRef[] }) {
  const names = people.map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length === 0) return <>{body}</>;
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`, "g");
  return (
    <>
      {body.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="rounded bg-primary/10 px-0.5 font-medium text-primary">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
