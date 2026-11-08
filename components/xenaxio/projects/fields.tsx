"use client";

// xenaxio step 119: fields of object types — showing a value and editing it,
// by kind. The card of a record is drawn from its type (no code per type).
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { X } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { useXT } from "@/lib/xenaxio/i18n";
import { usePeopleStore } from "@/lib/xenaxio/people";
import { CURRENCIES, dayText, local, type ObjectSummary, projectsApi, type TypeField, typeHref } from "@/lib/xenaxio/projects";
import { selectClass } from "./bits";

type Money = { amount: number; currency: string };

/** A value as people read it (lists and cards). */
export function fieldText(field: TypeField, value: unknown, locale: string, people?: Map<string, { displayName: string; id: string }>): string {
  if (value === null || value === undefined || value === "") return "";
  const option = (k: unknown) => local(field.options?.find((o) => o.key === k)?.label, locale) || String(k);
  switch (field.type) {
    case "money": {
      const m = value as Money;
      try {
        return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(m.amount);
      } catch {
        return `${m.amount} ${m.currency}`;
      }
    }
    case "number":
      return new Intl.NumberFormat(locale).format(value as number);
    case "date":
      return dayText(value as string, locale);
    case "select":
      return option(value);
    case "multiselect":
      return (value as string[]).map(option).join(", ");
    case "checkbox":
      return value ? "✓" : "—";
    case "user": {
      const p = people ? [...people.values()].find((x) => x.id === value) : undefined;
      return p?.displayName ?? "…";
    }
    case "ref":
    case "refs":
      return Array.isArray(value) ? `${value.length}` : "1";
    default:
      return String(value);
  }
}

/** Records of a type to pick for a ref field, found by their title. */
function RecordPicker({ type, value, multiple, onChange, disabled }: { type: string; value: string[]; multiple: boolean; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const t = useXT();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ObjectSummary[]>([]);
  const [known, setKnown] = useState<Map<string, ObjectSummary>>(new Map());
  useEffect(() => {
    if (disabled) return;
    const timer = window.setTimeout(() => {
      projectsApi
        .query({ type, ...(q.trim() ? { q: q.trim() } : {}), limit: 20 })
        .then((r) => {
          setFound(r.objects);
          setKnown((cur) => new Map([...cur, ...r.objects.map((o) => [o.id, o] as const)]));
        })
        .catch(() => setFound([]));
    }, q ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [q, type, disabled]);
  // Names of chosen records not in the first page.
  useEffect(() => {
    for (const id of value) {
      if (known.has(id)) continue;
      projectsApi
        .get(id)
        .then((o) => setKnown((cur) => new Map(cur).set(o.id, o)))
        .catch(() => undefined);
    }
  }, [value, known]);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {value.map((id) => {
          const o = known.get(id);
          return (
            <span key={id} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs">
              <Link href={typeHref(type, id)} className="hover:underline">
                {o ? `${o.ref} ${o.title}` : "…"}
              </Link>
              {!disabled && (
                <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} aria-label={t("projects.ref_remove")}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          );
        })}
      </div>
      {!disabled && (multiple || value.length === 0) && (
        <div>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("projects.ref_search")} aria-label={t("projects.ref_search")} className="h-8" />
          {found.filter((o) => !value.includes(o.id)).length > 0 && (
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border text-sm">
              {found
                .filter((o) => !value.includes(o.id))
                .map((o) => (
                  <li key={o.id}>
                    <button type="button" className="block w-full px-2 py-1 text-left hover:bg-muted" onClick={() => (onChange(multiple ? [...value, o.id] : [o.id]), setQ(""))}>
                      <span className="text-xs text-muted-foreground">{o.ref}</span> {o.title}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Edits one field. Text-like fields save when the input loses focus; the
 * others right away. `onSave(null)` clears the value.
 */
export function FieldInput({ field, value, onSave, disabled, id }: { field: TypeField; value: unknown; onSave: (v: unknown) => void; disabled?: boolean; id?: string }) {
  const t = useXT();
  const locale = useLocale();
  const people = usePeopleStore((s) => s.people);
  const load = usePeopleStore((s) => s.load);
  const [draft, setDraft] = useState<string>("");
  useEffect(() => {
    if (field.type === "user") void load();
  }, [field.type, load]);
  useEffect(() => {
    if (field.type === "money") setDraft(value ? String((value as Money).amount) : "");
    else if (field.type === "number") setDraft(value === null || value === undefined ? "" : String(value));
    else if (["text", "textarea", "url", "email", "phone"].includes(field.type)) setDraft((value as string) ?? "");
  }, [field.type, value]);
  const opts = useMemo(() => field.options ?? [], [field.options]);
  const commitText = () => {
    const v = draft.trim();
    if ((v || null) !== ((value as string) ?? null)) onSave(v || null);
  };
  const toNumber = (s: string) => {
    const n = Number(s.replace(/\s/g, "").replace(",", "."));
    return s.trim() === "" ? null : Number.isFinite(n) ? n : undefined;
  };
  switch (field.type) {
    case "textarea":
      return <textarea id={id} className="min-h-20 w-full rounded-md border border-input bg-background p-2 text-sm" value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commitText} />;
    case "text":
    case "url":
    case "email":
    case "phone":
      return (
        <Input
          id={id}
          type={field.type === "url" ? "url" : field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text"}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
        />
      );
    case "number":
      return (
        <Input
          id={id}
          inputMode="decimal"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = toNumber(draft);
            if (n !== undefined && n !== value) onSave(n);
          }}
        />
      );
    case "money": {
      const m = (value as Money | null) ?? null;
      const currency = m?.currency ?? "EUR";
      return (
        <div className="flex gap-1">
          <Input
            id={id}
            inputMode="decimal"
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              const n = toNumber(draft);
              if (n === undefined) return;
              if (n === null) {
                if (m) onSave(null);
              } else if (!m || n !== m.amount) onSave({ amount: n, currency });
            }}
          />
          <select className={cn(selectClass, "w-24")} value={currency} disabled={disabled} aria-label={t("projects.field_currency")} onChange={(e) => onSave({ amount: m?.amount ?? toNumber(draft) ?? 0, currency: e.target.value })}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case "date":
      return <Input id={id} type="date" value={(value as string) ?? ""} disabled={disabled} onChange={(e) => onSave(e.target.value || null)} />;
    case "checkbox":
      return <input id={id} type="checkbox" className="h-4 w-4" checked={!!value} disabled={disabled} onChange={(e) => onSave(e.target.checked)} />;
    case "select":
      return (
        <select id={id} className={selectClass} value={(value as string) ?? ""} disabled={disabled} onChange={(e) => onSave(e.target.value || null)}>
          <option value="">—</option>
          {opts.map((o) => (
            <option key={o.key} value={o.key}>
              {local(o.label, locale)}
            </option>
          ))}
        </select>
      );
    case "multiselect": {
      const list = (value as string[] | null) ?? [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {opts.map((o) => {
            const on = list.includes(o.key);
            return (
              <button
                key={o.key}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => onSave(on ? (list.length > 1 ? list.filter((x) => x !== o.key) : null) : [...list, o.key])}
                className={cn("rounded-full border px-2.5 py-0.5 text-xs", on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground")}
              >
                {local(o.label, locale)}
              </button>
            );
          })}
        </div>
      );
    }
    case "user":
      return (
        <select id={id} className={selectClass} value={(value as string) ?? ""} disabled={disabled} onChange={(e) => onSave(e.target.value || null)}>
          <option value="">—</option>
          {[...people.values()]
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
        </select>
      );
    case "ref":
    case "refs": {
      const ids = value === null || value === undefined ? [] : Array.isArray(value) ? (value as string[]) : [value as string];
      return (
        <RecordPicker
          type={field.ref ?? ""}
          value={ids}
          multiple={field.type === "refs"}
          disabled={disabled}
          onChange={(next) => onSave(field.type === "refs" ? (next.length ? next : null) : (next[0] ?? null))}
        />
      );
    }
    default:
      return <span className="text-sm text-muted-foreground">{String(value ?? "—")}</span>;
  }
}
