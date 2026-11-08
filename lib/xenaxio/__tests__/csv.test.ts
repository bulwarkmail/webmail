import { describe, expect, it } from "vitest";
import { csvDate, csvValue, parseCsv, toCsv } from "@/lib/xenaxio/csv";
import type { TypeField } from "@/lib/xenaxio/projects";

// Step 119: tables in and out.
const f = (type: TypeField["type"], extra: Partial<TypeField> = {}): TypeField => ({ key: "x", type, label: { de: "X", en: "X" }, ...extra });

describe("csv", () => {
  it("reads semicolon and comma files with quotes and line breaks", () => {
    expect(parseCsv('﻿Name;Betrag\r\n"Müller; GmbH";"1.200,50"\r\n\r\nB;3\n')).toEqual([
      ["Name", "Betrag"],
      ["Müller; GmbH", "1.200,50"],
      ["B", "3"],
    ]);
    expect(parseCsv('a,b\n"x ""y""","line\nbreak"')).toEqual([
      ["a", "b"],
      ['x "y"', "line\nbreak"],
    ]);
  });

  it("writes Excel-friendly CSV and reads it back", () => {
    const rows = [["A;1", 'q"x'], ["ä", ""]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("turns cells into field values, or tells they do not fit", () => {
    expect(csvValue(f("money"), "1.234,50 €")).toEqual({ amount: 1234.5, currency: "EUR" });
    expect(csvValue(f("money"), "USD 99.90")).toEqual({ amount: 99.9, currency: "USD" });
    expect(csvValue(f("number"), "1,234.5")).toBe(1234.5);
    expect(csvValue(f("number"), "abc")).toBeUndefined();
    expect(csvDate("31.12.2026")).toBe("2026-12-31");
    expect(csvValue(f("date"), "2026-13-45x")).toBeUndefined();
    expect(csvValue(f("checkbox"), "Ja")).toBe(true);
    const opts = { options: [{ key: "fair", label: { de: "Messe", en: "Trade fair" } }, { key: "web", label: { de: "Web", en: "Web" } }] };
    expect(csvValue(f("select", opts), "Messe")).toBe("fair");
    expect(csvValue(f("multiselect", opts), "web, Trade fair")).toEqual(["web", "fair"]);
    expect(csvValue(f("select", opts), "TV")).toBeUndefined();
    expect(csvValue(f("user"), "anna@acme.de", [{ id: "u1", email: "anna@acme.de", displayName: "Anna" }])).toBe("u1");
    expect(csvValue(f("text"), "  ")).toBeNull();
    expect(csvValue(f("ref"), "x")).toBeUndefined();
  });
});
