"use client";

// xenaxio step 119: import records of a type from a CSV file (Excel saves it
// with "Speichern unter → CSV"), and export the list shown as CSV. Columns are
// matched with the type's fields by name; each row is checked by the platform
// like a new record, and rows with mistakes are reported with their number.
import { useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/xenaxio/ui";
import { errorText } from "@/lib/xenaxio/api";
import { csvDate, csvValue, parseCsv, toCsv } from "@/lib/xenaxio/csv";
import { useXT } from "@/lib/xenaxio/i18n";
import { usePeopleStore } from "@/lib/xenaxio/people";
import { local, type ObjectSummary, type ObjectType, projectsApi } from "@/lib/xenaxio/projects";
import { Modal, selectClass } from "./bits";
import { fieldText } from "./fields";

const MAX_ROWS = 5000;

export function exportCsv(type: ObjectType, records: ObjectSummary[], locale: string, people: Map<string, { id: string; displayName: string }>): void {
  const fields = type.fields.filter((f) => !f.sensitive && f.type !== "external");
  const head = ["Nr.", "Titel", "Status", "Fällig", ...fields.map((f) => local(f.label, locale))];
  const rows = records.map((r) => [
    r.ref,
    r.title,
    local(type.statuses.find((s) => s.key === r.status)?.name, locale) || r.status,
    r.dueOn ?? "",
    ...fields.map((f) => fieldText(f, r.fields?.[f.key], locale, people)),
  ]);
  const blob = new Blob([toCsv([head, ...rows])], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${local(type.plural, locale) || type.key}.csv`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function ImportDialog({ type, onClose, onDone }: { type: ObjectType; onClose: () => void; onDone: () => void }) {
  const t = useXT();
  const locale = useLocale();
  const people = usePeopleStore((s) => s.people);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [map, setMap] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: number; skipped: { row: number; error: string; field?: string }[] } | null>(null);
  const targets = useMemo(
    () => [
      { key: "title", label: t("projects.field.title") },
      { key: "status", label: t("projects.field.status") },
      { key: "due", label: t("projects.field.due") },
      ...type.fields.filter((f) => f.type !== "ref" && f.type !== "refs" && f.type !== "external").map((f) => ({ key: f.key, label: local(f.label, locale) })),
    ],
    [type, locale, t],
  );

  const read = async (file: File) => {
    setError(null);
    setResult(null);
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) return setError(t("objects.import_empty"));
    if (parsed.length - 1 > MAX_ROWS) return setError(t("objects.import_too_many", { limit: MAX_ROWS }));
    setRows(parsed);
    // Columns matched by their heading: the field's name in either language, or its key.
    const auto: Record<number, string> = {};
    parsed[0]!.forEach((h, i) => {
      const name = h.trim().toLowerCase();
      const hit = targets.find((x) => x.label.toLowerCase() === name || x.key === name) ?? (["titel", "title", "name"].includes(name) ? targets[0] : undefined);
      if (hit && !Object.values(auto).includes(hit.key)) auto[i] = hit.key;
    });
    setMap(auto);
  };

  const run = async () => {
    if (!rows) return;
    if (!Object.values(map).includes("title")) return setError(t("objects.import_need_title"));
    setBusy(true);
    setError(null);
    const list = [...people.values()].map((p) => ({ id: p.id, email: p.email, displayName: p.displayName }));
    const invalid: { row: number; error: string; field?: string }[] = [];
    const out: { title: string; status?: string; dueOn?: string | null; fields: Record<string, unknown> }[] = [];
    const sent: number[] = [];
    rows.slice(1).forEach((cells, i) => {
      const rec: { title: string; status?: string; dueOn?: string | null; fields: Record<string, unknown> } = { title: "", fields: {} };
      let bad: { error: string; field?: string } | null = null;
      for (const [col, key] of Object.entries(map)) {
        const cell = cells[Number(col)] ?? "";
        if (key === "title") rec.title = cell.trim();
        else if (key === "status") {
          const st = type.statuses.find((s) => [s.key, s.name.de, s.name.en].some((n) => n.toLowerCase() === cell.trim().toLowerCase()));
          if (cell.trim() && !st) bad = { error: "object_status_unknown" };
          else if (st) rec.status = st.key;
        } else if (key === "due") {
          const d = cell.trim() ? csvDate(cell) : null;
          if (d === undefined) bad = { error: "object_field_invalid", field: "due" };
          else rec.dueOn = d;
        } else {
          const field = type.fields.find((f) => f.key === key)!;
          const v = csvValue(field, cell, list);
          if (v === undefined) bad = { error: "object_field_invalid", field: key };
          else if (v !== null) rec.fields[key] = v;
        }
      }
      if (bad) invalid.push({ row: i + 1, ...bad });
      else {
        out.push(rec);
        sent.push(i + 1);
      }
    });
    try {
      const r = out.length ? await projectsApi.importRows(type.key, out) : { added: 0, skipped: [] };
      // The platform numbers the rows it got; back to the file's row numbers.
      const skipped = [...invalid, ...r.skipped.map((x) => ({ ...x, row: sent[x.row - 1] ?? x.row }))].sort((a, b) => a.row - b.row);
      setResult({ added: r.added, skipped });
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const fieldName = (key?: string) => (key ? (targets.find((x) => x.key === key)?.label ?? key) : "");

  return (
    <Modal open onClose={result ? onDone : onClose} title={t("objects.import_title", { name: local(type.plural, locale) })} wide>
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t("objects.import_intro")}</p>
        {error && <Notice kind="error">{error}</Notice>}
        {!result && <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void read(e.target.files[0])} aria-label={t("objects.import_file")} />}
        {rows && !result && (
          <>
            <p>{t("objects.import_rows", { n: rows.length - 1 })}</p>
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {rows[0]!.map((h, i) => (
                <label key={i} className="grid grid-cols-2 items-center gap-2">
                  <span className="truncate" title={h}>
                    {h || `#${i + 1}`} <span className="text-xs text-muted-foreground">{rows[1]?.[i] ? `· ${rows[1][i]}` : ""}</span>
                  </span>
                  <select className={selectClass} value={map[i] ?? ""} onChange={(e) => setMap((m) => ({ ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== e.target.value)), [i]: e.target.value }))}>
                    <option value="">{t("objects.import_skip")}</option>
                    {targets.map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void run()} disabled={busy}>
                {t("objects.import_run")}
              </Button>
            </div>
          </>
        )}
        {result && (
          <>
            <Notice kind={result.skipped.length ? "info" : "success"}>{t("objects.import_result", { added: result.added, skipped: result.skipped.length })}</Notice>
            {result.skipped.length > 0 && (
              <ul className="max-h-60 overflow-y-auto rounded-md border border-border text-xs">
                {result.skipped.map((x) => (
                  <li key={x.row} className="border-b border-border px-2 py-1 last:border-0">
                    {t("objects.import_row", { n: x.row })}: {t(`errors.${x.error}`)}
                    {x.field ? ` (${fieldName(x.field === "due" ? "due" : x.field)})` : ""}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <Button onClick={onDone}>{t("common.close")}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
