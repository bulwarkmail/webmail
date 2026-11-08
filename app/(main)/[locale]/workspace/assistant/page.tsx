"use client";

// Step 36: "Assistent" — what the assistant remembers about the user.
// Step 91: "Was der Assistent weiß" — facts the assistant keeps itself (about
// the user, their work and the world around it, with source and end date) and
// the company's facts; the user changes and deletes theirs and can switch
// memory off. Nobody else sees the user's facts.
// Step 49: above them, the tasks the assistant carries out on a schedule.
// Step 84: below, the user's own skills and those the company gives them.
import { useCallback, useEffect, useState } from "react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Notice, Spinner } from "@/components/xenaxio/ui";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { ScheduleList } from "@/components/xenaxio/schedule-list";
import { SkillManager } from "@/components/xenaxio/skill-manager";
import { AddFact, FactList } from "@/components/xenaxio/memory-facts";
import { errorText, type MemoryInput, type MemoryNote, type MemoryState, ownSkills, type SkillItem, type SkillSummary, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

function Memory() {
  const t = useXT();
  const [data, setData] = useState<MemoryState | null>(null);
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

  const add = (input: MemoryInput) => run(() => xenaxio.addMemory(input));

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
  const lessons = data.notes.filter((n) => n.kind === "lesson");
  const aboutMe = data.notes.filter((n) => (n.kind ?? "person") === "person" && !n.subject);
  const work = data.notes.filter((n) => !aboutMe.includes(n) && n.kind !== "lesson");
  const save = (note: MemoryNote, input: MemoryInput) => run(() => xenaxio.updateMemory(note.id, input));
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

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">{t("memory.notes", { count: data.notes.length, max: data.maxNotes })}</h2>
          {data.notes.length > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={removeAll}>
              {t("memory.delete_all")}
            </Button>
          )}
        </div>
        {/* Step 91: about the user, about their work and the world around it, the company's. */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("memory.about_me")}</h3>
          <FactList notes={aboutMe} maxLength={data.maxLength} busy={busy} empty={t("memory.none")} onSave={save} onDelete={remove} />
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("memory.work")}</h3>
          <FactList notes={work} maxLength={data.maxLength} busy={busy} empty={t("memory.none_work")} onSave={save} onDelete={remove} />
        </div>
        {/* Step 121: lessons from the user's corrections, with their own switch. */}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t("memory.lessons")}</h3>
          <FactList notes={lessons} maxLength={data.maxLength} busy={busy} empty={t("memory.lessons_none")} onSave={save} onDelete={remove} />
        </div>
        {(data.company?.length ?? 0) > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("memory.company")}</h3>
            <FactList notes={data.company ?? []} maxLength={data.maxLength} busy={busy} empty="" />
            <p className="text-xs text-muted-foreground">{t("memory.company_hint")}</p>
          </div>
        )}
      </section>

      {data.learn !== undefined && (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-labelledby="learn-title">
          <h2 id="learn-title" className="font-medium">{t("memory.learn_title")}</h2>
          <p className="text-sm text-muted-foreground">{data.learn ? t("memory.learn_on") : t("memory.learn_off")}</p>
          <Button variant={data.learn ? "outline" : "default"} disabled={busy} onClick={() => void run(() => xenaxio.setLearning(!data.learn))}>
            {data.learn ? t("memory.learn_switch_off") : t("memory.learn_switch_on")}
          </Button>
        </section>
      )}

      <AddFact maxLength={data.maxLength} busy={busy} full={full} fullText={t("memory.full", { max: data.maxNotes })} hint={t("memory.add_hint", { max: data.maxLength })} onAdd={add} />

      <p className="text-xs text-muted-foreground">{t("memory.privacy")}</p>
    </div>
  );
}

function MySkills() {
  const t = useXT();
  const [data, setData] = useState<{ own: SkillItem[]; company: SkillSummary[]; platform: SkillSummary[]; max: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await xenaxio.mySkills());
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return error ? <Notice kind="error">{error}</Notice> : null;
  const given = [...data.company, ...data.platform.filter((p) => !data.company.some((c) => c.name === p.name))];
  return (
    <section className="space-y-3" aria-labelledby="my-skills-title">
      <div className="space-y-1">
        <h2 id="my-skills-title" className="font-medium">
          {t("skills.my_title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("skills.my_intro")}</p>
      </div>
      <SkillManager api={ownSkills} skills={data.own} max={data.max} onChanged={load} />
      {given.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("skills.given", { count: given.length })}</summary>
          <ul className="mt-2 space-y-1">
            {given.map((k) => (
              <li key={k.name}>
                <span className="font-mono">{k.name}</span>
                <span className="text-muted-foreground"> — {k.description}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">{t("skills.given_hint")}</p>
        </details>
      )}
    </section>
  );
}

export default function AssistantMemoryPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("memory.title")} backHref="/workspace">
      <div className="max-w-2xl space-y-10">
        {/* Step 85: what the assistant may do, per tool. */}
        <Link href="/workspace/permissions" className="block text-sm text-primary underline underline-offset-4">
          {t("permissions.link")}
        </Link>
        {/* Step 49: scheduled tasks of the assistant. */}
        <ScheduleList />
        <Memory />
        <MySkills />
      </div>
    </WorkspaceShell>
  );
}
