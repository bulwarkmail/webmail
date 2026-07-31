import { describe, it, expect } from "vitest";
import {
  MAX_KEYWORD_ID_LENGTH,
  buildKeywordTree,
  composeKeywordId,
  countKeywordNodes,
  filterKeywordTree,
  getParentKeywordId,
  hasChildKeywords,
  isKeywordDescendant,
  keywordLevels,
  normalizeKeywordLevel,
} from "@/lib/keyword-nesting";
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

describe("normalizeKeywordLevel", () => {
  it("lowercases and folds unsupported characters into single dashes", () => {
    expect(normalizeKeywordLevel("My Custom Tag!")).toBe("my-custom-tag");
    expect(normalizeKeywordLevel("  Spaced   Out  ")).toBe("spaced-out");
    expect(normalizeKeywordLevel("--Trimmed--")).toBe("trimmed");
  });

  it("treats a slash as part of the name, not as a level", () => {
    expect(normalizeKeywordLevel("Acme/R&D")).toBe("acme-r-d");
  });

  it("returns an empty string when nothing usable is left", () => {
    expect(normalizeKeywordLevel("   ")).toBe("");
    expect(normalizeKeywordLevel("!!!")).toBe("");
  });
});

describe("composeKeywordId", () => {
  it("returns a bare slug at the top level", () => {
    expect(composeKeywordId(null, "Work")).toBe("work");
    expect(composeKeywordId("", "Work")).toBe("work");
  });

  it("appends the slug below the parent", () => {
    expect(composeKeywordId("work/clients", "Acme")).toBe("work/clients/acme");
  });

  it("never produces a trailing separator for an unusable name", () => {
    expect(composeKeywordId("work", "!!!")).toBe("");
  });
});

describe("keywordLevels", () => {
  it("splits an id into its levels", () => {
    expect(keywordLevels("work/clients/acme")).toEqual(["work", "clients", "acme"]);
    expect(keywordLevels("work")).toEqual(["work"]);
  });
});

describe("getParentKeywordId", () => {
  it("drops the last level", () => {
    expect(getParentKeywordId("work/clients/acme")).toBe("work/clients");
  });

  it("returns null for a top-level tag", () => {
    expect(getParentKeywordId("work")).toBeNull();
  });
});

describe("isKeywordDescendant", () => {
  it("matches anything below the ancestor", () => {
    expect(isKeywordDescendant("work/clients/acme", "work")).toBe(true);
    expect(isKeywordDescendant("work/clients", "work")).toBe(true);
  });

  it("does not match the ancestor itself or a shared name prefix", () => {
    expect(isKeywordDescendant("work", "work")).toBe(false);
    expect(isKeywordDescendant("workshop/tools", "work")).toBe(false);
  });
});

describe("hasChildKeywords", () => {
  it("reports whether any defined tag sits below the given one", () => {
    expect(hasChildKeywords("work", KEYWORDS)).toBe(true);
    expect(hasChildKeywords("work/clients", KEYWORDS)).toBe(true);
    expect(hasChildKeywords("work/clients/acme", KEYWORDS)).toBe(false);
  });
});

describe("MAX_KEYWORD_ID_LENGTH", () => {
  it("leaves room for the `$label:` prefix within the 255-character keyword limit", () => {
    expect(MAX_KEYWORD_ID_LENGTH).toBe(248);
    expect("$label:".length + MAX_KEYWORD_ID_LENGTH).toBe(255);
  });
});

describe("buildKeywordTree", () => {
  it("nests each tag under its parent and records the depth", () => {
    const [work] = buildKeywordTree(KEYWORDS);

    expect(work.id).toBe("work");
    expect(work.depth).toBe(0);
    expect(work.children.map((c) => c.id)).toEqual(["work/clients", "work/personal"]);

    const clients = work.children[0];
    expect(clients.depth).toBe(1);
    expect(clients.children.map((c) => c.id)).toEqual(["work/clients/acme"]);
    expect(clients.children[0].depth).toBe(2);
  });

  it("keeps the manual order within a level", () => {
    const reordered = [KEYWORDS[0], KEYWORDS[3], KEYWORDS[1], KEYWORDS[2]];
    const [work] = buildKeywordTree(reordered);

    expect(work.children.map((c) => c.id)).toEqual(["work/personal", "work/clients"]);
  });

  it("keeps a tag whose parent is not defined at the root", () => {
    const orphan = buildKeywordTree([kw("work/clients/acme", "Acme")]);

    expect(orphan).toHaveLength(1);
    expect(orphan[0].id).toBe("work/clients/acme");
    expect(orphan[0].depth).toBe(0);
  });

  it("returns every tag as a root when no id describes a hierarchy", () => {
    const flat = buildKeywordTree([kw("red", "Red"), kw("blue", "Blue")]);

    expect(flat.map((n) => n.id)).toEqual(["red", "blue"]);
    expect(flat.every((n) => n.depth === 0 && n.children.length === 0)).toBe(true);
  });
});

describe("filterKeywordTree", () => {
  const tree = buildKeywordTree(KEYWORDS);

  it("drops the nodes the predicate rejects", () => {
    const kept = filterKeywordTree(tree, (node) => node.id !== "work/personal");
    const [work] = kept;

    expect(work.children.map((c) => c.id)).toEqual(["work/clients"]);
  });

  it("keeps a rejected node when a descendant survives, so nothing is stranded", () => {
    const kept = filterKeywordTree(tree, (node) => node.id === "work/clients/acme");
    const [work] = kept;

    expect(work.id).toBe("work");
    expect(work.children.map((c) => c.id)).toEqual(["work/clients"]);
    expect(work.children[0].children.map((c) => c.id)).toEqual(["work/clients/acme"]);
  });

  it("keeps the depth of a surviving node so its indentation does not shift", () => {
    const kept = filterKeywordTree(tree, (node) => node.id === "work/clients/acme");

    expect(kept[0].children[0].children[0].depth).toBe(2);
  });

  it("returns nothing when the predicate rejects everything", () => {
    expect(filterKeywordTree(tree, () => false)).toEqual([]);
  });

  it("leaves the original tree untouched", () => {
    filterKeywordTree(tree, (node) => node.id === "work");

    expect(countKeywordNodes(tree)).toBe(4);
  });
});

describe("countKeywordNodes", () => {
  it("counts every level, not just the roots", () => {
    expect(countKeywordNodes(buildKeywordTree(KEYWORDS))).toBe(4);
    expect(countKeywordNodes([])).toBe(0);
  });
});
