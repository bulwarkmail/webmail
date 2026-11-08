import { describe, expect, it } from "vitest";
import { fieldText } from "../projects/fields";
import type { TypeField } from "@/lib/xenaxio/projects";

// Step 119: values of fields as people read them in lists and cards.
const f = (type: TypeField["type"], extra: Partial<TypeField> = {}): TypeField => ({ key: "x", type, label: { de: "X", en: "X" }, ...extra });

describe("fieldText", () => {
  it("shows values by kind in the user's language", () => {
    expect(fieldText(f("money"), { amount: 1200, currency: "EUR" }, "de")).toMatch(/1\.200,00\s€/);
    expect(fieldText(f("date"), "2026-11-20", "de")).toBe("20.11.2026");
    const opts = { options: [{ key: "fair", label: { de: "Messe", en: "Trade fair" } }] };
    expect(fieldText(f("select", opts), "fair", "en")).toBe("Trade fair");
    expect(fieldText(f("multiselect", opts), ["fair"], "de")).toBe("Messe");
    expect(fieldText(f("checkbox"), true, "de")).toBe("✓");
    expect(fieldText(f("user"), "u1", "de", new Map([["a@b.de", { id: "u1", displayName: "Anna" }]]))).toBe("Anna");
    expect(fieldText(f("text"), null, "de")).toBe("");
  });
});
