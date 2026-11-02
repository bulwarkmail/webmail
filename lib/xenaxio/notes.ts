// Xenaxio step 115: notes in Files. A note is a Markdown (or plain text) file
// edited like on GitHub: a text field with Markdown buttons and a preview.
// The pure parts live here: which files open as notes, and what each button
// does to the text and the selection.

export function isMarkdownName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return ext === "md" || ext === "markdown";
}

/** "Notiz 2026-11-01.md": the prefix comes from the user's language. */
export function defaultNoteName(prefix: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`;
}

/** "Notiz.md" -> "Notiz (Kopie).md": where a conflicting version is kept. */
export function copyName(name: string, suffix: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${suffix})${name.slice(dot)}` : `${name} (${suffix})`;
}

/** The text after an edit and the selection to put back. */
export interface TextEdit {
  text: string;
  start: number;
  end: number;
}

export type InlineMark = "bold" | "italic" | "strike" | "code";
const INLINE_MARKERS: Record<InlineMark, string> = { bold: "**", italic: "_", strike: "~~", code: "`" };

/**
 * Bold, italic, strike or code around the selection; again on a marked
 * selection removes the marks. With nothing selected, the marks go around the
 * caret so the user types between them.
 */
export function toggleInline(text: string, start: number, end: number, mark: InlineMark): TextEdit {
  const m = INLINE_MARKERS[mark];
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);
  if (before.endsWith(m) && after.startsWith(m)) {
    return { text: before.slice(0, -m.length) + selected + after.slice(m.length), start: start - m.length, end: end - m.length };
  }
  if (selected.length >= 2 * m.length && selected.startsWith(m) && selected.endsWith(m)) {
    const inner = selected.slice(m.length, -m.length);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  return { text: before + m + selected + m + after, start: start + m.length, end: end + m.length };
}

export type LineMark = "h1" | "h2" | "h3" | "bullet" | "number" | "task" | "quote";
const LINE_PREFIXES: Record<LineMark, string> = { h1: "# ", h2: "## ", h3: "### ", bullet: "- ", number: "1. ", task: "- [ ] ", quote: "> " };
/** Any prefix a button sets, so one kind replaces another (heading 1 -> 2, list -> task). */
const ANY_PREFIX = /^(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+\. |> )/;

/**
 * Heading, list, task or quote for every line the selection touches. If all
 * of them already have this prefix, it is removed; otherwise it replaces
 * whatever prefix the lines had.
 */
export function toggleLines(text: string, start: number, end: number, mark: LineMark): TextEdit {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const endBreak = text.indexOf("\n", end > start && text[end - 1] === "\n" ? end - 1 : end);
  const lineEnd = endBreak === -1 ? text.length : endBreak;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const prefix = LINE_PREFIXES[mark];
  const has = (line: string) => {
    if (mark === "number") return /^\d+\. /.test(line);
    if (mark === "task") return /^[-*+] \[[ xX]\] /.test(line);
    if (mark === "bullet") return line.startsWith(prefix) && !/^- \[[ xX]\] /.test(line);
    return line.startsWith(prefix);
  };
  const remove = lines.every(has);
  const changed = lines.map((line, i) => {
    const bare = line.replace(ANY_PREFIX, "");
    if (remove) return bare;
    return (mark === "number" ? `${i + 1}. ` : prefix) + bare;
  });
  const block = changed.join("\n");
  const delta = block.length - (lineEnd - lineStart);
  const single = lines.length === 1 && start === end;
  const caret = single ? Math.max(lineStart, start + (changed[0].length - lines[0].length)) : start;
  return {
    text: text.slice(0, lineStart) + block + text.slice(lineEnd),
    start: single ? caret : lineStart,
    end: single ? caret : lineEnd + delta,
  };
}

/** A link: the selection becomes its text; the cursor lands in the address. */
export function insertLink(text: string, start: number, end: number, placeholder: string): TextEdit {
  const label = text.slice(start, end) || placeholder;
  const url = "https://";
  const inserted = `[${label}](${url})`;
  const urlStart = start + label.length + 3;
  return { text: text.slice(0, start) + inserted + text.slice(end), start: urlStart, end: urlStart + url.length };
}

/** A fenced code block around the selected lines (or an empty one at the caret). */
export function insertCodeBlock(text: string, start: number, end: number): TextEdit {
  const selected = text.slice(start, end);
  const lead = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
  const block = `${lead}\`\`\`\n${selected}\n\`\`\`\n`;
  const inner = start + lead.length + 4;
  return { text: text.slice(0, start) + block + text.slice(end), start: inner, end: inner + selected.length };
}

const LIST_ITEM = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)\. |> )(.*)$/;

/**
 * Enter at the end of a list item starts the next item (a task list goes on
 * with an empty box, a numbered list counts on). Enter on an empty item ends
 * the list with a blank line, so the next text is not read as part of the
 * last item. Returns null when Enter should just insert a line break.
 */
export function continueList(text: string, caret: number): TextEdit | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const lineEndAt = text.indexOf("\n", caret);
  const lineEnd = lineEndAt === -1 ? text.length : lineEndAt;
  if (caret !== lineEnd) return null;
  const line = text.slice(lineStart, lineEnd);
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const [, indent, marker, num, rest] = match;
  if (rest.trim() === "") {
    // An empty item: the list ends here, the marker goes away.
    const at = lineStart + 1;
    return { text: text.slice(0, lineStart) + "\n" + text.slice(lineEnd), start: at, end: at };
  }
  let next = marker;
  if (num !== undefined) next = `${Number(num) + 1}. `;
  else if (/\[[xX]\]/.test(marker)) next = marker.replace(/\[[xX]\]/, "[ ]");
  const insert = `\n${indent}${next}`;
  const at = caret + insert.length;
  return { text: text.slice(0, caret) + insert + text.slice(caret), start: at, end: at };
}

/** Where a save stands, for the status line. */
export type SaveState = "saved" | "dirty" | "saving" | "failed" | "conflict";
