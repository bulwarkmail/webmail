// xenaxio step 118: projects (cases of the type "project") with their boards.
// The platform keeps the cases, people, links, columns and tasks; the client
// draws the card from the type's fields, so later case types (industry packs)
// need no code here.
import { apiFetch, withBasePath } from "@/lib/browser-navigation";
import { XenaxioApiError } from "@/lib/xenaxio/api";

// Whole paths, so the Lite build check (scripts/lite/lib.mjs) sees each one.
const OBJECTS = "/api/objects";
const ADMIN_PROJECTS = "/api/admin/projects";
// Step 119: the admin's editor of object types and the person's own menu.
const OBJECT_TYPES = "/api/object-types";
const MY_MENU = "/api/me/menu";

export type Visibility = "members" | "company";
export type Priority = "high" | "medium" | "low";
export type LinkKind = "email" | "file" | "channel" | "event" | "flow_run" | "object";
export type Text = { de: string; en: string };

/** Step 119: kinds of fields a company's admin can add to a type. */
export const FIELD_KINDS = ["text", "textarea", "number", "money", "date", "select", "multiselect", "user", "checkbox", "url", "email", "phone", "ref", "refs"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number] | "external";
export const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "PLN", "CZK", "SEK", "DKK", "NOK", "UAH"] as const;
export const STATUS_COLORS = ["blue", "amber", "green", "red", "gray", "violet", "teal", "pink"] as const;

export interface TypeField {
  key: string;
  type: FieldKind;
  label: Text;
  hint?: Text;
  required?: boolean;
  default?: unknown;
  options?: { key: string; label: Text }[];
  ref?: string;
  sensitive?: boolean;
}

export interface TypeAccess {
  read?: "members" | "all" | "groups";
  readGroups?: string[];
  create?: "all" | "groups" | "admins";
  createGroups?: string[];
}

export interface TypeMenu {
  show?: boolean;
  icon?: string;
  order?: number;
  groups?: string[];
}

export interface MenuItem {
  key: string;
  name: Text;
  plural: Text;
  icon: string;
  href: string;
  hidden: boolean;
}

export interface FieldFilter {
  field: string;
  op: "eq" | "in" | "contains" | "gte" | "lte" | "empty" | "set";
  value?: unknown;
}

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
  fields: TypeField[];
  statuses: TypeStatus[];
  card: string[];
  parentTypes: string[];
  hasTasks: boolean;
  /** Step 119: comments on records of this type. */
  comments: boolean;
  /** Step 127: files attached to records of this type. */
  attachments: boolean;
  access: TypeAccess;
  menu: TypeMenu;
  archivedAt: string | null;
  /** Admin list only: how many records the type has. */
  records?: number;
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
  /** Step 119: values of the type's fields (never sensitive ones). */
  fields: Record<string, unknown>;
}

export interface ObjectLink {
  id: string;
  /** Step 124 B: set when the link belongs to a task. */
  taskId?: string | null;
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
  backrefs: { type: string; field: string; records: { id: string; ref: string; title: string; status: string }[] }[];
  createdAt: string;
  can: { edit: boolean; manage: boolean; join: boolean };
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/** Step 124 F: one line of a task's history (never texts of descriptions or comments). */
export interface TaskEvent {
  id: string;
  author: PersonRef | null;
  field: "created" | "title" | "column" | "assignee" | "due" | "priority" | "labels" | "done" | "checklist";
  from: string | null;
  to: string | null;
  createdAt: string;
}

export interface TaskSummary {
  id: string;
  objectId: string;
  columnId: string;
  /** Step 124 D: number in the project and the reference "P-12-7". */
  number: number;
  ref: string;
  title: string;
  assignee: PersonRef | null;
  dueOn: string | null;
  priority: Priority | null;
  labels: string[];
  done: boolean;
  doneAt: string | null;
  hasDescription: boolean;
  comments: number;
  /** Step 124 A: ticked and all checklist items. */
  checklist: { done: number; total: number };
  /** Step 124 B: files and links of the task. */
  attachments: number;
  updatedAt: string;
}

/** Step 127 A, 124 B: a file attached to a record or a task. */
export interface ObjectFile {
  id: string;
  taskId: string | null;
  name: string;
  type: string;
  size: number;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  can: { delete: boolean };
}

export interface TaskDetail extends TaskSummary {
  description: string;
  createdBy: PersonRef | null;
  createdAt: string;
  commentList: { id: string; author: PersonRef | null; body: string; createdAt: string }[];
  checklistItems: ChecklistItem[];
  history: TaskEvent[];
  /** Step 124 B: emails and files from Files linked to the task. */
  links: ObjectLink[];
  /** Step 124 C. */
  watchers: PersonRef[];
  watching: boolean;
}

/** Step 124 H: a task of the parent or a sub-project on the parent's board. */
export interface RollupTask extends TaskSummary {
  project: { id: string; ref: string; title: string };
  column: string;
  columnDone: boolean;
}

export interface RollupProject {
  id: string;
  ref: string;
  title: string;
  depth: number;
  columns: BoardColumn[];
}

/** Step 124 G: a ready-made or company template. */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string | null;
  builtIn: boolean;
  type: string;
  columns: number;
  tasks: number;
  createdBy: string | null;
  canDelete: boolean;
}

export interface ObjectComment {
  id: string;
  author: PersonRef | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  can: { edit: boolean; delete: boolean };
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
  checklist?: { id?: string; text: string; done?: boolean }[];
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
  types: () => call<{ types: ObjectType[]; mayCreate: boolean; create: Record<string, boolean> }>("GET", `${OBJECTS}/types`),
  // Step 119: lists filtered and sorted by fields, imports, the person's menu.
  query: (body: { type: string; status?: string; archived?: boolean; q?: string; mine?: boolean; filters?: FieldFilter[]; sort?: { field: string; dir: "asc" | "desc" }; limit?: number }) =>
    call<{ objects: ObjectSummary[] }>("POST", `${OBJECTS}/query`, body),
  importRows: (type: string, rows: { title: string; status?: string; dueOn?: string | null; fields?: Record<string, unknown> }[]) =>
    call<{ added: number; skipped: { row: number; error: string; field?: string }[] }>("POST", `${OBJECTS}/import`, { type, rows }),
  menu: () => call<{ items: MenuItem[] }>("GET", `${OBJECTS}/menu`),
  setMenu: (prefs: { order?: string[]; hidden?: string[] }) => call<{ items: MenuItem[] }>("PUT", MY_MENU, prefs),
  list: (opts: { type?: string; status?: string; archived?: boolean; q?: string; mine?: boolean } = {}) =>
    call<{ objects: ObjectSummary[] }>("GET", `${OBJECTS}${query({ type: opts.type ?? "project", status: opts.status, archived: opts.archived ? "1" : undefined, q: opts.q, mine: opts.mine ? "1" : undefined })}`),
  linked: (kind: LinkKind, ref: string, account?: string | null) => call<{ objects: ObjectSummary[] }>("GET", `${OBJECTS}/linked${query({ kind, ref, account: account ?? undefined })}`),
  myTasks: (status: "open" | "done" | "all" = "open") => call<{ tasks: MyTask[] }>("GET", `${OBJECTS}/tasks/mine${query({ status })}`),
  // Step 124: a task by its reference, the person's tasks with a due date (calendar), templates.
  taskByRef: (ref: string) => call<{ objectId: string; taskId: string }>("GET", `${OBJECTS}/tasks/ref/${seg(ref)}`),
  calendarTasks: (from: string, to: string) => call<{ tasks: MyTask[] }>("GET", `${OBJECTS}/tasks/calendar${query({ from, to })}`),
  templates: (type = "project") => call<{ templates: ProjectTemplate[] }>("GET", `${OBJECTS}/templates${query({ type })}`),
  saveTemplate: (id: string, name: string) => call<ProjectTemplate>("POST", `${one(id)}/template`, { name }),
  deleteTemplate: (templateId: string) => call<Record<string, never>>("DELETE", `${OBJECTS}/templates/${seg(templateId)}`),
  create: (body: { type?: string; title: string; description?: string; visibility?: Visibility; dueOn?: string | null; members?: string[]; parentId?: string | null; status?: string; fields?: Record<string, unknown>; template?: string }) =>
    call<ObjectDetail>("POST", OBJECTS, { type: "project", ...body }),
  get: (id: string) => call<ObjectDetail>("GET", one(id)),
  update: (id: string, body: { title?: string; description?: string; visibility?: Visibility; dueOn?: string | null; status?: string; ownerId?: string | null; fields?: Record<string, unknown> }) =>
    call<ObjectDetail>("PATCH", one(id), body),
  archive: (id: string, archived: boolean) => call<ObjectDetail>("POST", `${one(id)}/archive`, { archived }),
  remove: (id: string) => call<Record<string, never>>("DELETE", one(id)),
  setPerson: (id: string, userId: string, role: "owner" | "member" = "member") => call<ObjectDetail>("PUT", `${one(id)}/people/${seg(userId)}`, { role }),
  removePerson: (id: string, userId: string) => call<ObjectDetail | Record<string, never>>("DELETE", `${one(id)}/people/${seg(userId)}`),
  join: (id: string) => call<ObjectDetail>("POST", `${one(id)}/join`, {}),
  // Step 127 A, 124 B: files of a record or a task.
  files: (id: string, taskId?: string | null) => call<{ files: ObjectFile[] }>("GET", `${one(id)}/files${query({ taskId: taskId ?? undefined })}`),
  deleteFile: (id: string, fileId: string) => call<Record<string, never>>("DELETE", `${one(id)}/files/${seg(fileId)}`),
  addLink: (id: string, link: { kind: LinkKind; ref: string; account?: string | null; title?: string | null; taskId?: string | null }) => call<ObjectLink>("POST", `${one(id)}/links`, link),
  removeLink: (id: string, linkId: string) => call<Record<string, never>>("DELETE", `${one(id)}/links/${seg(linkId)}`),
  addColumn: (id: string, body: { name: string; done?: boolean; index?: number }) => call<{ columns: BoardColumn[] }>("POST", `${one(id)}/columns`, body),
  updateColumn: (id: string, columnId: string, body: { name?: string; done?: boolean; index?: number }) => call<{ columns: BoardColumn[] }>("PATCH", `${one(id)}/columns/${seg(columnId)}`, body),
  removeColumn: (id: string, columnId: string, moveTo?: string) => call<{ columns: BoardColumn[] }>("DELETE", `${one(id)}/columns/${seg(columnId)}${query({ moveTo })}`),
  tasks: (id: string) => call<{ columns: BoardColumn[]; tasks: TaskSummary[] }>("GET", `${one(id)}/tasks`),
  rollup: (id: string) => call<{ projects: RollupProject[]; tasks: RollupTask[] }>("GET", `${one(id)}/tasks${query({ subprojects: "1" })}`),
  task: (id: string, taskId: string) => call<TaskDetail>("GET", `${one(id)}/tasks/${seg(taskId)}`),
  createTask: (id: string, body: TaskInput & { title: string; index?: number }) => call<TaskSummary>("POST", `${one(id)}/tasks`, body),
  updateTask: (id: string, taskId: string, body: TaskInput) => call<TaskSummary>("PATCH", `${one(id)}/tasks/${seg(taskId)}`, body),
  moveTask: (id: string, taskId: string, columnId: string, index: number) => call<TaskSummary>("POST", `${one(id)}/tasks/${seg(taskId)}/move`, { columnId, index }),
  deleteTask: (id: string, taskId: string) => call<Record<string, never>>("DELETE", `${one(id)}/tasks/${seg(taskId)}`),
  comment: (id: string, taskId: string, body: string, mentions: string[] = []) => call<TaskDetail>("POST", `${one(id)}/tasks/${seg(taskId)}/comments`, { body, ...(mentions.length ? { mentions } : {}) }),
  watch: (id: string, taskId: string, watching: boolean) => call<TaskDetail>("PUT", `${one(id)}/tasks/${seg(taskId)}/watch`, { watching }),
  checklistToTask: (id: string, taskId: string, itemId: string) => call<TaskSummary>("POST", `${one(id)}/tasks/${seg(taskId)}/checklist/${seg(itemId)}/task`, {}),
  // Step 119: comments on the record itself.
  comments: (id: string) => call<{ comments: ObjectComment[] }>("GET", `${one(id)}/comments`),
  addComment: (id: string, body: string) => call<{ comments: ObjectComment[] }>("POST", `${one(id)}/comments`, { body }),
  editComment: (id: string, commentId: string, body: string) => call<{ comments: ObjectComment[] }>("PATCH", `${one(id)}/comments/${seg(commentId)}`, { body }),
  deleteComment: (id: string, commentId: string) => call<{ comments: ObjectComment[] }>("DELETE", `${one(id)}/comments/${seg(commentId)}`),
  creators: () => call<{ creators: "all" | "admins" }>("GET", ADMIN_PROJECTS),
  // Step 119: the admin's editor of object types.
  adminTypes: () => call<{ types: ObjectType[] }>("GET", OBJECT_TYPES),
  createType: (body: { name: Text; plural: Text; prefix?: string; hasTasks?: boolean; menu?: TypeMenu; access?: TypeAccess }) => call<ObjectType>("POST", OBJECT_TYPES, body),
  updateType: (key: string, body: { name?: Text; plural?: Text; prefix?: string; hasTasks?: boolean; comments?: boolean; attachments?: boolean; parentTypes?: string[]; card?: string[]; menu?: TypeMenu; access?: TypeAccess }) =>
    call<ObjectType>("PATCH", `${OBJECT_TYPES}/${seg(key)}`, body),
  archiveType: (key: string, archived: boolean) => call<ObjectType>("POST", `${OBJECT_TYPES}/${seg(key)}/archive`, { archived }),
  removeType: (key: string) => call<Record<string, never>>("DELETE", `${OBJECT_TYPES}/${seg(key)}`),
  addField: (key: string, field: TypeField) => call<ObjectType>("POST", `${OBJECT_TYPES}/${seg(key)}/fields`, field),
  updateField: (key: string, field: TypeField) => call<{ type: ObjectType; affected: number }>("PUT", `${OBJECT_TYPES}/${seg(key)}/fields/${seg(field.key)}`, field),
  removeField: (key: string, field: string) => call<{ type: ObjectType; affected: number }>("DELETE", `${OBJECT_TYPES}/${seg(key)}/fields/${seg(field)}`),
  fieldUsage: (key: string, field: string, option?: string) => call<{ records: number }>("GET", `${OBJECT_TYPES}/${seg(key)}/fields/${seg(field)}/usage${query({ option })}`),
  reorderFields: (key: string, order: string[]) => call<ObjectType>("PUT", `${OBJECT_TYPES}/${seg(key)}/fields-order`, { order }),
  setStatuses: (key: string, statuses: TypeStatus[], moveTo?: Record<string, string>) => call<ObjectType>("PUT", `${OBJECT_TYPES}/${seg(key)}/statuses`, { statuses, ...(moveTo ? { moveTo } : {}) }),
  setCreators: (creators: "all" | "admins") => call<{ creators: "all" | "admins" }>("PUT", ADMIN_PROJECTS, { creators }),
};

/** The text of a type's name or status in the user's language. */
export function local(t: Text | undefined, locale: string): string {
  if (!t) return "";
  return locale.startsWith("de") ? t.de : t.en;
}

/** Step 119: the page of a type's records (projects keep their own page). */
export function typeHref(type: string, id?: string | null): string {
  if (type === "project") return projectHref(id);
  return `/objects?type=${encodeURIComponent(type)}${id ? `&id=${encodeURIComponent(id)}` : ""}`;
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

/** Step 127 A: where a file of a record is downloaded (inline: pictures and PDFs open in the browser). */
export function objectFileUrl(objectId: string, fileId: string, inline = false): string {
  return withBasePath(`${OBJECTS}/${encodeURIComponent(objectId)}/files/${encodeURIComponent(fileId)}${inline ? "?inline=1" : ""}`);
}

/** Uploads one file (raw body; its name and task in the query). */
export async function uploadObjectFile(objectId: string, file: File, taskId?: string | null): Promise<ObjectFile> {
  const q = new URLSearchParams({ name: file.name || "file" });
  if (taskId) q.set("taskId", taskId);
  let res: Response;
  try {
    res = await apiFetch(`${OBJECTS}/${encodeURIComponent(objectId)}/files?${q}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "x-xenaxio-csrf": "1", "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
  } catch {
    throw new XenaxioApiError(0, "network");
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new XenaxioApiError(res.status, typeof data.error === "string" ? data.error : res.status === 413 ? "object_file_too_large" : "internal");
  return data as unknown as ObjectFile;
}
