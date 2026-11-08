"use client";

// xenaxio step 118, part D: the list of projects — as a board by status, as a
// list, and "my tasks" across all projects. A new project gets the person as
// its owner and the columns "Offen / In Arbeit / Erledigt".
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { Archive, LayoutGrid, LayoutList, CheckSquare, Plus, Trash } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice, TextField } from "@/components/xenaxio/ui";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { useXenaxioMe } from "@/lib/xenaxio/me-store";
import { useViewPrefs } from "@/lib/xenaxio/view-prefs";
import { dayText, type FieldFilter, isOverdue, local, type MyTask, type ObjectSummary, type ObjectType, type Place, type ProjectTemplate, projectsApi, type Visibility } from "@/lib/xenaxio/projects";
import { usePeopleStore } from "@/lib/xenaxio/people";
import { FieldInput, fieldText, PlaceMenu } from "./fields";
import { ImportDialog, exportCsv } from "./import-csv";
import { toast } from "@/stores/toast-store";
import { Board } from "./board";
import { Modal, PeoplePicker, PersonBadge, selectClass, StatusChip } from "./bits";

type View = "board" | "list" | "tasks";
const VIEW_KEY = "xenaxio.projects.view";

interface ListPrefs extends Record<string, unknown> {
  view: View;
  groupBy: string;
  mine: boolean;
  filter: { field: string; value: string } | null;
}

/** Step 125: the person's view of a type's page, the same on every device. */
function parseListPrefs(v: Record<string, unknown>): ListPrefs {
  const view = v.view ?? v.value;
  const f = v.filter as { field?: unknown; value?: unknown } | null | undefined;
  return {
    view: view === "list" || view === "tasks" ? view : "board",
    groupBy: typeof v.groupBy === "string" ? v.groupBy : "",
    mine: v.mine === true,
    filter: f && typeof f.field === "string" && typeof f.value === "string" ? { field: f.field, value: f.value } : null,
  };
}

export function NewProjectDialog({ open, onClose, onCreated, parentId, type }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; parentId?: string | null; type?: ObjectType }) {
  const t = useXT();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("members");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const me = useXenaxioMe();
  const locale = useLocale();
  const typeKey = type?.key ?? "project";
  // Step 124 G: start from a template (only types with a board).
  const withBoard = typeKey === "project" || !!type?.hasTasks;
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [template, setTemplate] = useState("");
  const [removing, setRemoving] = useState<ProjectTemplate | null>(null);
  useEffect(() => {
    if (!open || !withBoard) return;
    projectsApi
      .templates(typeKey)
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]));
  }, [open, withBoard, typeKey]);
  const picked = templates.find((x) => x.id === template);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const fields = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== undefined));
      const created = await projectsApi.create({ type: typeKey, title: title.trim(), ...(description.trim() ? { description } : {}), ...(dueOn ? { dueOn } : {}), visibility, members, ...(parentId ? { parentId } : {}), ...(Object.keys(fields).length ? { fields } : {}), ...(template ? { template } : {}) });
      setTitle("");
      setTemplate("");
      setDescription("");
      setDueOn("");
      setMembers([]);
      setValues({});
      onCreated(created.id);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={parentId ? t("projects.new_sub") : typeKey === "project" ? t("projects.new") : t("objects.new", { name: local(type?.name, locale) })} wide={(type?.fields.length ?? 0) > 0}>
      <form onSubmit={submit} className="space-y-3">
        {error && <Notice kind="error">{error}</Notice>}
        <TextField label={t("projects.field.title")} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        {withBoard && templates.length > 0 && (
          <div className="space-y-1.5 text-sm">
            <label htmlFor="new-template" className="font-medium">
              {t("projects.template")}
            </label>
            <div className="flex gap-2">
              <select id="new-template" className={selectClass} value={template} onChange={(e) => setTemplate(e.target.value)}>
                <option value="">{t("projects.template_none")}</option>
                {templates.some((x) => !x.builtIn) && (
                  <optgroup label={t("projects.template_own")}>
                    {templates
                      .filter((x) => !x.builtIn)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name} · {t("projects.template_tasks", { count: x.tasks })}
                        </option>
                      ))}
                  </optgroup>
                )}
                <optgroup label={t("projects.template_ready")}>
                  {templates
                    .filter((x) => x.builtIn)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} · {t("projects.template_tasks", { count: x.tasks })}
                      </option>
                    ))}
                </optgroup>
              </select>
              {picked?.canDelete && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(picked)} aria-label={t("projects.template_delete")}>
                  <Trash className="h-4 w-4" />
                </Button>
              )}
            </div>
            {picked?.description && <p className="text-xs text-muted-foreground">{picked.description}</p>}
          </div>
        )}
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
        {(type?.fields ?? []).length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {type!.fields
              .filter((f) => f.type !== "external")
              .map((f) => (
                <div key={f.key} className={cn("space-y-1.5 text-sm", (f.type === "textarea" || f.type === "refs" || f.type === "multiselect") && "sm:col-span-2")}>
                  <label htmlFor={`new-${f.key}`} className="font-medium">
                    {local(f.label, locale)}
                    {f.required ? " *" : ""}
                  </label>
                  <FieldInput id={`new-${f.key}`} field={f} value={values[f.key] ?? null} onSave={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
                </div>
              ))}
          </div>
        )}
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
      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        title={t("projects.template_delete")}
        message={t("projects.template_delete_text", { name: removing?.name ?? "" })}
        variant="destructive"
        confirmText={t("projects.template_delete")}
        onConfirm={() => {
          const gone = removing;
          setRemoving(null);
          if (!gone) return;
          projectsApi
            .deleteTemplate(gone.id)
            .then(() => {
              setTemplates((cur) => cur.filter((x) => x.id !== gone.id));
              setTemplate("");
            })
            .catch((err: unknown) => setError(errorText(t, err)));
        }}
      />
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
      {/* Step 119: the first two filled fields of the type (never sensitive ones). */}
      {(type?.fields ?? [])
        .filter((f) => !f.sensitive && !["textarea", "ref", "refs", "external"].includes(f.type) && p.fields?.[f.key] !== undefined && p.fields?.[f.key] !== null)
        .slice(0, 2)
        .map((f) => (
          <p key={f.key} className="mt-0.5 truncate text-xs text-muted-foreground">
            {f.type === "location" ? "📍 " : `${local(f.label, locale)}: `}
            {fieldText(f, p.fields[f.key], locale)}
          </p>
        ))}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {showStatus && status && <StatusChip text={local(status.name, locale)} color={status.color} />}
        {p.dueOn && <span className={cn(isOverdue(p.dueOn, p.closed) && "font-medium text-destructive")}>{dayText(p.dueOn, locale)}</span>}
        {total > 0 && <span>{t("projects.progress", { done: p.doneTasks, total })}</span>}
        <span className="ml-auto">{p.owner && <PersonBadge name={p.owner.name} email={p.owner.email} />}</span>
      </div>
    </button>
  );
}

export function ProjectList({ onOpen, typeKey = "project" }: { onOpen: (id: string, task?: string) => void; typeKey?: string }) {
  const t = useXT();
  const locale = useLocale();
  const [prefs, setPrefs] = useViewPrefs(`objects.${typeKey}`, parseListPrefs, typeKey === "project" ? VIEW_KEY : undefined);
  const view = prefs.view;
  const setView = (v: View) => setPrefs({ view: v });
  const [type, setType] = useState<ObjectType | undefined>();
  const [mayCreate, setMayCreate] = useState(false);
  const [projects, setProjects] = useState<ObjectSummary[] | null>(null);
  const [tasks, setTasks] = useState<MyTask[] | null>(null);
  const mine = prefs.mine;
  const setMine = (v: boolean) => setPrefs({ mine: v });
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Step 119: a filter by one choice field of the type (e.g. source = fair).
  const filter = prefs.filter;
  const setFilter = (v: { field: string; value: string } | null) => setPrefs({ filter: v });
  const people = usePeopleStore((s) => s.people);
  const isProject = typeKey === "project";
  // Lanes by a person field need the company's people.
  useEffect(() => {
    void usePeopleStore.getState().load();
  }, []);

  useEffect(() => {
    projectsApi
      .types()
      .then((r) => {
        const found = r.types.find((x) => x.key === typeKey);
        setType(found);
        setMayCreate(r.create?.[typeKey] ?? (isProject ? r.mayCreate : false));
        if (!found) setError(t("objects.type_missing"));
      })
      .catch((err: unknown) => setError(errorText(t, err)));
  }, [t, typeKey, isProject]);

  const load = useCallback(() => {
    const filters: FieldFilter[] = filter ? [{ field: filter.field, op: "eq", value: filter.value }] : [];
    projectsApi
      .query({ type: typeKey, archived, mine, ...(q.trim() ? { q: q.trim() } : {}), ...(filters.length ? { filters } : {}), limit: 1000 })
      .then((r) => setProjects(r.objects))
      .catch((err: unknown) => setError(errorText(t, err)));
  }, [archived, mine, q, t, typeKey, filter]);
  const choiceFields = useMemo(() => (type?.fields ?? []).filter((f) => (f.type === "select" || f.type === "multiselect") && !f.sensitive), [type]);
  const columns = useMemo(() => (type?.fields ?? []).filter((f) => !f.sensitive && f.type !== "textarea" && f.type !== "external").slice(0, 5), [type]);

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
  // Step 119 (variant B): the board groups by the stage, any choice field or a person field;
  // moving a card changes that value. The choice is kept per type in this browser.
  const groupOptions = useMemo(() => {
    const out: { key: string; label: string }[] = [];
    if (type?.statuses.length) out.push({ key: "status", label: t("projects.field.status") });
    for (const f of type?.fields ?? []) if ((f.type === "select" || f.type === "user") && !f.sensitive) out.push({ key: f.key, label: local(f.label, locale) });
    return out;
  }, [type, locale, t]);
  const groupBy = groupOptions.some((o) => o.key === prefs.groupBy) ? prefs.groupBy : (groupOptions[0]?.key ?? "");
  const setGroupBy = (key: string) => setPrefs({ groupBy: key });
  const groupField = type?.fields.find((f) => f.key === groupBy);
  const NONE = "__none";
  const lanes = useMemo(() => {
    if (groupBy === "status") return (type?.statuses ?? []).map((s) => ({ id: s.key, title: local(s.name, locale), done: s.closed }));
    if (groupField?.type === "select") return [...(groupField.options ?? []).map((o) => ({ id: o.key, title: local(o.label, locale) })), { id: NONE, title: "—" }];
    if (groupField?.type === "user") return [...[...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)).map((p) => ({ id: p.id, title: p.displayName })), { id: NONE, title: "—" }];
    return [];
  }, [groupBy, groupField, type, locale, people]);
  const items = useMemo(
    () =>
      (projects ?? []).map((p) => {
        if (groupBy === "status") return { id: p.id, laneId: p.status ?? NONE };
        const v = p.fields?.[groupBy];
        return { id: p.id, laneId: typeof v === "string" ? v : NONE };
      }),
    [projects, groupBy],
  );
  const boardable = lanes.length > 0;

  const moveProject = async (id: string, lane: string) => {
    const p = byId.get(id);
    if (!p) return;
    if (groupBy === "status") {
      if (p.status === lane) return;
      setProjects((cur) => cur?.map((x) => (x.id === id ? { ...x, status: lane } : x)) ?? cur);
    } else {
      const value = lane === NONE ? null : lane;
      if ((p.fields?.[groupBy] ?? null) === value) return;
      setProjects((cur) => cur?.map((x) => (x.id === id ? { ...x, fields: { ...x.fields, [groupBy]: value } } : x)) ?? cur);
    }
    try {
      await projectsApi.update(id, groupBy === "status" ? { status: lane } : { fields: { [groupBy]: lane === NONE ? null : lane } });
    } catch (err) {
      toast.error(errorText(t, err));
    }
    load();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
        <h1 className="mr-2 text-lg font-semibold">{isProject ? t("projects.title") : local(type?.plural, locale)}</h1>
        <div role="tablist" aria-label={t("projects.views")} className="flex rounded-md border border-border p-0.5">
          {(
            [
              ["board", LayoutGrid, t("projects.view.board")],
              ["list", LayoutList, t("projects.view.list")],
              ["tasks", CheckSquare, t("projects.view.tasks")],
            ] as const
          )
            .filter(([v]) => (isProject || v !== "tasks") && (v !== "board" || boardable))
            .map(([v, Icon, label]) => (
            <button key={v} type="button" role="tab" aria-label={label} aria-selected={view === v} onClick={() => setView(v)} className={cn("flex items-center gap-1.5 rounded px-2 py-1 text-sm", view === v ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
        {view === "board" && groupOptions.length > 1 && (
          <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" aria-label={t("objects.group_by")} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            {groupOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {t("objects.group_by")}: {o.label}
              </option>
            ))}
          </select>
        )}
        {view !== "tasks" && (
          <>
            <Input className="h-9 w-full min-w-0 sm:w-56" value={q} onChange={(e) => setQ(e.target.value)} placeholder={isProject ? t("projects.search") : t("objects.search")} aria-label={isProject ? t("projects.search") : t("objects.search")} />
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
              {t("projects.mine")}
            </label>
            {choiceFields.length > 0 && (
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                aria-label={t("objects.filter_field")}
                value={filter ? `${filter.field}:${filter.value}` : ""}
                onChange={(e) => {
                  const [field, value] = e.target.value.split(":");
                  setFilter(field && value ? { field, value } : null);
                }}
              >
                <option value="">{t("objects.filter_none")}</option>
                {choiceFields.map((f) => (
                  <optgroup key={f.key} label={local(f.label, locale)}>
                    {(f.options ?? []).map((o) => (
                      <option key={o.key} value={`${f.key}:${o.key}`}>
                        {local(o.label, locale)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            <button type="button" onClick={() => setArchived((a) => !a)} aria-pressed={archived} className={cn("flex items-center gap-1 rounded px-2 py-1 text-sm", archived ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              <Archive className="h-4 w-4" />
              {t("projects.archive")}
            </button>
          </>
        )}
        <div className="ml-auto flex gap-2">
          {type && projects && projects.length > 0 && (
            <Button size="sm" variant="ghost" className="hidden sm:inline-flex" onClick={() => exportCsv(type, projects, locale, people)}>
              {t("objects.export")}
            </Button>
          )}
          {mayCreate && type && (
            <Button size="sm" variant="outline" onClick={() => setImporting(true)}>
              {t("objects.import")}
            </Button>
          )}
          {mayCreate && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" />
              {isProject ? t("projects.new") : t("objects.new", { name: local(type?.name, locale) })}
            </Button>
          )}
        </div>
      </header>
      {error && (
        <div className="p-3">
          <Notice kind="error">{error}</Notice>
        </div>
      )}

      {view === "board" && projects && type && boardable && (
        <Board
          label={t("projects.view.board")}
          lanes={lanes}
          items={items}
          emptyText={isProject ? t("projects.lane_empty") : t("objects.lane_empty")}
          disabled={archived}
          onMove={(id, lane) => void moveProject(id, lane)}
          render={(id) => {
            const p = byId.get(id);
            return p ? <ProjectCard p={p} type={type} locale={locale} showStatus={groupBy !== "status"} onOpen={() => onOpen(p.id)} /> : null;
          }}
        />
      )}

      {(view === "list" || (view === "board" && type && !boardable)) && projects && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">{t("projects.field.title")}</th>
                {(type?.statuses.length ?? 1) > 0 && <th className="px-2 py-2 font-medium">{t("projects.field.status")}</th>}
                {columns.map((f) => (
                  <th key={f.key} className="px-2 py-2 font-medium">
                    {local(f.label, locale)}
                  </th>
                ))}
                <th className="px-2 py-2 font-medium">{t("projects.field.due")}</th>
                <th className="px-2 py-2 font-medium">{t("projects.field.owner")}</th>
                {type?.hasTasks && <th className="px-2 py-2 font-medium">{t("projects.field.tasks")}</th>}
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
                    {(type?.statuses.length ?? 1) > 0 && <td className="px-2 py-2">{status && <StatusChip text={local(status.name, locale)} color={status.color} />}</td>}
                    {columns.map((f) => (
                      <td key={f.key} className="px-2 py-2">
                        {f.type === "location" && p.fields?.[f.key] ? <PlaceMenu place={p.fields[f.key] as Place} /> : fieldText(f, p.fields?.[f.key], locale, people) || "—"}
                      </td>
                    ))}
                    <td className={cn("px-2 py-2", isOverdue(p.dueOn, p.closed) && "font-medium text-destructive")}>{p.dueOn ? dayText(p.dueOn, locale) : "—"}</td>
                    <td className="px-2 py-2">{p.owner?.name ?? "—"}</td>
                    {type?.hasTasks && <td className="px-2 py-2 tabular-nums">{t("projects.progress", { done: p.doneTasks, total: p.openTasks + p.doneTasks })}</td>}
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

      {importing && type && (
        <ImportDialog
          type={type}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            load();
          }}
        />
      )}
      <NewProjectDialog
        type={type}
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
