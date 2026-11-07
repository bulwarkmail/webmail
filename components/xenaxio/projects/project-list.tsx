"use client";

// xenaxio step 118, part D: the list of projects — as a board by status, as a
// list, and "my tasks" across all projects. A new project gets the person as
// its owner and the columns "Offen / In Arbeit / Erledigt".
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { Archive, LayoutGrid, LayoutList, CheckSquare, Plus } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice, TextField } from "@/components/xenaxio/ui";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { useXenaxioMe } from "@/lib/xenaxio/me-store";
import { dayText, isOverdue, local, type MyTask, type ObjectSummary, type ObjectType, projectsApi, type Visibility } from "@/lib/xenaxio/projects";
import { toast } from "@/stores/toast-store";
import { Board } from "./board";
import { Modal, PeoplePicker, PersonBadge, selectClass, StatusChip } from "./bits";

type View = "board" | "list" | "tasks";
const VIEW_KEY = "xenaxio.projects.view";

function readView(): View {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === "list" || v === "tasks" ? v : "board";
  } catch {
    return "board";
  }
}

export function NewProjectDialog({ open, onClose, onCreated, parentId }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; parentId?: string | null }) {
  const t = useXT();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("members");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = useXenaxioMe();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await projectsApi.create({ title: title.trim(), ...(description.trim() ? { description } : {}), ...(dueOn ? { dueOn } : {}), visibility, members, ...(parentId ? { parentId } : {}) });
      setTitle("");
      setDescription("");
      setDueOn("");
      setMembers([]);
      onCreated(created.id);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={parentId ? t("projects.new_sub") : t("projects.new")}>
      <form onSubmit={submit} className="space-y-3">
        {error && <Notice kind="error">{error}</Notice>}
        <TextField label={t("projects.field.title")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        <label className="block space-y-1.5 text-sm font-medium">
          <span>{t("projects.field.description")}</span>
          <textarea className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm font-normal" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={20000} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label={t("projects.field.due")} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t("projects.field.visibility")}</span>
            <select className={selectClass} value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
              <option value="members">{t("projects.visibility.members")}</option>
              <option value="company">{t("projects.visibility.company")}</option>
            </select>
          </label>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("projects.field.people")}</p>
          <PeoplePicker selected={members} onChange={setMembers} exclude={me ? [me.user.id] : []} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !title.trim()}>
            {t("projects.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectCard({ p, type, locale, onOpen, showStatus = true }: { p: ObjectSummary; type: ObjectType | undefined; locale: string; onOpen: () => void; showStatus?: boolean }) {
  const t = useXT();
  const total = p.openTasks + p.doneTasks;
  const status = type?.statuses.find((s) => s.key === p.status);
  return (
    <button type="button" onClick={onOpen} className="block w-full rounded-md border border-border bg-background p-3 text-left shadow-sm hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="flex items-start gap-2">
        <span className="text-xs text-muted-foreground">{p.ref}</span>
        {p.visibility === "company" && <span className="text-xs text-muted-foreground">· {t("projects.visibility.company_short")}</span>}
      </div>
      <p className="mt-0.5 line-clamp-2 text-sm font-medium">{p.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {showStatus && status && <StatusChip text={local(status.name, locale)} color={status.color} />}
        {p.dueOn && <span className={cn(isOverdue(p.dueOn, p.closed) && "font-medium text-destructive")}>{dayText(p.dueOn, locale)}</span>}
        {total > 0 && <span>{t("projects.progress", { done: p.doneTasks, total })}</span>}
        <span className="ml-auto">{p.owner && <PersonBadge name={p.owner.name} email={p.owner.email} />}</span>
      </div>
    </button>
  );
}

export function ProjectList({ onOpen }: { onOpen: (id: string, task?: string) => void }) {
  const t = useXT();
  const locale = useLocale();
  const [view, setViewState] = useState<View>("board");
  const [type, setType] = useState<ObjectType | undefined>();
  const [mayCreate, setMayCreate] = useState(false);
  const [projects, setProjects] = useState<ObjectSummary[] | null>(null);
  const [tasks, setTasks] = useState<MyTask[] | null>(null);
  const [mine, setMine] = useState(false);
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setViewState(readView()), []);
  const setView = (v: View) => {
    setViewState(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Private window: the view is not remembered.
    }
  };

  useEffect(() => {
    projectsApi
      .types()
      .then((r) => {
        setType(r.types.find((x) => x.key === "project"));
        setMayCreate(r.mayCreate);
      })
      .catch((err: unknown) => setError(errorText(t, err)));
  }, [t]);

  const load = useCallback(() => {
    projectsApi
      .list({ archived, mine, ...(q.trim() ? { q: q.trim() } : {}) })
      .then((r) => setProjects(r.objects))
      .catch((err: unknown) => setError(errorText(t, err)));
  }, [archived, mine, q, t]);

  useEffect(() => {
    const timer = window.setTimeout(load, q ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, q]);

  useEffect(() => {
    if (view !== "tasks") return;
    projectsApi
      .myTasks("open")
      .then((r) => setTasks(r.tasks))
      .catch((err: unknown) => setError(errorText(t, err)));
  }, [view, t]);

  const byId = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p])), [projects]);
  const lanes = useMemo(() => (type?.statuses ?? []).map((s) => ({ id: s.key, title: local(s.name, locale), done: s.closed })), [type, locale]);
  const items = useMemo(() => (projects ?? []).map((p) => ({ id: p.id, laneId: p.status })), [projects]);

  const moveProject = async (id: string, status: string) => {
    const p = byId.get(id);
    if (!p || p.status === status) return;
    setProjects((cur) => cur?.map((x) => (x.id === id ? { ...x, status } : x)) ?? cur);
    try {
      await projectsApi.update(id, { status });
    } catch (err) {
      toast.error(errorText(t, err));
    }
    load();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
        <h1 className="mr-2 text-lg font-semibold">{t("projects.title")}</h1>
        <div role="tablist" aria-label={t("projects.views")} className="flex rounded-md border border-border p-0.5">
          {(
            [
              ["board", LayoutGrid, t("projects.view.board")],
              ["list", LayoutList, t("projects.view.list")],
              ["tasks", CheckSquare, t("projects.view.tasks")],
            ] as const
          ).map(([v, Icon, label]) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn("flex items-center gap-1.5 rounded px-2 py-1 text-sm", view === v ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
        {view !== "tasks" && (
          <>
            <Input className="h-9 w-full min-w-0 sm:w-56" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("projects.search")} aria-label={t("projects.search")} />
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              {t("projects.mine")}
            </label>
            <button type="button" onClick={() => setArchived((a) => !a)} aria-pressed={archived} className={cn("flex items-center gap-1 rounded px-2 py-1 text-sm", archived ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              <Archive className="h-4 w-4" />
              {t("projects.archive")}
            </button>
          </>
        )}
        <div className="ml-auto">
          {mayCreate && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" />
              {t("projects.new")}
            </Button>
          )}
        </div>
      </header>
      {error && (
        <div className="p-3">
          <Notice kind="error">{error}</Notice>
        </div>
      )}

      {view === "board" && projects && type && (
        <Board
          label={t("projects.view.board")}
          lanes={lanes}
          items={items}
          emptyText={t("projects.lane_empty")}
          disabled={archived}
          onMove={(id, lane) => void moveProject(id, lane)}
          render={(id) => {
            const p = byId.get(id);
            return p ? <ProjectCard p={p} type={type} locale={locale} showStatus={false} onOpen={() => onOpen(p.id)} /> : null;
          }}
        />
      )}

      {view === "list" && projects && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">{t("projects.field.title")}</th>
                <th className="px-2 py-2 font-medium">{t("projects.field.status")}</th>
                <th className="px-2 py-2 font-medium">{t("projects.field.due")}</th>
                <th className="px-2 py-2 font-medium">{t("projects.field.owner")}</th>
                <th className="px-2 py-2 font-medium">{t("projects.field.tasks")}</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const status = type?.statuses.find((s) => s.key === p.status);
                return (
                  <tr key={p.id} className="cursor-pointer border-b border-border hover:bg-muted/50" onClick={() => onOpen(p.id)}>
                    <td className="px-4 py-2">
                      <span className="mr-2 text-xs text-muted-foreground">{p.ref}</span>
                      <button type="button" className="font-medium hover:underline" onClick={() => onOpen(p.id)}>
                        {p.title}
                      </button>
                    </td>
                    <td className="px-2 py-2">{status && <StatusChip text={local(status.name, locale)} color={status.color} />}</td>
                    <td className={cn("px-2 py-2", isOverdue(p.dueOn, p.closed) && "font-medium text-destructive")}>{p.dueOn ? dayText(p.dueOn, locale) : "—"}</td>
                    <td className="px-2 py-2">{p.owner?.name ?? "—"}</td>
                    <td className="px-2 py-2 tabular-nums">{t("projects.progress", { done: p.doneTasks, total: p.openTasks + p.doneTasks })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {view !== "tasks" && projects?.length === 0 && (
        <p className="px-4 py-6 text-sm text-muted-foreground">{archived ? t("projects.none_archived") : mayCreate ? t("projects.none") : t("projects.none_cannot_create")}</p>
      )}

      {view === "tasks" && tasks && (
        <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
          {tasks.length === 0 && <p className="text-sm text-muted-foreground">{t("projects.my_tasks_none")}</p>}
          <ul className="space-y-1.5">
            {tasks.map((task) => (
              <li key={task.id}>
                <button type="button" onClick={() => onOpen(task.object.id, task.id)} className="flex w-full flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted/50">
                  <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {task.object.ref} · {task.object.title} · {task.column}
                  </span>
                  {task.dueOn && <span className={cn("text-xs", isOverdue(task.dueOn, task.done) ? "font-medium text-destructive" : "text-muted-foreground")}>{dayText(task.dueOn, locale)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onOpen(id);
        }}
      />
    </div>
  );
}
