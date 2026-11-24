import type { CalendarRelation, CalendarTask } from "@/lib/jmap/types";

/**
 * The uid of a task's parent task (#1048), from its JSCalendar `relatedTo`.
 * Clients mark a subtask with RELATED-TO;RELTYPE=PARENT (Stalwart:
 * `relation: { parent: true }`). A bare RELATED-TO, as tasks.org writes it,
 * means PARENT too (RFC 5545 3.2.15); Stalwart returns it with no relation.
 */
export function taskParentUid(task: Pick<CalendarTask, "relatedTo" | "uid">): string | null {
  for (const [uid, relation] of Object.entries(task.relatedTo ?? {})) {
    if (!uid || uid === task.uid) continue;
    const kinds = Object.entries(relation?.relation ?? {}).filter(([, on]) => on).map(([kind]) => kind);
    if (kinds.length === 0 || kinds.includes("parent")) return uid;
  }
  return null;
}

/** The `relatedTo` of a new subtask of `parent`. */
export function subtaskRelatedTo(parent: Pick<CalendarTask, "uid">): Record<string, CalendarRelation> {
  return { [parent.uid]: { "@type": "Relation", relation: { parent: true } } };
}

// A uid names a task within one account of one login.
function familyKey(task: Pick<CalendarTask, "localAccountId" | "accountId">, uid: string): string {
  return `${task.localAccountId ?? ""}\u0000${task.accountId ?? ""}\u0000${uid}`;
}

/** The task `task` is a subtask of, among `tasks`, or null. */
export function findParentTask(task: CalendarTask, tasks: CalendarTask[]): CalendarTask | null {
  const uid = taskParentUid(task);
  if (!uid) return null;
  const key = familyKey(task, uid);
  return tasks.find((other) => other !== task && familyKey(other, other.uid) === key) ?? null;
}

export interface NestedTaskRow {
  task: CalendarTask;
  /** 0 for a task shown at the top level, 1 for its subtasks, and so on. */
  depth: number;
  /** The task it is shown under, at depth > 0. */
  parent: CalendarTask | null;
}

/**
 * The list's rows with each subtask right under its parent, siblings in the
 * order `tasks` has them. A subtask whose parent isn't in `tasks` (filtered
 * out, deleted, in another account) is shown at the top level, as is a task
 * in a loop of parents.
 */
export function nestTasks(tasks: CalendarTask[]): NestedTaskRow[] {
  const byUid = new Map<string, CalendarTask>();
  for (const task of tasks) {
    const key = familyKey(task, task.uid);
    if (!byUid.has(key)) byUid.set(key, task);
  }

  const parentOf = new Map<CalendarTask, CalendarTask>();
  for (const task of tasks) {
    const uid = taskParentUid(task);
    const parent = uid ? byUid.get(familyKey(task, uid)) : undefined;
    if (parent && parent !== task) parentOf.set(task, parent);
  }

  // A loop of parents shows its tasks at the top level.
  const inLoop = (task: CalendarTask) => {
    const seen = new Set<CalendarTask>([task]);
    for (let up = parentOf.get(task); up; up = parentOf.get(up)) {
      if (seen.has(up)) return true;
      seen.add(up);
    }
    return false;
  };
  for (const task of [...parentOf.keys()]) {
    if (inLoop(task)) parentOf.delete(task);
  }

  const children = new Map<CalendarTask, CalendarTask[]>();
  for (const task of tasks) {
    const parent = parentOf.get(task);
    if (!parent) continue;
    const list = children.get(parent);
    if (list) list.push(task);
    else children.set(parent, [task]);
  }

  const rows: NestedTaskRow[] = [];
  const emitted = new Set<CalendarTask>();
  const visit = (task: CalendarTask, depth: number, parent: CalendarTask | null) => {
    if (emitted.has(task)) return;
    emitted.add(task);
    rows.push({ task, depth, parent });
    for (const child of children.get(task) ?? []) visit(child, depth + 1, task);
  };
  for (const task of tasks) {
    if (!parentOf.has(task)) visit(task, 0, null);
  }
  return rows;
}
