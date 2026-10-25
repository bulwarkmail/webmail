"use client";

// Step 35: "Assistent" — what the assistant remembers about the user. Every
// note was confirmed by the user in the panel or written here; the user edits
// and deletes them and can switch memory off. Nobody else sees these notes.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice, Spinner } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorText, type MemoryNote, type MemoryState, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

function NoteRow({ note, maxLength, busy, onSave, onDelete }: { note: MemoryNote; maxLength: number; busy: boolean; onSave: (text: string) => Promise<boolean>; onDelete: () => void }) {
  const t = useXT();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const date = new Date(note.updatedAt).toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await onSave(text)) setEditing(false);
  };

  if (editing) {
    return (
      <li className="px-4 py-3">
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <Input className="min-w-0 flex-1" value={text} maxLength={maxLength} onChange={(e) => setText(e.target.value)} aria-label={t("memory.edit")} autoFocus />
          <Button size="sm" type="submit" disabled={busy || !text.trim()}>
            {t("memory.save")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() => {
              setText(note.text);
              setEditing(false);
            }}
          >
            {t("common.cancel")}
          </Button>
        </form>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block break-words">{note.text}</span>
        <span className="block text-xs text-muted-foreground">{t("memory.since", { date })}</span>
      </span>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
        {t("memory.edit")}
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onDelete}>
        {t("memory.delete")}
      </Button>
    </li>
  );
}

function Memory() {
  const t = useXT();
  const [data, setData] = useState<MemoryState | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await xenaxio.memories());
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs a change and reloads; false when it failed (the error is shown). */
  const run = async (change: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await change();
      await load();
      return true;
    } catch (err) {
      setError(errorText(t, err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => xenaxio.addMemory(text.trim()))) setText("");
  };

  const remove = (note: MemoryNote) => {
    if (!window.confirm(t("memory.delete_confirm", { text: note.text }))) return;
    void run(() => xenaxio.deleteMemory(note.id));
  };

  const removeAll = () => {
    if (!window.confirm(t("memory.delete_all_confirm"))) return;
    void run(() => xenaxio.deleteAllMemories());
  };

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t("common.loading")} />;

  const full = data.notes.length >= data.maxNotes;
  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-muted-foreground">{t("memory.intro")}</p>
      {error && <Notice kind="error">{error}</Notice>}

      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">{t("memory.switch_title")}</h2>
        <p className="text-sm text-muted-foreground">{data.enabled ? t("memory.on") : t("memory.off")}</p>
        <Button variant={data.enabled ? "outline" : "default"} disabled={busy} onClick={() => void run(() => xenaxio.setMemoryEnabled(!data.enabled))}>
          {data.enabled ? t("memory.switch_off") : t("memory.switch_on")}
        </Button>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">{t("memory.notes", { count: data.notes.length, max: data.maxNotes })}</h2>
          {data.notes.length > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={removeAll}>
              {t("memory.delete_all")}
            </Button>
          )}
        </div>
        {data.notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("memory.none")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.notes.map((note) => (
              <NoteRow key={note.id} note={note} maxLength={data.maxLength} busy={busy} onSave={(next) => run(() => xenaxio.updateMemory(note.id, next.trim()))} onDelete={() => remove(note)} />
            ))}
          </ul>
        )}
      </section>

      <form onSubmit={add} className="space-y-2">
        <label htmlFor="memory-new" className="text-sm font-medium">
          {t("memory.add")}
        </label>
        <div className="flex flex-wrap gap-2">
          <Input id="memory-new" className="min-w-0 flex-1" value={text} maxLength={data.maxLength} placeholder={t("memory.add_placeholder")} onChange={(e) => setText(e.target.value)} disabled={full} />
          <Button type="submit" disabled={busy || full || !text.trim()}>
            {t("memory.add_button")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{full ? t("memory.full", { max: data.maxNotes }) : t("memory.add_hint", { max: data.maxLength })}</p>
      </form>

      <p className="text-xs text-muted-foreground">{t("memory.privacy")}</p>
    </div>
  );
}

export default function AssistantMemoryPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("memory.title")} backHref="/workspace">
      <Memory />
    </WorkspaceShell>
  );
}
