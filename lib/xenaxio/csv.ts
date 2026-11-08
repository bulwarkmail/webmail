// xenaxio step 119: tables in and out — reading a CSV file (comma or semicolon,
// quotes, line breaks inside quotes; Excel's "Save as CSV" in German writes
// semicolons) and turning a cell into the value a field expects.
import type { TypeField } from "@/lib/xenaxio/projects";

/** Rows of a CSV text; the separator is guessed from the first line (`;`, `,` or tab). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = [";", ",", "\t"].map((c) => [c, first.split(c).length - 1] as const);
  const sep = counts.sort((a, b) => b[1] - a[1])[0]![1] > 0 ? counts[0]![0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** A CSV text from rows (semicolons, quotes where needed, BOM for Excel). */
export function toCsv(rows: string[][]): string {
  const esc = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `\uFEFF${rows.map((r) => r.map(esc).join(";")).join("\r\n")}\r\n`;
}

const num = (s: string): number | undefined => {
  let t = s.replace(/\s|€|\$|£/g, "");
  // 1.234,56 (German) and 1,234.56 (English)
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number(t);
  return t && Number.isFinite(n) ? n : undefined;
};

/** 31.12.2026, 31/12/2026 or 2026-12-31 → 2026-12-31. */
export function csvDate(s: string): string | undefined {
  const v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(v);
  if (!m) return undefined;
  return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

const YES = ["1", "ja", "yes", "true", "x", "wahr", "y", "j"];
const NO = ["0", "nein", "no", "false", "falsch", "n", ""];

/**
 * A cell as the field's value; `undefined` means the cell does not fit (the row is
 * reported), `null` an empty cell. Options are found by key or by name in either language;
 * people by email or name.
 */
export function csvValue(field: TypeField, cell: string, people: { id: string; email: string; displayName: string }[] = []): unknown {
  const v = cell.trim();
  if (v === "") return null;
  const option = (x: string) => field.options?.find((o) => [o.key, o.label.de, o.label.en].some((n) => n.toLowerCase() === x.trim().toLowerCase()))?.key;
  switch (field.type) {
    case "number":
      return num(v);
    case "money": {
      const cur = /\b(EUR|USD|GBP|CHF|PLN|CZK|SEK|DKK|NOK|UAH)\b/i.exec(v)?.[1]?.toUpperCase() ?? (v.includes("$") ? "USD" : v.includes("£") ? "GBP" : "EUR");
      const amount = num(v.replace(/[A-Za-z]/g, ""));
      return amount === undefined ? undefined : { amount, currency: cur };
    }
    case "date":
      return csvDate(v);
    case "checkbox":
      return YES.includes(v.toLowerCase()) ? true : NO.includes(v.toLowerCase()) ? false : undefined;
    case "select":
      return option(v);
    case "multiselect": {
      const list = v.split(/[,|]/).map((x) => option(x));
      return list.some((x) => x === undefined) ? undefined : [...new Set(list as string[])];
    }
    case "user": {
      const p = people.find((x) => x.email.toLowerCase() === v.toLowerCase() || x.displayName.toLowerCase() === v.toLowerCase());
      return p?.id;
    }
    case "ref":
    case "refs":
    case "external":
      // Links to other records are set in the app after the import.
      return undefined;
    default:
      return v;
  }
}
