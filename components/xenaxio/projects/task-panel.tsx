"use client";

// xenaxio step 118, part C: one task of a project board in a side panel (a
// sheet on the phone): title, column or done, assignee, due date, priority,
// labels, description (Markdown, as the notes of step 115) and comments.
// Someone assigned by another person gets an email from the platform (B1).
// Step 124: the task's number, a checklist, watchers, @mentions and the history.
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Copy, Eye, EyeOff, Trash, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { MarkdownView } from "@/components/xenaxio/markdown-view";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { errorText, XenaxioApiError } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { type ObjectDetail, type Priority, projectsApi, type TaskDetail, type TaskInput } from "@/lib/xenaxio/projects";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";
import { PersonBadge, selectClass } from "./bits";
import { Checklist, CommentBody, History, MentionInput } from "./task-extras";

export function TaskPanel({ project, taskId, onClose, onChanged }: { project: ObjectDetail; taskId: string; onClose: () => void; onChanged: () => void }) {
  const t = useXT();
  const locale = useLocale();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const canEdit = project.can.edit;
  const ref = useFocusTrap({ isActive: true, onEscape: onClose, restoreFocus: true });

  const show = useCallback((d: TaskDetail) => {
    setTask(d);
    setTitle(d.title);
    setDescription(d.description);
    setLabels(d.labels.join(", "));
  }, []);

  useEffect(() => {
    projectsApi
      .task(project.id, taskId)
      .then(show)
      .catch((err: unknown) => {
        if (err instanceof XenaxioApiError && err.status === 404) setMissing(true);
        else toast.error(errorText(t, err));
      });
  }, [project.id, taskId, show, t]);

  const save = async (body: TaskInput) => {
    try {
      await projectsApi.updateTask(project.id, taskId, body);
      show(await projectsApi.task(project.id, taskId));
      onChanged();
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };

  const addComment = async (body: string, mentions: string[]): Promise<boolean> => {
    try {
      show(await projectsApi.comment(project.id, taskId, body, mentions));
      onChanged();
      return true;
    } catch (err) {
      toast.error(errorText(t, err));
      return false;
    }
  };

  const watch = async (watching: boolean) => {
    try {
      show(await projectsApi.watch(project.id, taskId, watching));
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };

  const toTask = async (itemId: string) => {
    try {
      await projectsApi.checklistToTask(project.id, taskId, itemId);
      show(await projectsApi.task(project.id, taskId));
      onChanged();
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };

  const copyRef = (ref: string) => {
    void navigator.clipboard?.writeText(ref).then(
      () => toast.success(t("projects.ref_copied", { ref })),
      () => undefined,
    );
  };

  const columns = project.columns;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} role="dialog" aria-modal="true" aria-label={task?.title ?? t("projects.task")} className="flex h-full w-full max-w-lg flex-col border-l border-border bg-background shadow-xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {task ? (
              <button type="button" className="inline-flex items-center gap-1 font-medium tabular-nums text-foreground hover:underline" onClick={() => copyRef(task.ref)} title={t("projects.copy_ref")}>
                {task.ref}
                <Copy className="h-3 w-3" aria-hidden="true" />
              </button>
            ) : null}
            {task ? " · " : ""}
            {project.title}
          </span>
          {task && (
            <button
              type="button"
              className={cn("flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-muted", task.watching ? "text-primary" : "text-muted-foreground")}
              aria-pressed={task.watching}
              onClick={() => void watch(!task.watching)}
              title={task.watching ? t("projects.watching") : undefined}
            >
              {task.watching ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              <span className="hidden sm:inline">{task.watching ? t("projects.unwatch") : t("projects.watch")}</span>
              {task.watchers.length > 0 && <span className="tabular-nums">{task.watchers.length}</span>}
            </button>
          )}
          {task && canEdit && (
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive" onClick={() => setDeleting(true)} aria-label={t("projects.task_delete")}>
              <Trash className="h-4 w-4" />
            </button>
          )}
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={onClose} aria-label={t("common.close")}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {missing && <p className="p-4 text-sm text-muted-foreground">{t("projects.task_missing")}</p>}
        {!task && !missing && <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>}
        {task && (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1.5 h-4 w-4"
                checked={task.done}
                disabled={!canEdit}
                onChange={(e) => void save({ done: e.target.checked })}
                aria-label={task.done ? t("projects.task_reopen") : t("projects.task_done")}
              />
              <textarea
                className="min-h-10 flex-1 resize-none rounded-md border border-transparent bg-transparent p-1 text-base font-semibold hover:border-input focus:border-input focus:outline-none"
                value={title}
                rows={2}
                disabled={!canEdit}
                maxLength={200}
                aria-label={t("projects.task_title")}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title.trim() && title.trim() !== task.title && void save({ title: title.trim() })}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1 text-sm">
                <span className="text-xs text-muted-foreground">{t("projects.column")}</span>
                <select className={selectClass} value={task.columnId} disabled={!canEdit} onChange={(e) => void save({ columnId: e.target.value })}>
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-sm">
                <span className="text-xs text-muted-foreground">{t("projects.assignee")}</span>
                <select className={selectClass} value={task.assignee?.id ?? ""} disabled={!canEdit} onChange={(e) => void save({ assigneeId: e.target.value || null })}>
                  <option value="">{t("projects.filter_nobody")}</option>
                  {project.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-sm">
                <span className="text-xs text-muted-foreground">{t("projects.field.due")}</span>
                <Input type="date" value={task.dueOn ?? ""} disabled={!canEdit} onChange={(e) => void save({ dueOn: e.target.value || null })} />
              </label>
              <label className="block space-y-1 text-sm">
                <span className="text-xs text-muted-foreground">{t("projects.priority.label")}</span>
                <select className={selectClass} value={task.priority ?? ""} disabled={!canEdit} onChange={(e) => void save({ priority: (e.target.value || null) as Priority | null })}>
                  <option value="">{t("projects.priority.none")}</option>
                  <option value="high">{t("projects.priority.high")}</option>
                  <option value="medium">{t("projects.priority.medium")}</option>
                  <option value="low">{t("projects.priority.low")}</option>
                </select>
              </label>
              <label className="block space-y-1 text-sm sm:col-span-2">
                <span className="text-xs text-muted-foreground">{t("projects.labels")}</span>
                <Input
                  value={labels}
                  disabled={!canEdit}
                  placeholder={t("projects.labels_hint")}
                  onChange={(e) => setLabels(e.target.value)}
                  onBlur={() => {
                    const next = [...new Set(labels.split(",").map((l) => l.trim()).filter(Boolean))].slice(0, 10).map((l) => l.slice(0, 30));
                    if (next.join(",") !== task.labels.join(",")) void save({ labels: next });
                  }}
                />
              </label>
            </div>

            <div className="space-y-1.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("projects.field.description")}</span>
                {canEdit && !editing && (
                  <button type="button" className="text-xs text-primary hover:underline" onClick={() => setEditing(true)}>
                    {t("projects.edit")}
                  </button>
                )}
              </div>
              {editing ? (
                <div className="space-y-2">
                  <textarea className="min-h-32 w-full rounded-md border border-input bg-background p-2 font-mono text-sm" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={20000} aria-label={t("projects.field.description")} autoFocus />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => (setEditing(false), void save({ description }))}>
                      {t("common.save")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setDescription(task.description))}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : task.description ? (
                <MarkdownView source={task.description} className="rounded-md border border-border p-3" />
              ) : (
                <p className="text-muted-foreground">{t("projects.description_none")}</p>
              )}
            </div>

            <Checklist items={task.checklistItems} canEdit={canEdit} onSave={(next) => void save({ checklist: next })} onToTask={(id) => void toTask(id)} />

            <div className="space-y-2 text-sm">
              <span className="text-xs text-muted-foreground">{t("projects.comments")}</span>
              <ul className="space-y-2">
                {task.commentList.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    <PersonBadge name={c.author?.name ?? "?"} email={c.author?.email} />
                    <div className="min-w-0 flex-1 rounded-md bg-muted/60 px-2.5 py-1.5">
                      <p className="text-xs text-muted-foreground">
                        {c.author?.name ?? "—"} · {new Date(c.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
                      </p>
                      <p className="whitespace-pre-wrap break-words">
                        <CommentBody body={c.body} people={project.people} />
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              {canEdit && <MentionInput people={project.people} onSend={addComment} />}
            </div>
            {task.watchers.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("projects.watchers")}: {task.watchers.map((w) => w.name).join(", ")}
              </p>
            )}
            <div className="space-y-2">
              <button type="button" className="text-xs text-primary hover:underline" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
                {t("projects.history")} ({task.history.length})
              </button>
              {showHistory && <History events={task.history} />}
            </div>
            {task.createdBy && (
              <p className="text-xs text-muted-foreground">
                {t("projects.created_by", { name: task.createdBy.name, date: new Date(task.createdAt).toLocaleDateString(locale) })}
              </p>
            )}
          </div>
        )}
      </aside>
      <ConfirmDialog
        isOpen={deleting}
        onClose={() => setDeleting(false)}
        title={t("projects.task_delete")}
        message={t("projects.task_delete_text", { title: task?.title ?? "" })}
        variant="destructive"
        confirmText={t("projects.task_delete")}
        onConfirm={() => {
          setDeleting(false);
          projectsApi
            .deleteTask(project.id, taskId)
            .then(() => {
              onChanged();
              onClose();
            })
            .catch((err: unknown) => toast.error(errorText(t, err)));
        }}
      />
    </div>
  );
}
