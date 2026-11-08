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
import { CURRENCIES, dayText, local, type ObjectFile, type ObjectSummary, objectFileUrl as objectFileHref, osmHref, type Place, projectsApi, type TypeField, typeHref } from "@/lib/xenaxio/projects";
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
    // Step 127 B, C.
    case "file":
    case "image":
      return Array.isArray(value) && value.length ? `📎 ${value.length}` : "";
    case "location": {
      const p = value as Place;
      return p.address ?? (typeof p.lat === "number" ? `${p.lat}, ${p.lng}` : "");
    }
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
export function FieldInput({ field, value, onSave, disabled, id, objectId }: { field: TypeField; value: unknown; onSave: (v: unknown) => void; disabled?: boolean; id?: string; objectId?: string }) {
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
    case "location":
      return <PlaceInput id={id} value={(value as Place | null) ?? null} onSave={onSave} disabled={disabled} />;
    case "file":
    case "image":
      return objectId ? (
        <FilePicker objectId={objectId} images={field.type === "image"} value={Array.isArray(value) ? (value as string[]) : []} onSave={onSave} disabled={disabled} />
      ) : (
        <span className="text-sm text-muted-foreground">{t("projects.file_field_after")}</span>
      );
    default:
      return <span className="text-sm text-muted-foreground">{String(value ?? "—")}</span>;
  }
}

/** Step 127 C: an address and/or coordinates; "My location" asks the browser (on phones). */
function PlaceInput({ value, onSave, disabled, id }: { value: Place | null; onSave: (v: unknown) => void; disabled?: boolean; id?: string }) {
  const t = useXT();
  const [address, setAddress] = useState(value?.address ?? "");
  const [coords, setCoords] = useState(typeof value?.lat === "number" ? `${value.lat}, ${value.lng}` : "");
  const [error, setError] = useState(false);
  useEffect(() => {
    setAddress(value?.address ?? "");
    setCoords(typeof value?.lat === "number" ? `${value.lat}, ${value.lng}` : "");
  }, [value]);
  const commit = (nextAddress = address, nextCoords = coords) => {
    const m = /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(nextCoords);
    const lat = m ? Number(m[1]!.replace(",", ".")) : null;
    const lng = m ? Number(m[2]!.replace(",", ".")) : null;
    const bad = nextCoords.trim() !== "" && (!m || Math.abs(lat!) > 90 || Math.abs(lng!) > 180);
    setError(bad);
    if (bad) return;
    const next: Place = { ...(nextAddress.trim() ? { address: nextAddress.trim() } : {}), ...(lat !== null && lng !== null ? { lat, lng } : {}) };
    const empty = !next.address && next.lat === undefined;
    if (JSON.stringify(empty ? null : next) !== JSON.stringify(value)) onSave(empty ? null : next);
  };
  const here = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const c = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
        setCoords(c);
        commit(address, c);
      },
      () => setError(true),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };
  const href = value ? osmHref(value) : null;
  return (
    <div className="space-y-1.5">
      <Input id={id} value={address} disabled={disabled} maxLength={300} placeholder={t("projects.place_address")} aria-label={t("projects.place_address")} onChange={(e) => setAddress(e.target.value)} onBlur={() => commit()} />
      <div className="flex gap-2">
        <Input value={coords} disabled={disabled} placeholder="52.520008, 13.404954" aria-label={t("projects.place_coords")} aria-invalid={error} onChange={(e) => setCoords(e.target.value)} onBlur={() => commit()} className={cn(error && "border-destructive")} />
        {!disabled && typeof navigator !== "undefined" && "geolocation" in navigator && (
          <button type="button" onClick={here} className="shrink-0 rounded-md border border-input px-2 text-xs hover:bg-muted">
            {t("projects.place_here")}
          </button>
        )}
      </div>
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">
          {t("projects.place_map")}
        </a>
      )}
    </div>
  );
}

/** Step 127 B: files of the record chosen for a file or image field. */
function FilePicker({ objectId, images, value, onSave, disabled }: { objectId: string; images: boolean; value: string[]; onSave: (v: unknown) => void; disabled?: boolean }) {
  const t = useXT();
  const [files, setFiles] = useState<ObjectFile[]>([]);
  useEffect(() => {
    projectsApi
      .files(objectId)
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, [objectId, value.length]);
  const fitting = files.filter((f) => !images || f.type.startsWith("image/"));
  const chosen = value.map((v) => files.find((f) => f.id === v)).filter((f): f is ObjectFile => !!f);
  return (
    <div className="space-y-1.5">
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {chosen.map((f) => (
            <li key={f.id} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs">
              {images ? <img src={objectFileHref(objectId, f.id)} alt={f.name} className="h-12 w-12 rounded object-cover" loading="lazy" /> : <span className="max-w-40 truncate">{f.name}</span>}
              {!disabled && (
                <button type="button" aria-label={`${t("projects.ref_remove")}: ${f.name}`} onClick={() => onSave(value.filter((v) => v !== f.id).length ? value.filter((v) => v !== f.id) : null)} className="text-muted-foreground hover:text-destructive">
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <select
          className={selectClass}
          value=""
          aria-label={t("projects.file_field_pick")}
          onChange={(e) => e.target.value && onSave([...value, e.target.value])}
        >
          <option value="">{fitting.length ? t("projects.file_field_pick") : t("projects.file_field_none")}</option>
          {fitting
            .filter((f) => !value.includes(f.id))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </select>
      )}
    </div>
  );
}
