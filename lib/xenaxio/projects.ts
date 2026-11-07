// xenaxio step 118: projects (cases of the type "project") with their boards.
// The platform keeps the cases, people, links, columns and tasks; the client
// draws the card from the type's fields, so later case types (industry packs)
// need no code here.
import { apiFetch } from "@/lib/browser-navigation";
import { XenaxioApiError } from "@/lib/xenaxio/api";

// Whole paths, so the Lite build check (scripts/lite/lib.mjs) sees each one.
const OBJECTS = "/api/objects";
const ADMIN_PROJECTS = "/api/admin/projects";

export type Visibility = "members" | "company";
export type Priority = "high" | "medium" | "low";
export type LinkKind = "email" | "file" | "channel" | "event" | "flow_run" | "object";
type Text = { de: string; en: string };

export interface TypeStatus {
  key: string;
  name: Text;
  color: string;
  closed: boolean;
}

export interface ObjectType {
  id: string;
  key: string;
  builtin: boolean;
  name: Text;
  plural: Text;
  prefix: string;
  fields: { key: string; type: string; label: Text; options?: { key: string; label: Text }[] }[];
  statuses: TypeStatus[];
  card: string[];
  parentTypes: string[];
  hasTasks: boolean;
}

export interface PersonRef {
  id: string;
  name: string;
  email: string;
}

export interface ObjectSummary {
  id: string;
  type: string;
  number: number;
  ref: string;
  title: string;
  status: string;
  closed: boolean;
  visibility: Visibility;
  dueOn: string | null;
  owner: PersonRef | null;
  parentId: string | null;
  members: number;
  openTasks: number;
  doneTasks: number;
  myRole: "owner" | "member" | null;
  archivedAt: string | null;
  updatedAt: string;
}

export interface ObjectLink {
  id: string;
  kind: LinkKind;
  ref: string;
  account: string | null;
  title: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface BoardColumn {
  id: string;
  name: string;
  done: boolean;
}

export interface ObjectDetail extends ObjectSummary {
  description: string;
  fields: Record<string, unknown>;
  people: (PersonRef & { role: "owner" | "member" })[];
  links: ObjectLink[];
  columns: BoardColumn[];
  parent: { id: string; ref: string; title: string } | null;
  children: { id: string; ref: string; title: string; type: string; status: string }[];
  createdAt: string;
  can: { edit: boolean; manage: boolean; join: boolean };
}

export interface TaskSummary {
  id: string;
  objectId: string;
  columnId: string;
  title: string;
  assignee: PersonRef | null;
  dueOn: string | null;
  priority: Priority | null;
  labels: string[];
  done: boolean;
  doneAt: string | null;
  hasDescription: boolean;
  comments: number;
  updatedAt: string;
}

export interface TaskDetail extends TaskSummary {
  description: string;
  createdBy: PersonRef | null;
  createdAt: string;
  commentList: { id: string; author: PersonRef | null; body: string; createdAt: string }[];
}

export interface MyTask extends TaskSummary {
  object: { id: string; ref: string; title: string };
  column: string;
}

export interface TaskInput {
  title?: string;
  description?: string;
  columnId?: string;
  assigneeId?: string | null;
  dueOn?: string | null;
  priority?: Priority | null;
  labels?: string[];
  done?: boolean;
}

async function call<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", "x-xenaxio-csrf": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new XenaxioApiError(0, "network");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new XenaxioApiError(
      res.status,
      typeof data.error === "string" ? data.error : "internal",
      data.details as Record<string, unknown> | undefined,
      data.issues as { path: string; message: string }[] | undefined,
    );
  }
  return data as T;
}

const seg = (s: string) => encodeURIComponent(s);
const one = (id: string) => `${OBJECTS}/${seg(id)}`;

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const projectsApi = {
  types: () => call<{ types: ObjectType[]; mayCreate: boolean }>("GET", `${OBJECTS}/types`),
  list: (opts: { type?: string; status?: string; archived?: boolean; q?: string; mine?: boolean } = {}) =>
    call<{ objects: ObjectSummary[] }>("GET", `${OBJECTS}${query({ type: opts.type ?? "project", status: opts.status, archived: opts.archived ? "1" : undefined, q: opts.q, mine: opts.mine ? "1" : undefined })}`),
  linked: (kind: LinkKind, ref: string, account?: string | null) => call<{ objects: ObjectSummary[] }>("GET", `${OBJECTS}/linked${query({ kind, ref, account: account ?? undefined })}`),
  myTasks: (status: "open" | "done" | "all" = "open") => call<{ tasks: MyTask[] }>("GET", `${OBJECTS}/tasks/mine${query({ status })}`),
  create: (body: { type?: string; title: string; description?: string; visibility?: Visibility; dueOn?: string | null; members?: string[]; parentId?: string | null }) =>
    call<ObjectDetail>("POST", OBJECTS, { type: "project", ...body }),
  get: (id: string) => call<ObjectDetail>("GET", one(id)),
  update: (id: string, body: { title?: string; description?: string; visibility?: Visibility; dueOn?: string | null; status?: string; ownerId?: string | null }) =>
    call<ObjectDetail>("PATCH", one(id), body),
  archive: (id: string, archived: boolean) => call<ObjectDetail>("POST", `${one(id)}/archive`, { archived }),
  remove: (id: string) => call<Record<string, never>>("DELETE", one(id)),
  setPerson: (id: string, userId: string, role: "owner" | "member" = "member") => call<ObjectDetail>("PUT", `${one(id)}/people/${seg(userId)}`, { role }),
  removePerson: (id: string, userId: string) => call<ObjectDetail | Record<string, never>>("DELETE", `${one(id)}/people/${seg(userId)}`),
  join: (id: string) => call<ObjectDetail>("POST", `${one(id)}/join`, {}),
  addLink: (id: string, link: { kind: LinkKind; ref: string; account?: string | null; title?: string | null }) => call<ObjectLink>("POST", `${one(id)}/links`, link),
  removeLink: (id: string, linkId: string) => call<Record<string, never>>("DELETE", `${one(id)}/links/${seg(linkId)}`),
  addColumn: (id: string, body: { name: string; done?: boolean; index?: number }) => call<{ columns: BoardColumn[] }>("POST", `${one(id)}/columns`, body),
  updateColumn: (id: string, columnId: string, body: { name?: string; done?: boolean; index?: number }) => call<{ columns: BoardColumn[] }>("PATCH", `${one(id)}/columns/${seg(columnId)}`, body),
  removeColumn: (id: string, columnId: string, moveTo?: string) => call<{ columns: BoardColumn[] }>("DELETE", `${one(id)}/columns/${seg(columnId)}${query({ moveTo })}`),
  tasks: (id: string) => call<{ columns: BoardColumn[]; tasks: TaskSummary[] }>("GET", `${one(id)}/tasks`),
  task: (id: string, taskId: string) => call<TaskDetail>("GET", `${one(id)}/tasks/${seg(taskId)}`),
  createTask: (id: string, body: TaskInput & { title: string; index?: number }) => call<TaskSummary>("POST", `${one(id)}/tasks`, body),
  updateTask: (id: string, taskId: string, body: TaskInput) => call<TaskSummary>("PATCH", `${one(id)}/tasks/${seg(taskId)}`, body),
  moveTask: (id: string, taskId: string, columnId: string, index: number) => call<TaskSummary>("POST", `${one(id)}/tasks/${seg(taskId)}/move`, { columnId, index }),
  deleteTask: (id: string, taskId: string) => call<Record<string, never>>("DELETE", `${one(id)}/tasks/${seg(taskId)}`),
  comment: (id: string, taskId: string, body: string) => call<TaskDetail>("POST", `${one(id)}/tasks/${seg(taskId)}/comments`, { body }),
  creators: () => call<{ creators: "all" | "admins" }>("GET", ADMIN_PROJECTS),
  setCreators: (creators: "all" | "admins") => call<{ creators: "all" | "admins" }>("PUT", ADMIN_PROJECTS, { creators }),
};

/** The text of a type's name or status in the user's language. */
export function local(t: Text | undefined, locale: string): string {
  if (!t) return "";
  return locale.startsWith("de") ? t.de : t.en;
}

/** The project page; the client is a static export, so the project and task go in the query. */
export function projectHref(id?: string | null, taskId?: string | null): string {
  if (!id) return "/projects";
  return `/projects?id=${encodeURIComponent(id)}${taskId ? `&task=${encodeURIComponent(taskId)}` : ""}`;
}

/** Overdue: an open task or project whose due day is before today (local). */
export function isOverdue(dueOn: string | null, done: boolean, today = localToday()): boolean {
  return !done && !!dueOn && dueOn < today;
}

export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A due day as people read it: 20.11.2026 in German, 2026-11-20 otherwise. */
export function dayText(day: string, locale: string): string {
  return locale.startsWith("de") ? day.split("-").reverse().join(".") : day;
}

/** Board filters, also used by the list view and their tests. */
export interface TaskFilter {
  assignee?: string | "none" | null;
  due?: "overdue" | "week" | null;
  label?: string | null;
  text?: string;
}

export function filterTasks<T extends TaskSummary>(tasks: T[], f: TaskFilter, today = localToday()): T[] {
  const words = (f.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const weekEnd = (() => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
    return localToday(d);
  })();
  return tasks.filter((t) => {
    if (f.assignee === "none" && t.assignee) return false;
    if (f.assignee && f.assignee !== "none" && t.assignee?.id !== f.assignee) return false;
    if (f.due === "overdue" && !isOverdue(t.dueOn, t.done, today)) return false;
    if (f.due === "week" && (t.done || !t.dueOn || t.dueOn > weekEnd)) return false;
    if (f.label && !t.labels.includes(f.label)) return false;
    const text = `${t.title} ${t.labels.join(" ")} ${t.assignee?.name ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
