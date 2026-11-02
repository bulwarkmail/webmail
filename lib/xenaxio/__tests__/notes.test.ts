import { describe, expect, it } from "vitest";
import {
  continueList, copyName, defaultNoteName, insertLink, isMarkdownName,
  toggleInline, toggleLines, insertCodeBlock,
} from "../notes";
import { renderMarkdown } from "../markdown";

/** "a|b|c": the text with the selection between the bars (one bar: the caret). */
function sel(marked: string) {
  const first = marked.indexOf("|");
  const second = marked.indexOf("|", first + 1);
  if (second === -1) return { text: marked.replace("|", ""), start: first, end: first };
  return { text: marked.slice(0, first) + marked.slice(first + 1, second) + marked.slice(second + 1), start: first, end: second - 1 };
}
function show(e: { text: string; start: number; end: number }) {
  if (e.start === e.end) return e.text.slice(0, e.start) + "|" + e.text.slice(e.start);
  return e.text.slice(0, e.start) + "|" + e.text.slice(e.start, e.end) + "|" + e.text.slice(e.end);
}

describe("notes (step 115)", () => {
  it("knows Markdown by its extension", () => {
    expect(isMarkdownName("a.md")).toBe(true);
    expect(isMarkdownName("A.MARKDOWN")).toBe(true);
    expect(isMarkdownName("a.txt")).toBe(false);
  });

  it("names a new note by its date and a copy by its suffix", () => {
    expect(defaultNoteName("Notiz", new Date(2026, 10, 1))).toBe("Notiz 2026-11-01.md");
    expect(copyName("Plan.md", "Kopie")).toBe("Plan (Kopie).md");
    expect(copyName("Plan", "copy")).toBe("Plan (copy)");
  });
});

describe("Markdown buttons", () => {
  it("puts marks around the selection and takes them away again", () => {
    const { text, start, end } = sel("ein |Wort| hier");
    const bold = toggleInline(text, start, end, "bold");
    expect(show(bold)).toBe("ein **|Wort|** hier");
    expect(show(toggleInline(bold.text, bold.start, bold.end, "bold"))).toBe("ein |Wort| hier");
    const marked = sel("ein |**Wort**| hier");
    expect(show(toggleInline(marked.text, marked.start, marked.end, "bold"))).toBe("ein |Wort| hier");
  });

  it("leaves the caret between new marks when nothing is selected", () => {
    const { text, start, end } = sel("a |b");
    expect(show(toggleInline(text, start, end, "code"))).toBe("a `|`b");
    expect(show(toggleInline(text, start, end, "strike"))).toBe("a ~~|~~b");
  });

  it("turns lines into a heading, list or task, and back", () => {
    const one = sel("Titel|");
    const h1 = toggleLines(one.text, one.start, one.end, "h1");
    expect(show(h1)).toBe("# Titel|");
    const h2 = toggleLines(h1.text, h1.start, h1.end, "h2");
    expect(show(h2)).toBe("## Titel|");
    expect(show(toggleLines(h2.text, h2.start, h2.end, "h2"))).toBe("Titel|");

    const many = sel("|eins\nzwei|\ndrei");
    const list = toggleLines(many.text, many.start, many.end, "bullet");
    expect(list.text).toBe("- eins\n- zwei\ndrei");
    const tasks = toggleLines(list.text, list.start, list.end, "task");
    expect(tasks.text).toBe("- [ ] eins\n- [ ] zwei\ndrei");
    const numbered = toggleLines(tasks.text, tasks.start, tasks.end, "number");
    expect(numbered.text).toBe("1. eins\n2. zwei\ndrei");
    expect(toggleLines(numbered.text, numbered.start, numbered.end, "number").text).toBe("eins\nzwei\ndrei");
  });

  it("does not take a ticked task for a plain list item", () => {
    const { text, start, end } = sel("- [x] fertig|");
    expect(toggleLines(text, start, end, "bullet").text).toBe("- fertig");
    expect(toggleLines(text, start, end, "task").text).toBe("fertig");
  });

  it("makes a link with the cursor on its address", () => {
    const { text, start, end } = sel("siehe |Seite|");
    const edit = insertLink(text, start, end, "Linktext");
    expect(edit.text).toBe("siehe [Seite](https://)");
    expect(edit.text.slice(edit.start, edit.end)).toBe("https://");
    expect(insertLink("", 0, 0, "Linktext").text).toBe("[Linktext](https://)");
  });

  it("wraps lines in a code block", () => {
    const { text, start, end } = sel("x|let a = 1|");
    expect(insertCodeBlock(text, start, end).text).toBe("x\n```\nlet a = 1\n```\n");
  });
});

describe("Enter in a list", () => {
  it("starts the next item", () => {
    expect(show(continueList(...at("- Milch|"))!)).toBe("- Milch\n- |");
    expect(show(continueList(...at("  * Brot|"))!)).toBe("  * Brot\n  * |");
    expect(show(continueList(...at("2. zwei|"))!)).toBe("2. zwei\n3. |");
    expect(show(continueList(...at("- [x] erledigt|"))!)).toBe("- [x] erledigt\n- [ ] |");
    expect(show(continueList(...at("> Zitat|"))!)).toBe("> Zitat\n> |");
  });

  it("ends the list on an empty item", () => {
    expect(show(continueList(...at("- eins\n- |"))!)).toBe("- eins\n\n|");
  });

  it("leaves a normal line break alone", () => {
    expect(continueList(...at("Text|"))).toBeNull();
    expect(continueList(...at("- Mi|lch"))).toBeNull();
  });
});

function at(marked: string): [string, number] {
  const { text, start } = sel(marked);
  return [text, start];
}

describe("Markdown as GitHub shows it", () => {
  it("renders headings, task boxes, tables and links", () => {
    const html = renderMarkdown("# Plan\n\n- [ ] offen\n- [x] fertig\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n[Seite](https://example.com)");
    expect(html).toContain("<h1>Plan</h1>");
    expect(html).toContain('<li><input disabled="" type="checkbox"> offen</li>');
    expect(html).toMatch(/<input[^>]*checked/);
    expect(html).toContain("<table>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("drops scripts, handlers and unsafe links", () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(2)">\n\n[x](javascript:alert(3))\n\n<a href="data:text/html,hi" onclick="alert(4)">y</a>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).not.toContain("<img");
  });

  it("does not load pictures by address: they become links", () => {
    const html = renderMarkdown("![Logo](https://tracker.example/pixel.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://tracker.example/pixel.png"');
    expect(html).toContain(">Logo</a>");
  });

  it("keeps only checkboxes among inputs", () => {
    const html = renderMarkdown('<input type="text" value="x"><input type="checkbox">');
    expect(html).not.toContain('type="text"');
    expect(html).toContain('type="checkbox"');
  });
});
