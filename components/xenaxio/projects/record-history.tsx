"use client";

// xenaxio step 127 D: the history of a record ("Verlauf") — who changed what and when:
// title, stage, due date, description (without its text), owner, visibility, every
// field (old -> new; sensitive fields only "changed"), people, links, files, archive.
import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { useXT } from "@/lib/xenaxio/i18n";
import { local, type ObjectType, projectsApi, type TypeField } from "@/lib/xenaxio/projects";
import { fieldText } from "./fields";

export interface ObjectEvent {
  id: string;
  author: { id: string; name: string; email: string } | null;
  field: string;
  from: string | null;
  to: string | null;
  detail: string | null;
  masked: boolean;
  createdAt: string;
}

/** One change in words: "changed Stage: Open → Done". */
export function useEventText(type: ObjectType | undefined) {
  const t = useXT();
  const locale = useLocale();
  const fieldOf = (key: string): TypeField | undefined => type?.fields.find((f) => f.key === key);
  const stage = (k: string | null) => (k ? local(type?.statuses.find((s) => s.key === k)?.name, locale) || k : "—");
  const value = (f: TypeField | undefined, v: string | null) => {
    if (v === null) return "—";
    try {
      return f ? fieldText(f, JSON.parse(v), locale) || "—" : v;
    } catch {
      return v;
    }
  };
  return (e: ObjectEvent): string => {
    if (e.field.startsWith("field:")) {
      const f = fieldOf(e.field.slice(6));
      const label = f ? local(f.label, locale) : e.field.slice(6);
      return e.masked ? t("objects.history.masked", { field: label }) : t("objects.history.field", { field: label, from: value(f, e.from), to: value(f, e.to) });
    }
    switch (e.field) {
      case "status":
        return t("objects.history.status", { from: stage(e.from), to: stage(e.to) });
      case "due":
        return t("objects.history.due", { from: e.from ?? "—", to: e.to ?? "—" });
      case "title":
      case "owner":
      case "visibility":
      case "role":
        return t(`objects.history.${e.field}`, { from: e.from ?? "—", to: e.to ?? "—" });
      case "person_add":
        return t("objects.history.person_add", { name: e.to ?? "—" });
      case "person_remove":
        return t("objects.history.person_remove", { name: e.from ?? "—" });
      case "link_add":
      case "link_remove":
      case "file_add":
      case "file_remove":
        return t(`objects.history.${e.field}`, { name: e.detail ?? "" });
      default:
        return t(`objects.history.${e.field}`);
    }
  };
}

export function useRecordHistory(objectId: string, on = true, reloadKey = 0): ObjectEvent[] | null {
  const [events, setEvents] = useState<ObjectEvent[] | null>(null);
  useEffect(() => {
    if (!on) return;
    projectsApi
      .history(objectId)
      .then((r) => setEvents(r.events))
      .catch(() => setEvents([]));
  }, [objectId, on, reloadKey]);
  return events;
}

export function RecordHistory({ objectId, type, reloadKey = 0 }: { objectId: string; type: ObjectType | undefined; reloadKey?: number }) {
  const t = useXT();
  const locale = useLocale();
  const events = useRecordHistory(objectId, true, reloadKey);
  const text = useEventText(type);
  if (!events) return <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("projects.history_none")}</p>
      ) : (
        <ol className="mx-auto max-w-2xl space-y-2 text-sm">
          {[...events].reverse().map((e) => (
            <li key={e.id} className="text-muted-foreground">
              <span className="text-foreground">{e.author?.name ?? "—"}</span> {text(e)}
              <span className="ml-1 text-xs">· {new Date(e.createdAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
