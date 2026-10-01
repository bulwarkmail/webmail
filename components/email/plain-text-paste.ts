import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Mark, type Node, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

type PlainBlock =
  | { type: "line"; text: string }
  | { type: "list"; ordered: boolean; start: number; items: PlainBlock[][] };

interface ItemMarker {
  indent: number;
  ordered: boolean;
  start: number;
  content: string;
}

// "- ", "* ", "• ", "1. " or "1) " followed by the item text.
const ITEM_MARKER = /^([ \t]*)(?:[-*•]|(\d{1,3})[.)])[ \t]+(?=\S)/;

const isBlank = (line: string) => line.trim() === "";

function indentOf(line: string): number {
  const lead = /^[ \t]*/.exec(line)![0];
  return lead.replace(/\t/g, "    ").length;
}

function dedent(line: string, columns: number): string {
  let i = 0;
  for (let col = 0; i < line.length && col < columns; i++) {
    if (line[i] === " ") col += 1;
    else if (line[i] === "\t") col += 4;
    else break;
  }
  return line.slice(i);
}

function itemMarker(line: string): ItemMarker | null {
  const m = ITEM_MARKER.exec(line);
  if (!m) return null;
  return {
    indent: indentOf(m[1]),
    ordered: m[2] !== undefined,
    start: m[2] !== undefined ? Number(m[2]) : 1,
    content: line.slice(m[0].length),
  };
}

function parseLines(lines: string[]): PlainBlock[] {
  const blocks: PlainBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const marker = itemMarker(lines[i]);
    if (marker) {
      const items: PlainBlock[][] = [];
      i = parseList(lines, i, marker, items);
      blocks.push({ type: "list", ordered: marker.ordered, start: marker.start, items });
    } else {
      blocks.push({ type: "line", text: isBlank(lines[i]) ? "" : lines[i] });
      i++;
    }
  }
  return blocks;
}

/**
 * Reads the items of one list starting at `i` into `items` and returns the
 * index of the first line after it. An item takes the lines indented under
 * it (continuations and nested lists) and, like Markdown, unindented lines
 * that follow it directly, so hard-wrapped items stay whole. Blank lines
 * between items are dropped; blank lines after the list are left for the
 * caller.
 */
function parseList(lines: string[], i: number, first: ItemMarker, items: PlainBlock[][]): number {
  let marker = first;
  for (;;) {
    const body: { text: string; indented: boolean }[] = [];
    let j = i + 1;
    let end = j;
    let lazy = true;
    while (j < lines.length) {
      const line = lines[j];
      if (isBlank(line)) {
        lazy = false;
        j++;
        continue;
      }
      const indented = indentOf(line) > marker.indent;
      if (!indented && !(lazy && !itemMarker(line))) break;
      for (let k = end; k < j; k++) body.push({ text: "", indented: false });
      body.push({ text: line, indented });
      end = ++j;
      lazy = true;
    }

    const shift = Math.min(...body.filter((l) => l.indented).map((l) => indentOf(l.text)));
    const rest = body.map((l) => (l.indented ? dedent(l.text, shift) : l.text.trimStart()));
    items.push([{ type: "line", text: marker.content }, ...parseLines(rest)]);

    let next = end;
    while (next < lines.length && isBlank(lines[next])) next++;
    const sibling = next < lines.length ? itemMarker(lines[next]) : null;
    if (!sibling || sibling.ordered !== first.ordered || sibling.indent !== first.indent) return end;
    i = next;
    marker = sibling;
  }
}

function toNodes(blocks: PlainBlock[], schema: Schema, marks: readonly Mark[]): Node[] {
  return blocks.map((block) => {
    if (block.type === "line") {
      return schema.nodes.paragraph.create(null, block.text ? schema.text(block.text, marks) : null);
    }
    const items = block.items.map((item) => schema.nodes.listItem.create(null, toNodes(item, schema, marks)));
    return block.ordered
      ? schema.nodes.orderedList.create({ start: block.start }, items)
      : schema.nodes.bulletList.create(null, items);
  });
}

/**
 * Pastes plain text as one paragraph per line, blank lines included, and
 * turns "- " / "1. " items into real lists.
 *
 * In the composer Enter starts a new paragraph and a blank line is an empty
 * paragraph. ProseMirror's default text paste splits on runs of newlines
 * instead, so every blank line was dropped and a pasted mail arrived as a
 * wall of lines with no gap between its paragraphs. This builds the same
 * paragraphs typing the text would.
 */
export const PlainTextPaste = Extension.create({
  name: "plainTextPaste",

  addProseMirrorPlugins() {
    const { schema } = this.editor;
    return [
      new Plugin({
        key: new PluginKey("plainTextPaste"),
        props: {
          clipboardTextParser: (text, $context) => {
            const blocks = parseLines(text.split(/\r\n?|\n/));
            return Slice.maxOpen(Fragment.from(toNodes(blocks, schema, $context.marks())));
          },
        },
      }),
    ];
  },
});
