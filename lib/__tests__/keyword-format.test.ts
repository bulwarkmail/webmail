import { describe, it, expect } from "vitest";
import { formatKeyword, formatKeywordLabels, keywordRenderings } from "@/lib/keyword-format";
import type { KeywordDefinition } from "@/stores/settings-store";

const kw = (id: string, label: string): KeywordDefinition => ({ id, label, color: "blue" });

// Work
//   Clients
//     Acme
//   Personal
const KEYWORDS: KeywordDefinition[] = [
  kw("work", "Work"),
  kw("work/clients", "Clients"),
  kw("work/clients/acme", "Acme"),
  kw("work/personal", "Personal"),
];

describe("formatKeyword with nesting on", () => {
  it("joins the display name of every level", () => {
    expect(formatKeyword("work/clients/acme", KEYWORDS, true)).toBe("Work/Clients/Acme");
  });

  it("returns the plain display name for a tag with one level", () => {
    expect(formatKeyword("work", KEYWORDS, true)).toBe("Work");
  });

  it("falls back to the raw level for one this client does not know", () => {
    expect(formatKeyword("work/archive/2026", KEYWORDS, true)).toBe("Work/archive/2026");
    expect(formatKeyword("unknown", [], true)).toBe("unknown");
  });
});

describe("formatKeyword with nesting off", () => {
  it("names a tag by its own label, leaving a slash in the id uninterpreted", () => {
    // The setting says a slash means nothing, so an id that happens to contain
    // one - from before it was turned off, or from another client - is a single
    // opaque token rather than a hierarchy.
    expect(formatKeyword("work/clients/acme", KEYWORDS, false)).toBe("Acme");
    expect(formatKeyword("work", KEYWORDS, false)).toBe("Work");
  });

  it("falls back to the whole id when the tag has no definition", () => {
    expect(formatKeyword("work/archive/2026", KEYWORDS, false)).toBe("work/archive/2026");
  });

  it("offers no shortening, leaving the markup to clip", () => {
    expect(keywordRenderings(formatKeywordLabels("work/clients/acme", KEYWORDS, false)))
      .toEqual(["Acme"]);
  });
});

describe("keywordRenderings", () => {
  it("shortens by one intermediate level at a time, outermost first", () => {
    expect(keywordRenderings(["Work", "Clients", "Acme", "EU", "Sales"])).toEqual([
      "Work/Clients/Acme/EU/Sales",
      "Work/../Acme/EU/Sales",
      "Work/.../EU/Sales",
      "Work/.../Sales",
    ]);
  });

  it("collapses to a single ... as soon as the run covers more than one level", () => {
    expect(keywordRenderings(["Work", "Clients", "Acme", "Sales"])).toEqual([
      "Work/Clients/Acme/Sales",
      "Work/../Acme/Sales",
      "Work/.../Sales",
    ]);
  });

  it("uses .. for a lone intermediate level, never ...", () => {
    expect(keywordRenderings(["Work", "Clients", "Acme"])).toEqual([
      "Work/Clients/Acme",
      "Work/../Acme",
    ]);
  });

  it("has nothing to shorten without an intermediate level", () => {
    expect(keywordRenderings(["Work", "Acme"])).toEqual(["Work/Acme"]);
    expect(keywordRenderings(["Work"])).toEqual(["Work"]);
  });

  it("drops a rendering that would not come out shorter", () => {
    // "../" costs as much as the level it replaces, so shortening buys nothing.
    expect(keywordRenderings(["a", "it", "b"])).toEqual(["a/it/b"]);
    expect(keywordRenderings(["a", "x", "b"])).toEqual(["a/x/b"]);
  });
});

// How the components use the two together: resolve a tag to its display names,
// then hand the ladder to `useShortenedText` to pick a rung.
describe("keywordRenderings over formatKeywordLabels", () => {
  it("shortens a display name by the same ladder as an id", () => {
    const deep: KeywordDefinition[] = [
      kw("work", "Work"),
      kw("work/clients", "Clients"),
      kw("work/clients/acme", "Acme"),
      kw("work/clients/acme/eu", "Europe"),
    ];

    expect(keywordRenderings(formatKeywordLabels("work/clients/acme/eu", deep, true))).toEqual([
      "Work/Clients/Acme/Europe",
      "Work/../Acme/Europe",
      "Work/.../Europe",
    ]);
  });

  it("treats a slash inside one display name as part of that name, not a level", () => {
    const slashed: KeywordDefinition[] = [kw("work", "Work"), kw("work/acme-r-d", "Acme/R&D")];

    // Two levels, so there is no intermediate level to shorten.
    expect(keywordRenderings(formatKeywordLabels("work/acme-r-d", slashed, true))).toEqual([
      "Work/Acme/R&D",
    ]);
  });
});
