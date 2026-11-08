"use client";

// xenaxio step 118, parts C and D: one project — its board (tasks in its own
// columns), the overview drawn from the type's card (status, due date, owner,
// people, description, sub-projects) and what is linked to it (emails, files,
// the chat channel, events). People of the project change it; its owners
// manage people, who sees it and the archive.
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { Archive, ArrowLeft, Calendar, FileText, Folder, Link as LinkIcon, Mail, MessagesSquare, MoreHorizontal, Plus, Trash, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { MarkdownView } from "@/components/xenaxio/markdown-view";
import { Notice } from "@/components/xenaxio/ui";
import { Link } from "@/i18n/navigation";
import { buildFileNodePath } from "@/lib/deep-links";
import { cn } from "@/lib/utils";
import { errorText, XenaxioApiError } from "@/lib/xenaxio/api";
import { useChatStore } from "@/lib/xenaxio/chat/store";
import { useXT } from "@/lib/xenaxio/i18n";
import { useXenaxioMe } from "@/lib/xenaxio/me-store";
import { useViewPrefs } from "@/lib/xenaxio/view-prefs";
import { usePeopleStore } from "@/lib/xenaxio/people";
import {
  type BoardColumn,
  dayText,
  filterTasks,
  isOverdue,
  local,
  type ObjectDetail,
  type ObjectLink,
  type ObjectType,
  type Priority,
  projectsApi,
  type RollupProject,
  type RollupTask,
  type TaskFilter,
  type TaskSummary,
} from "@/lib/xenaxio/projects";
import { toast } from "@/stores/toast-store";
import { Board } from "./board";
import { Modal, PeoplePicker, PersonBadge, selectClass, StatusChip } from "./bits";
import { NewProjectDialog } from "./project-list";
import { FieldInput } from "./fields";
import { RecordComments } from "./record-comments";
import { Attachments } from "./attachments";
import { RecordHistory } from "./record-history";
import { Lock } from "@/components/icons";
import { typeHref } from "@/lib/xenaxio/projects";
import { TaskPanel } from "./task-panel";

type Tab = "board" | "overview" | "linked" | "history";

/** Where a linked thing opens in the app. */
export function linkHref(l: Pick<ObjectLink, "kind" | "ref" | "account">): string | null {
  if (l.kind === "email") return `/mail/message/${encodeURIComponent(l.ref)}${l.account ? `?account=${encodeURIComponent(l.account)}` : ""}`;
  if (l.kind === "file") return buildFileNodePath(l.ref, l.account);
  if (l.kind === "channel") return `/chat?room=${encodeURIComponent(l.ref)}`;
  if (l.kind === "event") return "/calendar";
  if (l.kind === "object") return `/projects?id=${encodeURIComponent(l.ref)}`;
  return null;
}

const LINK_ICONS = { email: Mail, file: FileText, channel: MessagesSquare, event: Calendar, flow_run: Folder, object: LinkIcon } as const;

function TaskCard({ task, locale, onOpen, project }: { task: TaskSummary; locale: string; onOpen: () => void; project?: string }) {
  const t = useXT();
  return (
    <button type="button" onClick={onOpen} className={cn("block w-full rounded-md border border-border bg-background p-2.5 text-left shadow-sm hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", task.done && "opacity-70")}>
      {task.labels.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <span key={l} className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
              {l}
            </span>
          ))}
        </div>
      )}
      {project && <p className="mb-0.5 truncate text-[11px] text-muted-foreground">{project}</p>}
      <p className={cn("text-sm", task.done && "line-through")}>{task.title}</p>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">{task.ref}</span>
        {task.priority === "high" && <span className="font-medium text-destructive">{t("projects.priority.high")}</span>}
        {task.dueOn && <span className={cn(isOverdue(task.dueOn, task.done) && "font-medium text-destructive")}>{dayText(task.dueOn, locale)}</span>}
        {task.checklist.total > 0 && (
          <span className={cn("tabular-nums", task.checklist.done === task.checklist.total && "text-green-600 dark:text-green-500")} title={t("projects.checklist_count", { done: task.checklist.done, total: task.checklist.total })}>
            ☑ {task.checklist.done}/{task.checklist.total}
          </span>
        )}
        {task.attachments > 0 && <span title={t("projects.attachments_count", { count: task.attachments })}>📎 {task.attachments}</span>}
        {task.comments > 0 && <span>💬 {task.comments}</span>}
        <span className="ml-auto">{task.assignee && <PersonBadge name={task.assignee.name} email={task.assignee.email} />}</span>
      </div>
    </button>
  );
}

function AddTask({ onAdd }: { onAdd: (title: string) => Promise<void> }) {
  const t = useXT();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await onAdd(title.trim());
    setTitle("");
  };
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-background hover:text-foreground">
        <Plus className="h-4 w-4" />
        {t("projects.task_add")}
      </button>
    );
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("projects.task_title")} aria-label={t("projects.task_title")} maxLength={200} autoFocus onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
      <div className="flex gap-1">
        <Button type="submit" size="sm" disabled={!title.trim()}>
          {t("projects.task_add_short")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

function ColumnMenu({ column, columns, onChanged, canEdit }: { column: BoardColumn; columns: BoardColumn[]; onChanged: (c: BoardColumn[]) => void; canEdit: boolean; }) {
  const t = useXT();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const objectId = useProjectId();
  if (!canEdit) return null;
  const run = async (fn: () => Promise<{ columns: BoardColumn[] }>) => {
    try {
      onChanged((await fn()).columns);
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };
  const index = columns.findIndex((c) => c.id === column.id);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="rounded p-0.5 text-muted-foreground hover:bg-background" aria-label={t("projects.column_menu")} aria-expanded={open}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-20 w-52 rounded-md border border-border bg-background py-1 text-sm shadow-lg" onMouseLeave={() => setOpen(false)}>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-muted" onClick={() => (setOpen(false), setRenaming(true))}>
            {t("projects.column_rename")}
          </button>
          <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-muted" onClick={() => (setOpen(false), void run(() => projectsApi.updateColumn(objectId, column.id, { done: !column.done })))}>
            {column.done ? t("projects.column_not_done") : t("projects.column_done")}
          </button>
          {index > 0 && (
            <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-muted" onClick={() => (setOpen(false), void run(() => projectsApi.updateColumn(objectId, column.id, { index: index - 1 })))}>
              {t("projects.column_left")}
            </button>
          )}
          {index < columns.length - 1 && (
            <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-muted" onClick={() => (setOpen(false), void run(() => projectsApi.updateColumn(objectId, column.id, { index: index + 1 })))}>
              {t("projects.column_right")}
            </button>
          )}
          {columns.length > 1 && (
            <button type="button" className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-muted" onClick={() => (setOpen(false), setMoveTo(columns.find((c) => c.id !== column.id)?.id ?? ""), setRemoving(true))}>
              {t("projects.column_delete")}
            </button>
          )}
        </div>
      )}
      <PromptDialog isOpen={renaming} onClose={() => setRenaming(false)} title={t("projects.column_rename")} defaultValue={column.name} onSubmit={(name) => (setRenaming(false), name.trim() && void run(() => projectsApi.updateColumn(objectId, column.id, { name: name.trim() })))} />
      <Modal open={removing} onClose={() => setRemoving(false)} title={t("projects.column_delete")}>
        <p className="mb-2 text-sm">{t("projects.column_delete_text", { name: column.name })}</p>
        <select className={selectClass} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label={t("projects.column_move_to")}>
          {columns
            .filter((c) => c.id !== column.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRemoving(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => (setRemoving(false), void run(() => projectsApi.removeColumn(objectId, column.id, moveTo || undefined)))}>
            {t("projects.column_delete")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// The open project's id for the small menus (one project per page).
let currentProjectId = "";
function useProjectId(): string {
  return currentProjectId;
}

type LanesBy = "none" | "assignee" | "project" | "priority" | "label";
type Merge = "done" | "names";
const SEP = "\u0001";

interface BoardPrefs extends Record<string, unknown> {
  mode: "board" | "list";
  subs: boolean;
  merge: Merge;
  lanes: LanesBy;
  filter: Omit<TaskFilter, "text">;
}

/** Valid board view values from what is stored (old or unknown values fall back to defaults). */
function parseBoardPrefs(v: Record<string, unknown>): BoardPrefs {
  const f = (v.filter && typeof v.filter === "object" ? v.filter : {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x.length <= 80 ? x : null);
  return {
    mode: v.mode === "list" ? "list" : "board",
    subs: v.subs === true,
    merge: v.merge === "names" ? "names" : "done",
    lanes: (["assignee", "project", "priority", "label"] as const).includes(v.lanes as never) ? (v.lanes as LanesBy) : "none",
    filter: { assignee: str(f.assignee), due: f.due === "overdue" || f.due === "week" ? f.due : null, label: str(f.label) },
  };
}

function TaskBoard({ project, onOpenTask, reloadKey }: { project: ObjectDetail; onOpenTask: (id: string) => void; reloadKey: number }) {
  const t = useXT();
  const locale = useLocale();
  const [columns, setColumns] = useState<BoardColumn[]>(project.columns);
  const [tasks, setTasks] = useState<(TaskSummary | RollupTask)[] | null>(null);
  const [subProjects, setSubProjects] = useState<RollupProject[]>([]);
  const [addingColumn, setAddingColumn] = useState(false);
  const [foreign, setForeign] = useState<{ project: ObjectDetail; taskId: string } | null>(null);
  // Step 124 H, I + 125: the person's view of the board (mode, sub-projects, columns, swimlanes,
  // filters), the same on every device; the search text stays with the page.
  const [prefs, setPrefs] = useViewPrefs(`board.${project.id}`, parseBoardPrefs, `xenaxio.board.${project.id}`);
  const mode = prefs.mode;
  const setMode = (m: "board" | "list") => setPrefs({ mode: m });
  const [text, setText] = useState("");
  const filter: TaskFilter = useMemo(() => ({ ...prefs.filter, ...(text ? { text } : {}) }), [prefs.filter, text]);
  const setFilter = (u: TaskFilter | ((f: TaskFilter) => TaskFilter)) => {
    const next = typeof u === "function" ? u(filter) : u;
    setText(next.text ?? "");
    const rest = { assignee: next.assignee ?? null, due: next.due ?? null, label: next.label ?? null };
    if (JSON.stringify(rest) !== JSON.stringify(prefs.filter)) setPrefs({ filter: rest });
  };
  const canEdit = project.can.edit;
  const hasChildren = project.children.length > 0;
  const subs = hasChildren && prefs.subs;
  const lanesBy: LanesBy = prefs.lanes === "project" && !subs ? "none" : prefs.lanes;

  const load = useCallback(() => {
    const req = subs
      ? projectsApi.rollup(project.id).then((r) => {
          setSubProjects(r.projects);
          setColumns(r.projects.find((p) => p.id === project.id)?.columns ?? []);
          setTasks(r.tasks);
        })
      : projectsApi.tasks(project.id).then((r) => {
          setColumns(r.columns);
          setTasks(r.tasks);
        });
    req.catch((err: unknown) => toast.error(errorText(t, err)));
  }, [project.id, subs, t]);

  useEffect(load, [load, reloadKey]);
  // Colleagues' changes: read again when the tab comes back (no live updates yet, C1).
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const shown = useMemo(() => filterTasks(tasks ?? [], filter), [tasks, filter]);
  const byId = useMemo(() => new Map((tasks ?? []).map((x) => [x.id, x])), [tasks]);
  const labels = useMemo(() => [...new Set((tasks ?? []).flatMap((x) => x.labels))].sort(), [tasks]);
  const filtering = !!(filter.assignee || filter.due || filter.label || filter.text);
  const projectOf = (x: TaskSummary | RollupTask) => ("project" in x ? x.project : null);

  // The columns shown: the project's own, or with sub-projects merged by "done" or by name.
  const shownColumns = useMemo((): { key: string; name: string; done: boolean; column?: BoardColumn }[] => {
    if (!subs) return columns.map((c) => ({ key: c.id, name: c.name, done: c.done, column: c }));
    if (prefs.merge === "done") return [{ key: "open", name: t("projects.subprojects_open"), done: false }, { key: "done", name: t("projects.subprojects_done"), done: true }];
    const out = new Map<string, { key: string; name: string; done: boolean }>();
    for (const p of subProjects) for (const c of p.columns) {
      const key = `name:${c.name.trim().toLowerCase()}`;
      const had = out.get(key);
      out.set(key, { key, name: had?.name ?? c.name, done: (had?.done ?? false) || c.done });
    }
    return [...out.values()];
  }, [subs, prefs.merge, columns, subProjects, t]);

  const colKey = (x: TaskSummary | RollupTask): string => {
    if (!subs) return x.columnId;
    if (prefs.merge === "done") return x.done ? "done" : "open";
    return `name:${("column" in x ? x.column : "").trim().toLowerCase()}`;
  };

  // Step 124 I: swimlanes.
  const rowsOf = useMemo((): { key: string; title: string }[] => {
    if (lanesBy === "assignee") return [...project.people.map((p) => ({ key: p.id, title: p.name })), { key: "none", title: t("projects.lane_nobody") }];
    if (lanesBy === "project") return subProjects.map((p) => ({ key: p.id, title: `${p.ref} · ${p.title}` }));
    if (lanesBy === "priority") return [...(["high", "medium", "low"] as const).map((p) => ({ key: p, title: t(`projects.priority.${p}`) })), { key: "none", title: t("projects.lane_no_priority") }];
    if (lanesBy === "label") return [...labels.map((l) => ({ key: `l:${l}`, title: l })), { key: "none", title: t("projects.lane_no_label") }];
    return [];
  }, [lanesBy, project.people, subProjects, labels, t]);

  const rowKey = (x: TaskSummary | RollupTask): string => {
    if (lanesBy === "assignee") return x.assignee?.id ?? "none";
    if (lanesBy === "project") return projectOf(x)?.id ?? project.id;
    if (lanesBy === "priority") return x.priority ?? "none";
    if (lanesBy === "label") return x.labels[0] ? `l:${x.labels[0]}` : "none";
    return "";
  };
  const laneId = (row: string, col: string) => (lanesBy === "none" ? col : `${row}${SEP}${col}`);

  const fail = (err: unknown) => toast.error(errorText(t, err));

  const move = async (id: string, lane: string, index: number) => {
    const task = byId.get(id);
    if (!task) return;
    const [row, col] = lanesBy === "none" ? ["", lane] : (lane.split(SEP) as [string, string]);
    const owner = projectOf(task)?.id ?? project.id;
    try {
      // A new swimlane changes the field it groups by.
      if (lanesBy !== "none" && row !== rowKey(task)) {
        if (lanesBy === "project") {
          toast.error(t("projects.lane_project_move"));
          load();
          return;
        }
        const change =
          lanesBy === "assignee"
            ? { assigneeId: row === "none" ? null : row }
            : lanesBy === "priority"
              ? { priority: row === "none" ? null : (row as Priority) }
              : { labels: row === "none" ? task.labels.slice(1) : [row.slice(2), ...task.labels.filter((l, i) => i > 0 && l !== row.slice(2))] };
        await projectsApi.updateTask(owner, id, change);
      }
      if (col !== colKey(task) || (lanesBy === "none" && !subs)) {
        if (!subs) {
          // In swimlanes the place inside the column is not shown as such: a new column puts the card at its end.
          const at = lanesBy === "none" ? index : (tasks ?? []).filter((x) => x.columnId === col && x.id !== id).length;
          await projectsApi.moveTask(project.id, id, col, at);
        } else if (prefs.merge === "done") {
          await projectsApi.updateTask(owner, id, { done: col === "done" });
        } else {
          const name = shownColumns.find((c) => c.key === col)?.name ?? "";
          const target = subProjects.find((p) => p.id === owner)?.columns.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
          if (!target) toast.error(t("projects.subprojects_no_column", { ref: projectOf(task)?.ref ?? "", name }));
          else await projectsApi.moveTask(owner, id, target.id, (tasks ?? []).filter((x) => x.columnId === target.id && x.id !== id).length);
        }
      }
    } catch (err) {
      fail(err);
    }
    load();
  };

  const add = async (columnId: string, title: string) => {
    try {
      await projectsApi.createTask(project.id, { title, columnId });
      load();
    } catch (err) {
      fail(err);
    }
  };

  const open = (x: TaskSummary | RollupTask) => {
    const p = projectOf(x);
    if (!p || p.id === project.id) return onOpenTask(x.id);
    projectsApi
      .get(p.id)
      .then((d) => setForeign({ project: d, taskId: x.id }))
      .catch(fail);
  };

  if (!tasks) return <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>;

  const plain = !subs && lanesBy === "none";
  const lanes = (lanesBy === "none" ? [{ key: "", title: "" }] : rowsOf).flatMap((r) =>
    shownColumns.map((c) => ({
      id: laneId(r.key, c.key),
      title: c.name,
      done: c.done,
      ...(plain && c.column ? { header: <ColumnMenu column={c.column} columns={columns} canEdit={canEdit} onChanged={(next) => (setColumns(next), load())} /> } : {}),
      ...(canEdit && !subs && c.column && lanesBy === "none" ? { footer: <AddTask onAdd={(title) => add(c.column!.id, title)} /> } : {}),
    })),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <div className="flex rounded-md border border-border p-0.5 text-sm">
          {(["board", "list"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn("rounded px-2 py-0.5", mode === m ? "bg-muted font-medium" : "text-muted-foreground")}>
              {t(`projects.view.${m}`)}
            </button>
          ))}
        </div>
        {hasChildren && (
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={subs} onChange={(e) => setPrefs({ subs: e.target.checked })} />
            {t("projects.subprojects")}
          </label>
        )}
        {subs && mode === "board" && (
          <select className={cn(selectClass, "h-8 w-auto")} value={prefs.merge} onChange={(e) => setPrefs({ merge: e.target.value as Merge })} aria-label={t("projects.subprojects_merge")}>
            <option value="done">{t("projects.subprojects_merge_done")}</option>
            <option value="names">{t("projects.subprojects_merge_names")}</option>
          </select>
        )}
        {mode === "board" && (
          <select className={cn(selectClass, "h-8 w-auto")} value={lanesBy} onChange={(e) => setPrefs({ lanes: e.target.value as LanesBy })} aria-label={t("projects.lanes")}>
            <option value="none">{t("projects.lanes_none")}</option>
            <option value="assignee">{t("projects.lanes_assignee")}</option>
            {subs && <option value="project">{t("projects.lanes_project")}</option>}
            <option value="priority">{t("projects.lanes_priority")}</option>
            <option value="label">{t("projects.lanes_label")}</option>
          </select>
        )}
        <Input className="h-8 w-full min-w-0 sm:w-48" value={filter.text ?? ""} onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))} placeholder={t("projects.filter_text")} aria-label={t("projects.filter_text")} />
        <select className={cn(selectClass, "h-8 w-auto")} value={filter.assignee ?? ""} onChange={(e) => setFilter((f) => ({ ...f, assignee: e.target.value || null }))} aria-label={t("projects.filter_assignee")}>
          <option value="">{t("projects.filter_anyone")}</option>
          <option value="none">{t("projects.filter_nobody")}</option>
          {project.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className={cn(selectClass, "h-8 w-auto")} value={filter.due ?? ""} onChange={(e) => setFilter((f) => ({ ...f, due: (e.target.value || null) as TaskFilter["due"] }))} aria-label={t("projects.filter_due")}>
          <option value="">{t("projects.filter_any_due")}</option>
          <option value="overdue">{t("projects.filter_overdue")}</option>
          <option value="week">{t("projects.filter_week")}</option>
        </select>
        {labels.length > 0 && (
          <select className={cn(selectClass, "h-8 w-auto")} value={filter.label ?? ""} onChange={(e) => setFilter((f) => ({ ...f, label: e.target.value || null }))} aria-label={t("projects.filter_label")}>
            <option value="">{t("projects.filter_any_label")}</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}
        {filtering && (
          <button type="button" className="text-sm text-primary hover:underline" onClick={() => setFilter({})}>
            {t("projects.filter_clear")}
          </button>
        )}
      </div>

      {mode === "board" ? (
        <Board
          label={t("projects.view.board")}
          lanes={lanes}
          items={shown.map((x) => ({ id: x.id, laneId: laneId(rowKey(x), colKey(x)) }))}
          {...(lanesBy !== "none" ? { rows: rowsOf.map((r) => ({ id: r.key, title: r.title, laneIds: shownColumns.map((c) => laneId(r.key, c.key)) })) } : {})}
          // Moving while filtered would place cards among hidden ones: only without filters.
          disabled={!canEdit || filtering}
          emptyText={t("projects.lane_empty_tasks")}
          onMove={(id, lane, index) => void move(id, lane, index)}
          render={(id) => {
            const task = byId.get(id);
            const p = task ? projectOf(task) : null;
            return task ? <TaskCard task={task} locale={locale} onOpen={() => open(task)} {...(p && p.id !== project.id ? { project: `${p.ref} · ${p.title}` } : {})} /> : null;
          }}
          after={
            plain && canEdit && columns.length < 20 ? (
              <button type="button" onClick={() => setAddingColumn(true)} className="flex h-10 w-48 shrink-0 items-center gap-1 rounded-lg border border-dashed border-border px-3 text-sm text-muted-foreground hover:text-foreground">
                <Plus className="h-4 w-4" />
                {t("projects.column_add")}
              </button>
            ) : null
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">{t("projects.task")}</th>
                {subs && <th className="px-2 py-2 font-medium">{t("projects.sub")}</th>}
                <th className="px-2 py-2 font-medium">{t("projects.column")}</th>
                <th className="px-2 py-2 font-medium">{t("projects.assignee")}</th>
                <th className="px-2 py-2 font-medium">{t("projects.field.due")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((x) => (
                <tr key={x.id} className="cursor-pointer border-b border-border hover:bg-muted/50" onClick={() => open(x)}>
                  <td className={cn("px-4 py-2", x.done && "text-muted-foreground line-through")}>
                    <span className="mr-2 text-xs tabular-nums text-muted-foreground no-underline">{x.ref}</span>
                    <button type="button" className="text-left hover:underline" onClick={() => open(x)}>
                      {x.title}
                    </button>
                  </td>
                  {subs && <td className="px-2 py-2">{projectOf(x)?.ref ?? project.ref}</td>}
                  <td className="px-2 py-2">{"column" in x ? x.column : columns.find((c) => c.id === x.columnId)?.name}</td>
                  <td className="px-2 py-2">{x.assignee?.name ?? "—"}</td>
                  <td className={cn("px-2 py-2", isOverdue(x.dueOn, x.done) && "font-medium text-destructive")}>{x.dueOn ? dayText(x.dueOn, locale) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">{t("projects.tasks_none")}</p>}
        </div>
      )}
      <PromptDialog
        isOpen={addingColumn}
        onClose={() => setAddingColumn(false)}
        title={t("projects.column_add")}
        onSubmit={(name) => {
          setAddingColumn(false);
          if (!name.trim()) return;
          projectsApi
            .addColumn(project.id, { name: name.trim() })
            .then((r) => setColumns(r.columns))
            .catch(fail);
        }}
      />
      {foreign && <TaskPanel project={foreign.project} taskId={foreign.taskId} onClose={() => setForeign(null)} onChanged={load} />}
    </div>
  );
}

function Overview({ project, type, allTypes, onChanged, onOpenProject }: { project: ObjectDetail; type: ObjectType | undefined; allTypes: ObjectType[]; onChanged: (p: ObjectDetail) => void; onOpenProject: (id: string) => void }) {
  const t = useXT();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(project.description);
  const [adding, setAdding] = useState(false);
  const [newPeople, setNewPeople] = useState<string[]>([]);
  const [creatingSub, setCreatingSub] = useState(false);
  const canEdit = project.can.edit;
  const canManage = project.can.manage;

  const save = async (body: Parameters<typeof projectsApi.update>[1]) => {
    try {
      onChanged(await projectsApi.update(project.id, body));
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };
  const people = async (fn: () => Promise<ObjectDetail | Record<string, never>>) => {
    try {
      const r = await fn();
      if ("id" in r) onChanged(r as ObjectDetail);
      else onChanged(await projectsApi.get(project.id));
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };

  // The card follows the type: its order of fields (status, due, owner, members, description).
  const blocks: Record<string, React.ReactNode> = {
    status: (
      <label className="block space-y-1 text-sm">
        <span className="text-xs text-muted-foreground">{t("projects.field.status")}</span>
        <select className={selectClass} value={project.status} disabled={!canEdit} onChange={(e) => void save({ status: e.target.value })}>
          {(type?.statuses ?? []).map((s) => (
            <option key={s.key} value={s.key}>
              {local(s.name, locale)}
            </option>
          ))}
        </select>
      </label>
    ),
    due: (
      <label className="block space-y-1 text-sm">
        <span className="text-xs text-muted-foreground">{t("projects.field.due")}</span>
        <Input type="date" value={project.dueOn ?? ""} disabled={!canEdit} onChange={(e) => void save({ dueOn: e.target.value || null })} />
      </label>
    ),
    owner: (
      <label className="block space-y-1 text-sm">
        <span className="text-xs text-muted-foreground">{t("projects.field.owner")}</span>
        <select className={selectClass} value={project.owner?.id ?? ""} disabled={!canEdit} onChange={(e) => void save({ ownerId: e.target.value || null })}>
          <option value="">—</option>
          {project.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    ),
    members: (
      <div className="space-y-1.5 text-sm sm:col-span-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("projects.field.people")}</span>
          {canEdit && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => (setNewPeople([]), setAdding(true))}>
              {t("projects.people_add")}
            </button>
          )}
        </div>
        <ul className="divide-y divide-border rounded-md border border-border">
          {project.people.map((p) => (
            <li key={p.id} className="flex items-center gap-2 px-2 py-1.5">
              <PersonBadge name={p.name} email={p.email} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {canManage ? (
                <select className="h-7 rounded border border-input bg-background px-1 text-xs" value={p.role} onChange={(e) => void people(() => projectsApi.setPerson(project.id, p.id, e.target.value as "owner" | "member"))} aria-label={t("projects.role")}>
                  <option value="owner">{t("projects.role_owner")}</option>
                  <option value="member">{t("projects.role_member")}</option>
                </select>
              ) : (
                <span className="text-xs text-muted-foreground">{p.role === "owner" ? t("projects.role_owner") : t("projects.role_member")}</span>
              )}
              {canManage && (
                <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => void people(() => projectsApi.removePerson(project.id, p.id))} aria-label={t("projects.people_remove", { name: p.name })}>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {canManage && (
          <label className="flex items-center gap-2 pt-1 text-sm">
            <input type="checkbox" checked={project.visibility === "company"} onChange={(e) => void save({ visibility: e.target.checked ? "company" : "members" })} />
            {project.type === "project" ? t("projects.visibility.company_toggle") : t("objects.visibility_company")}
          </label>
        )}
      </div>
    ),
    description: (
      <div className="space-y-1.5 text-sm sm:col-span-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("projects.field.description")}</span>
          {canEdit && !editing && (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => (setDescription(project.description), setEditing(true))}>
              {t("projects.edit")}
            </button>
          )}
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea className="min-h-40 w-full rounded-md border border-input bg-background p-2 font-mono text-sm" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={20000} aria-label={t("projects.field.description")} />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => (setEditing(false), void save({ description }))}>
                {t("common.save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : project.description ? (
          <MarkdownView source={project.description} className="rounded-md border border-border p-3" />
        ) : (
          <p className="text-muted-foreground">{t("projects.description_none")}</p>
        )}
      </div>
    ),
  };

  // Step 119: the type's own fields, in the card's order.
  for (const f of type?.fields ?? []) {
    if (f.type === "external") continue;
    blocks[f.key] = (
      <div className="block space-y-1 text-sm">
        <label htmlFor={`f-${f.key}`} className="flex items-center gap-1 text-xs text-muted-foreground">
          {local(f.label, locale)}
          {f.required ? " *" : ""}
          {f.sensitive && <Lock className="h-3 w-3" aria-label={t("objects.sensitive")} />}
        </label>
        <FieldInput id={`f-${f.key}`} field={f} objectId={project.id} value={project.fields?.[f.key] ?? null} disabled={!canEdit} onSave={(v) => void save({ fields: { [f.key]: v } })} />
      </div>
    );
  }
  const wide = (key: string) => ["members", "description"].includes(key) || ["textarea", "refs", "multiselect"].includes(type?.fields.find((f) => f.key === key)?.type ?? "");
  const nests = !type || type.parentTypes.includes(type.key);
  const typeName = (key: string) => local(allTypes.find((x) => x.key === key)?.plural, locale) || key;

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
      <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
        {(type?.card ?? Object.keys(blocks)).map((key) => (blocks[key] ? <div key={key} className={cn(wide(key) && "sm:col-span-2")}>{blocks[key]}</div> : null))}
        {project.backrefs.map((b) => (
          <div key={`${b.type}:${b.field}`} className="space-y-1.5 text-sm sm:col-span-2">
            <span className="text-xs text-muted-foreground">{t("objects.backrefs", { type: typeName(b.type) })}</span>
            <ul className="space-y-1">
              {b.records.map((r) => (
                <li key={r.id}>
                  <Link href={typeHref(b.type, r.id)} className="text-primary hover:underline">
                    {r.ref} {r.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {(type?.attachments ?? false) && <Attachments objectId={project.id} canEdit={project.can.edit && !project.archivedAt} />}
        {type?.comments && <RecordComments objectId={project.id} archived={!!project.archivedAt} type={type} />}
        {nests && <div className="space-y-1.5 text-sm sm:col-span-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("projects.sub")}</span>
            {canEdit && (
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setCreatingSub(true)}>
                {t("projects.new_sub")}
              </button>
            )}
          </div>
          {project.parent && (
            <p>
              {t("projects.parent")}:{" "}
              <button type="button" className="text-primary hover:underline" onClick={() => onOpenProject(project.parent!.id)}>
                {project.parent.ref} {project.parent.title}
              </button>
            </p>
          )}
          {project.children.length > 0 ? (
            <ul className="space-y-1">
              {project.children.map((c) => (
                <li key={c.id}>
                  <button type="button" className="text-primary hover:underline" onClick={() => onOpenProject(c.id)}>
                    {c.ref} {c.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            !project.parent && <p className="text-muted-foreground">{t("projects.sub_none")}</p>
          )}
        </div>}
      </div>
      <Modal open={adding} onClose={() => setAdding(false)} title={t("projects.people_add")}>
        <PeoplePicker selected={newPeople} onChange={setNewPeople} exclude={project.people.map((p) => p.id)} />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAdding(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={newPeople.length === 0}
            onClick={async () => {
              setAdding(false);
              let last: ObjectDetail | null = null;
              for (const id of newPeople) {
                try {
                  last = await projectsApi.setPerson(project.id, id);
                } catch (err) {
                  toast.error(errorText(t, err));
                }
              }
              if (last) onChanged(last);
            }}
          >
            {t("projects.people_add")}
          </Button>
        </div>
      </Modal>
      <NewProjectDialog type={type} open={creatingSub} onClose={() => setCreatingSub(false)} parentId={project.id} onCreated={(id) => (setCreatingSub(false), onOpenProject(id))} />
    </div>
  );
}

function Linked({ project, onChanged }: { project: ObjectDetail; onChanged: (p: ObjectDetail) => void }) {
  const t = useXT();
  const canEdit = project.can.edit;
  const [creating, setCreating] = useState(false);
  const channel = project.links.find((l) => l.kind === "channel");
  // Step 124 B: links of tasks show in their task.
  const recordLinks = project.links.filter((l) => !l.taskId);

  const remove = async (l: ObjectLink) => {
    try {
      await projectsApi.removeLink(project.id, l.id);
      onChanged(await projectsApi.get(project.id));
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };

  // D4: a Rooms channel for the project; its people are invited.
  const createChannel = async () => {
    setCreating(true);
    try {
      await useChatStore.getState().connect();
      const client = useChatStore.getState().client;
      if (!client) throw new XenaxioApiError(409, "chat_unavailable");
      await usePeopleStore.getState().load();
      const all = usePeopleStore.getState().people;
      const invite = project.people.map((p) => all.get(p.email.toLowerCase())?.chatAddress).filter((a): a is string => !!a);
      const name = project.title.slice(0, 80);
      const roomId = await client.createChannel({ name, topic: `${project.ref} · ${project.title}`, isPublic: false, invite });
      await projectsApi.addLink(project.id, { kind: "channel", ref: roomId, title: name });
      onChanged(await projectsApi.get(project.id));
    } catch (err) {
      toast.error(errorText(t, err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
      <div className="max-w-3xl space-y-3">
        <p className="text-sm text-muted-foreground">{t("projects.linked_intro")}</p>
        {canEdit && !channel && (
          <Button size="sm" variant="outline" onClick={() => void createChannel()} disabled={creating}>
            <MessagesSquare className="mr-1 h-4 w-4" />
            {t("projects.channel_create")}
          </Button>
        )}
        {recordLinks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("projects.linked_none")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {recordLinks.map((l) => {
              const Icon = LINK_ICONS[l.kind] ?? LinkIcon;
              const href = linkHref(l);
              return (
                <li key={l.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">{t(`projects.link_kind.${l.kind}`)}</span>
                  {href ? (
                    <Link href={href} className="min-w-0 flex-1 truncate text-primary hover:underline">
                      {l.title || l.ref}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{l.title || l.ref}</span>
                  )}
                  {canEdit && (
                    <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => void remove(l)} aria-label={t("projects.link_remove")}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ProjectView({ id, taskId, onOpenTask, onOpenProject, onBack }: { id: string; taskId: string | null; onOpenTask: (task: string | null) => void; onOpenProject: (id: string) => void; onBack: () => void }) {
  const t = useXT();
  const locale = useLocale();
  const [project, setProject] = useState<ObjectDetail | null>(null);
  const [type, setType] = useState<ObjectType | undefined>();
  const [tab, setTab] = useState<Tab>("board");
  const [allTypes, setAllTypes] = useState<ObjectType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [confirm, setConfirm] = useState<null | "delete" | "leave">(null);
  const [reloadKey, setReloadKey] = useState(0);
  const myId = useXenaxioMe()?.user.id ?? null;
  currentProjectId = id;

  const load = useCallback(() => {
    projectsApi
      .get(id)
      .then(setProject)
      .catch((err: unknown) => setError(err instanceof XenaxioApiError && err.status === 404 ? t("projects.not_found") : errorText(t, err)));
  }, [id, t]);

  useEffect(load, [load]);
  const kind = project?.type;
  useEffect(() => {
    if (!kind) return;
    projectsApi
      .types()
      .then((r) => {
        const found = r.types.find((x) => x.key === kind);
        setType(found);
        setAllTypes(r.types);
        if (found && !found.hasTasks) setTab((cur) => (cur === "board" ? "overview" : cur));
      })
      .catch(() => undefined);
  }, [kind]);

  if (error)
    return (
      <div className="flex-1 space-y-3 p-4">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" />
          {t("projects.back")}
        </button>
        <Notice kind="error">{error}</Notice>
      </div>
    );
  if (!project) return <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>;

  const status = type?.statuses.find((s) => s.key === project.status);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    try {
      await fn();
      if (after) after();
      else load();
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="border-b border-border px-3 pt-2 sm:px-4">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label={t("projects.back")}>
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="text-xs text-muted-foreground">{project.ref}</span>
          {status && <StatusChip text={local(status.name, locale)} color={status.color} />}
          {project.archivedAt && <StatusChip text={t("projects.archived")} />}
          <div className="relative ml-auto flex items-center gap-1">
            {project.can.join && (
              <Button size="sm" variant="outline" onClick={() => void act(() => projectsApi.join(project.id))}>
                {t("projects.join")}
              </Button>
            )}
            <button type="button" onClick={() => setMenu((m) => !m)} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label={t("projects.menu")} aria-expanded={menu}>
              <MoreHorizontal className="h-5 w-5" />
            </button>
            {menu && (
              <div className="absolute right-0 top-8 z-30 w-56 rounded-md border border-border bg-background py-1 text-sm shadow-lg" onMouseLeave={() => setMenu(false)}>
                {project.can.edit && (
                  <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-muted" onClick={() => (setMenu(false), setRenaming(true))}>
                    {t("projects.rename")}
                  </button>
                )}
                {project.can.edit && (type?.hasTasks ?? project.type === "project") && (
                  <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-muted" onClick={() => (setMenu(false), setSavingTemplate(true))}>
                    {t("projects.template_save")}
                  </button>
                )}
                {project.can.manage && (
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted" onClick={() => (setMenu(false), void act(() => projectsApi.archive(project.id, !project.archivedAt)))}>
                    <Archive className="h-4 w-4" />
                    {project.archivedAt ? t("projects.restore") : t("projects.to_archive")}
                  </button>
                )}
                {project.can.manage && project.archivedAt && (
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-destructive hover:bg-muted" onClick={() => (setMenu(false), setConfirm("delete"))}>
                    <Trash className="h-4 w-4" />
                    {t("projects.delete")}
                  </button>
                )}
                {project.myRole && (
                  <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-muted" onClick={() => (setMenu(false), setConfirm("leave"))}>
                    {t("projects.leave")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <h1 className="mt-1 truncate text-lg font-semibold">{project.title}</h1>
        <nav role="tablist" aria-label={project.title} className="mt-1 flex gap-4 text-sm">
          {(["board", "overview", "linked", "history"] as const)
            .filter((k) => k !== "board" || (type?.hasTasks ?? project.type === "project"))
            .map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn("-mb-px border-b-2 px-0.5 py-2", tab === k ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>
              {t(`projects.tab.${k}`)}
              {k === "linked" && project.links.some((l) => !l.taskId) ? ` (${project.links.filter((l) => !l.taskId).length})` : ""}
            </button>
          ))}
        </nav>
      </header>

      {tab === "board" && (type?.hasTasks ?? project.type === "project") && <TaskBoard project={project} onOpenTask={(task) => onOpenTask(task)} reloadKey={reloadKey} />}
      {tab === "overview" && <Overview project={project} type={type} allTypes={allTypes} onChanged={setProject} onOpenProject={onOpenProject} />}
      {tab === "linked" && <Linked project={project} onChanged={setProject} />}
      {tab === "history" && <RecordHistory objectId={project.id} type={type} reloadKey={reloadKey} />}

      {taskId && (
        <TaskPanel
          project={project}
          taskId={taskId}
          onClose={() => onOpenTask(null)}
          onChanged={() => {
            setReloadKey((k) => k + 1);
            load();
          }}
        />
      )}

      <PromptDialog
        isOpen={renaming}
        onClose={() => setRenaming(false)}
        title={t("projects.rename")}
        defaultValue={project.title}
        onSubmit={(title) => {
          setRenaming(false);
          if (title.trim()) void act(() => projectsApi.update(project.id, { title: title.trim() }));
        }}
      />
      <PromptDialog
        isOpen={savingTemplate}
        onClose={() => setSavingTemplate(false)}
        title={t("projects.template_save")}
        defaultValue={project.title}
        onSubmit={(name) => {
          setSavingTemplate(false);
          if (!name.trim()) return;
          projectsApi
            .saveTemplate(project.id, name.trim().slice(0, 80))
            .then((tpl) => toast.success(t("projects.template_saved", { name: tpl.name })))
            .catch((err: unknown) => toast.error(errorText(t, err)));
        }}
      />
      <ConfirmDialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "delete" ? t("projects.delete") : t("projects.leave")}
        message={confirm === "delete" ? t("projects.delete_text", { title: project.title }) : t("projects.leave_text", { title: project.title })}
        variant={confirm === "delete" ? "destructive" : "default"}
        confirmText={confirm === "delete" ? t("projects.delete") : t("projects.leave")}
        onConfirm={() => {
          const what = confirm;
          setConfirm(null);
          if (what === "delete") void act(() => projectsApi.remove(project.id), onBack);
          if (what === "leave")
            void act(async () => {
              if (myId) await projectsApi.removePerson(project.id, myId);
            }, onBack);
        }}
      />
    </div>
  );
}
