"use client";

// xenaxio step 119: comments on a record, where its type has them (the admin
// turns them on per type). Everyone who sees the record writes; the author
// edits and deletes their own, the record's owners and admins delete any.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorText } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { type ObjectComment, projectsApi } from "@/lib/xenaxio/projects";
import { toast } from "@/stores/toast-store";
import { PersonBadge } from "./bits";

export function RecordComments({ objectId, archived }: { objectId: string; archived: boolean }) {
  const t = useXT();
  const locale = useLocale();
  const [list, setList] = useState<ObjectComment[] | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  const run = useCallback(
    async (fn: () => Promise<{ comments: ObjectComment[] }>) => {
      try {
        setList((await fn()).comments);
        return true;
      } catch (err) {
        toast.error(errorText(t, err));
        return false;
      }
    },
    [t],
  );
  useEffect(() => {
    void run(() => projectsApi.comments(objectId));
  }, [objectId, run]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && (await run(() => projectsApi.addComment(objectId, text.trim())))) setText("");
  };

  if (!list) return null;
  return (
    <div className="space-y-2 text-sm sm:col-span-2">
      <span className="text-xs text-muted-foreground">{t("projects.comments")}</span>
      {list.length === 0 && <p className="text-muted-foreground">{t("objects.comments_none")}</p>}
      <ul className="space-y-2">
        {list.map((c) => (
          <li key={c.id} className="flex gap-2">
            <PersonBadge name={c.author?.name ?? "?"} email={c.author?.email} />
            <div className="min-w-0 flex-1 rounded-md bg-muted/60 px-2.5 py-1.5">
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>
                  {c.author?.name ?? "—"} · {new Date(c.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}
                  {c.editedAt ? ` · ${t("objects.comment_edited")}` : ""}
                </span>
                {c.can.edit && editing?.id !== c.id && (
                  <button type="button" className="text-primary hover:underline" onClick={() => setEditing({ id: c.id, body: c.body })}>
                    {t("projects.edit")}
                  </button>
                )}
                {c.can.delete && (
                  <button type="button" className="text-destructive hover:underline" onClick={() => void run(() => projectsApi.deleteComment(objectId, c.id))}>
                    {t("typeeditor.remove")}
                  </button>
                )}
              </p>
              {editing?.id === c.id ? (
                <form
                  className="mt-1 flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(() => projectsApi.editComment(objectId, c.id, editing.body.trim()))) setEditing(null);
                  }}
                >
                  <Input value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} maxLength={4000} aria-label={t("projects.edit")} autoFocus />
                  <Button type="submit" size="sm" disabled={!editing.body.trim()}>
                    {t("common.save")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    {t("common.cancel")}
                  </Button>
                </form>
              ) : (
                <p className="whitespace-pre-wrap break-words">{c.body}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!archived && (
        <form onSubmit={add} className="flex gap-2">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("projects.comment_add")} aria-label={t("projects.comment_add")} maxLength={4000} />
          <Button type="submit" size="sm" disabled={!text.trim()}>
            {t("projects.comment_send")}
          </Button>
        </form>
      )}
    </div>
  );
}
