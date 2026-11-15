import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import {
  addRowAfter as stockAddRowAfter,
  addRowBefore as stockAddRowBefore,
  addColumnAfter as stockAddColumnAfter,
  addColumnBefore as stockAddColumnBefore,
  isInTable,
  selectedRect,
  tableNodeTypes,
  TableMap,
} from "prosemirror-tables";

// Excel/WPS/Word put the clipboard table's styling where ProseMirror's
// clipboard parser cannot reach it: class rules in a <head> <style> block
// (.xl65 { background: red }), legacy bgcolor/width/height attributes, and
// inline styles the table schema does not know (#1233 kept the cells but
// lost their look). The extensions below round-trip a `style` attribute on
// table/row/header/cell nodes - the same pattern StyledParagraph uses for
// pasted signatures (#198407ebf-style fix) - and TablePaste moves the
// clipboard styles onto the elements' style attribute before the parse.

const styleAttr = {
  default: null as string | null,
  parseHTML: (el: HTMLElement) => el.getAttribute("style"),
  renderHTML: (attrs: Record<string, string | null>) =>
    attrs.style ? { style: attrs.style } : {},
};

/**
 * Table nodes that keep the inline style of pasted cells on edit and send.
 * addAttributes replaces the parent's set, so each spread keeps the table
 * schema's own attributes (colspan, rowspan, colwidth, align) next to style.
 *
 * The insert commands are overridden so a new row/column inherits the style
 * of the row/column the cursor is in: the stock commands create cells with
 * default attributes, and a cell inserted into a coloured region of a
 * pasted table would come out white.
 */
export const StyledTable = Table.extend({
  addAttributes() {
    return { ...this.parent?.(), style: styleAttr };
  },
  addCommands() {
    return {
      ...this.parent?.(),
      addRowBefore: () => insertStyled(stockAddRowBefore, "row", "before"),
      addRowAfter: () => insertStyled(stockAddRowAfter, "row", "after"),
      addColumnBefore: () => insertStyled(stockAddColumnBefore, "column", "before"),
      addColumnAfter: () => insertStyled(stockAddColumnAfter, "column", "after"),
      /**
       * Sets the background colour of every selected cell (the cursor's
       * cell when the selection is a caret) by merging it into the cell's
       * style attribute, which round-trips to the sent mail. null clears
       * it. Same palette as the text background colour.
       *
       * Clearing a header cell writes background-color: transparent rather
       * than removing the property: the extension's HTMLAttributes give
       * every th a default grey tint (#f5f5f5), and that merged style
       * would otherwise come back the moment ours is gone. Transparent
       * beats it in the cascade (inline, later), renders white on the
       * sent mail's white page, and keeps the composer's dark theme
       * readable instead of white-on-light-text.
       */
      setCellBackground: (color: string | null) =>
        ({ state, tr, dispatch }: CommandProps) => {
          if (!isInTable(state)) return false;
          if (!dispatch) return true;
          const rect = selectedRect(state);
          for (const pos of rect.map.cellsInRect(rect)) {
            const cell = tr.doc.nodeAt(rect.tableStart + pos);
            if (!cell) continue;
            tr.setNodeMarkup(rect.tableStart + pos, null, {
              ...cell.attrs,
              style: cellBackgroundStyle(
                cell.attrs.style,
                color === null && cell.type.name === "tableHeader" ? "transparent" : color,
              ),
            });
          }
          return true;
        },
      /**
       * Toggles the header row like the stock command, but when cells turn
       * INTO header cells it first drops the look they carry on their own:
       * the background, text colour and weight on the style attribute, and
       * the bold mark the Bold extension parsed out of a pasted
       * font-weight. Pasted tables inline their colours there, and an
       * inline value wins the cascade over the th defaults the
       * StyledTableHeader HTMLAttributes add, so without this the toggle
       * changes the markup but nothing the eye can see, and a bold pasted
       * row stays bold (and immune to the bold button, which toggles the
       * mark, not the inline style) after the header is turned off again.
       * Turning the header row off keeps what the cells have.
       */
      toggleHeaderRowStyled: () =>
        ({ state, tr, dispatch }: CommandProps) => {
          if (!isInTable(state)) return false;
          if (!dispatch) return true;
          const rect = selectedRect(state);
          const types = tableNodeTypes(state.schema);
          const headerEverywhere = (left: number, right: number, top: number, bottom: number) =>
            rect.map
              .cellsInRect({ left, right, top, bottom })
              .every((pos) => rect.table.nodeAt(pos)?.type === types.header_cell);
          const isHeaderRow = headerEverywhere(0, rect.map.width, 0, 1);
          // Leave the corner cell to the header column, as the stock command does.
          const left = headerEverywhere(0, 1, 0, rect.map.height) ? 1 : 0;
          const bold = state.schema.marks.bold;
          for (const pos of rect.map.cellsInRect({ left, right: rect.map.width, top: 0, bottom: 1 })) {
            const cell = tr.doc.nodeAt(rect.tableStart + pos);
            if (!cell) continue;
            tr.setNodeMarkup(rect.tableStart + pos, isHeaderRow ? types.cell : types.header_cell, {
              ...cell.attrs,
              style: isHeaderRow ? cell.attrs.style : stripCellLook(cell.attrs.style),
            });
            if (!isHeaderRow && bold) {
              // The header look is bold by default, so the mark would be
              // invisible in it; removing it here is what lets turning the
              // header off restore the normal weight.
              const from = rect.tableStart + pos + 1;
              tr.removeMark(from, from + cell.content.size, bold);
            }
          }
          return true;
        },
    };
  },
});
export const StyledTableRow = TableRow.extend({
  addAttributes() {
    return { ...this.parent?.(), style: styleAttr };
  },
});
export const StyledTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), style: styleAttr };
  },
});
export const StyledTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), style: styleAttr };
  },
});

const OFFICE_DOCUMENT = /<meta[^>]+name=["']?ProgId["']?[^>]+content=["']?(?:Excel\.Sheet|Word\.Document)/i;
const HAS_TABLE = /<table[\s>]/i;
const HAS_STYLE_BLOCK = /<style[\s>]/i;
const FIXED_LAYOUT = /table-layout\s*:\s*fixed/i;

// Only presentation properties survive the inlining. A pasted <style> block
// is attacker-controllable clipboard content, so anything that can move or
// load content (position, url(), expression(), behavior) is dropped rather
// than shipped inside the sent mail.
const ALLOWED_PROPERTIES = new Set([
  "background-color", "background", "color",
  "font-weight", "font-style", "font-size", "font-family",
  "text-align", "vertical-align",
  "border", "border-collapse", "border-spacing",
  "border-style", "border-width", "border-color",
  "border-top", "border-right", "border-bottom", "border-left",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "width", "height",
]);

/** One `.class { prop: value; ... }` or `tag { ... }` rule of a style block. */
interface StyleRule {
  classes: string[];
  tags: string[];
  declarations: string;
}

/** Comma-separated simple selectors only; mso comments around the block are stripped first. */
function parseStyleRules(css: string): StyleRule[] {
  const rules: StyleRule[] = [];
  const stripped = css.replace(/<!--|-->/g, "\n");
  // No (^|\}) anchor: it would consume the previous block's closing brace
  // and drop every other rule. [^{}]+ naturally spans the text between the
  // previous } and the next {.
  const blocks = stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const block of blocks) {
    const selectors = block[1].split(",").map((s) => s.trim()).filter(Boolean);
    const rule: StyleRule = { classes: [], tags: [], declarations: block[2].trim() };
    for (const selector of selectors) {
      if (/^[\w-]+$/.test(selector)) rule.tags.push(selector.toLowerCase());
      else if (/^\.[\w-]+$/.test(selector)) rule.classes.push(selector.slice(1));
      else continue; // descendant/pseudo selectors are not worth emulating
    }
    if ((rule.classes.length > 0 || rule.tags.length > 0) && rule.declarations) rules.push(rule);
  }
  return rules;
}

const DANGEROUS_VALUE = /(url\s*\(|expression\s*\(|behavior\s*:|@import|-moz-binding)/i;

/** Only whitelisted properties with safe values, `;`-separated, order kept. */
function filterDeclarations(declarations: string): string {
  const kept: string[] = [];
  for (const declaration of declarations.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon <= 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!ALLOWED_PROPERTIES.has(property)) continue;
    if (!value || DANGEROUS_VALUE.test(value)) continue;
    kept.push(`${property}: ${value}`);
  }
  return kept.join("; ");
}

function appendStyle(el: Element, declarations: string) {
  if (!declarations) return;
  const own = el.getAttribute("style")?.trim();
  // The element's own inline style wins over a class rule, as in CSS.
  el.setAttribute("style", own ? `${declarations}; ${own}` : declarations);
}

/**
 * Drops text-align declarations with a value that is not CSS (Excel and
 * WPS write their "default" alignment as text-align:general). A browser
 * throws such a declaration away at render time, but the paste pipeline
 * keeps it as text: it survives into the cell's style attribute, where it
 * occupies the text-align slot of the attribute-level merge and blocks the
 * StyledTableHeader default (text-align: left) from filling in. The sent
 * mail then carries a th with no working alignment, and the recipient's
 * client falls back to the browser default for th - centred text.
 */
function dropInvalidTextAlign(el: Element) {
  const style = el.getAttribute("style");
  if (!style || !/text-align\s*:/i.test(style)) return;
  const kept = style
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const colon = d.indexOf(":");
      if (colon <= 0) return true;
      if (d.slice(0, colon).trim().toLowerCase() !== "text-align") return true;
      return /^(left|right|center|justify|start|end)$/i.test(d.slice(colon + 1).trim());
    });
  if (kept.length > 0) el.setAttribute("style", kept.join("; "));
  else el.removeAttribute("style");
}

/** Legacy presentational attributes the table schema does not parse. */
function mapLegacyAttributes(el: Element) {
  const style = el.getAttribute("style") || "";
  const add: string[] = [];
  const bgcolor = el.getAttribute("bgcolor");
  if (bgcolor && !/background(-color)?:/i.test(style)) add.push(`background-color: ${bgcolor}`);
  // Legacy cell width: under the fixed layout it sizes the column when the
  // table has no colgroup (Word-style tables).
  const width = el.getAttribute("width");
  if (width && /^\d+$/.test(width) && !/(^|[^-])width\s*:/i.test(style)) add.push(`width: ${width}px`);
  const height = el.getAttribute("height");
  if (height && /^\d+$/.test(height) && !/height\s*:/i.test(style)) add.push(`height: ${height}px`);
  // Legacy align/valign: the schema's align parser reads the style, not the attribute.
  const align = el.getAttribute("align");
  if (align && /^(left|right|center|justify)$/i.test(align) && !/text-align\s*:/i.test(style)) {
    add.push(`text-align: ${align.toLowerCase()}`);
  }
  const valign = el.getAttribute("valign");
  if (valign && /^(top|middle|bottom)$/i.test(valign) && !/vertical-align\s*:/i.test(style)) {
    add.push(`vertical-align: ${valign.toLowerCase()}`);
  }
  if (add.length > 0) el.setAttribute("style", [...add, style].filter(Boolean).join("; "));
}

/**
 * `<col span=2 width=64>` becomes two cols: the schema's colwidth fallback
 * reads `<col>` widths by cell index and does not expand spans. With the
 * spans expanded, every cell maps to its own col, and the widths become the
 * schema's colwidth - the fixed column widths the resize handles edit.
 */
function expandColSpans(doc: Document) {
  for (const col of Array.from(doc.querySelectorAll("col"))) {
    const span = parseInt(col.getAttribute("span") || "1", 10);
    if (!(span > 1) || !col.parentElement) continue;
    col.removeAttribute("span");
    for (let i = 1; i < span; i++) {
      col.parentElement.insertBefore(col.cloneNode(), col.nextSibling);
    }
  }
}

/**
 * Office tables are pinned to the spreadsheet's grid: table-layout: fixed and
 * pt-sized widths on the table, cols and cells. That grid is the source's
 * format, so it survives the paste: the layout is pinned to fixed (inline, so
 * the sent mail renders it without the editor stylesheet), the `<col>` widths
 * stay and become the schema's colwidth - which is what the column-resize
 * handles edit, and what actually binds under the fixed layout - and `nowrap`
 * is stripped, so a cell whose text wrapped in the source wraps again at the
 * same column width instead of being stretched onto one line.
 * (The previous normalization forced table-layout: auto + nowrap and dropped
 * every width: columns stretched to their longest cell, wrapped source cells
 * came out on one line, and dragging a resize handle did nothing - under the
 * auto layout a colgroup width is only a suggestion the content can outvote.)
 *
 * Cell borders come off instead: the spreadsheet's grid lines are its own
 * look (thick, dashed, missing), and a pasted table whose cells carry them
 * next to a row inserted later with the composer's default border shows two
 * different grids in one table. The composer's default `border: 1px solid
 * #ccc` (TableCell's HTMLAttributes) then styles every cell uniformly.
 */
function applyContentLayout(doc: Document) {
  for (const table of doc.querySelectorAll("table")) {
    stripStyleProperties(table, /^table-layout$/i);
    // The colgroup/cell widths are the grid; a table-level width pin only
    // fights them (and it disables the resize plugin's own width management,
    // which defers to a user width it finds in the table's style).
    stripStyleProperties(table, /^(min-)?width$/i);
    table.removeAttribute("width");
    appendStyle(table, "table-layout: fixed");
  }
  for (const cell of doc.querySelectorAll("td, th")) {
    // The spreadsheet's own grid lines are replaced by the composer's.
    stripStyleProperties(cell, /^border/i);
    stripNoWrap(cell);
  }
}

/**
 * A `nowrap` cell wider than its column would spill its text over the
 * neighbouring cell under the fixed layout. Other white-space values (pre,
 * pre-wrap - deliberate line breaks) stay.
 */
function stripNoWrap(el: Element) {
  const style = el.getAttribute("style");
  if (!style || !/white-space\s*:/i.test(style)) return;
  const kept = style
    .split(";")
    .filter((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon <= 0) return true; // stray fragment, not ours to drop
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      return !(property === "white-space" && /^nowrap/i.test(value));
    })
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  if (kept.length > 0) el.setAttribute("style", kept.join("; "));
  else el.removeAttribute("style");
}

/** Removes whole declarations for the matched properties from an inline style. */
function stripStyleProperties(el: Element, property: RegExp) {
  const style = el.getAttribute("style");
  if (!style) return;
  const kept = style
    .split(";")
    .filter((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon <= 0) return true; // stray fragment, not ours to drop
      return !property.test(declaration.slice(0, colon).trim());
    })
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  if (kept.length > 0) el.setAttribute("style", kept.join("; "));
  else el.removeAttribute("style");
}

/** Sets declarations on el, replacing existing ones for the same property. */
function setStyleDeclarations(el: Element, declarations: string[]) {
  if (declarations.length === 0) return;
  const own = (el.getAttribute("style") || "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  const names = new Set(
    declarations.map((d) => d.slice(0, d.indexOf(":")).trim().toLowerCase()),
  );
  const kept = own.filter((d) => {
    const colon = d.indexOf(":");
    if (colon <= 0) return true;
    return !names.has(d.slice(0, colon).trim().toLowerCase());
  });
  el.setAttribute("style", [...kept, ...declarations].join("; "));
}

/**
 * Merges a background colour into a cell's inline style, replacing any
 * existing background(-color). null clears it; a style left with nothing
 * returns null so the attribute round-trips clean.
 */
function cellBackgroundStyle(style: string | null, color: string | null): string | null {
  const declarations = (style || "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const colon = d.indexOf(":");
      if (colon <= 0) return true;
      const property = d.slice(0, colon).trim().toLowerCase();
      return property !== "background-color" && property !== "background";
    });
  if (color) declarations.push(`background-color: ${color}`);
  return declarations.length > 0 ? declarations.join("; ") : null;
}

/** A style string without the background, text colour and weight
 *  declarations, which would otherwise sit later in the cascade than the
 *  th default look and hide it; null when nothing remains. */
function stripCellLook(style: string | null): string | null {
  const declarations = (style || "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const colon = d.indexOf(":");
      if (colon <= 0) return true;
      return !/^(?:background-color|background|color|font-weight)$/.test(d.slice(0, colon).trim().toLowerCase());
    });
  return declarations.length > 0 ? declarations.join("; ") : null;
}
// Font properties WPS puts on the div wrapping a cell's text instead of the
// cell itself.
const FONT_PROPERTIES = /^(color|font-weight|font-style|font-size|font-family)$/i;

/** The font declarations inside a style string, in order. */
function fontDeclarations(style: string): string[] {
  return style
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const colon = d.indexOf(":");
      return colon > 0 && FONT_PROPERTIES.test(d.slice(0, colon).trim());
    });
}

/**
 * WPS wraps a cell's text in a `<div>` and puts the font colour there (a
 * `.cr1 { color: #ff0000 }` class rule on the div, or a `<font color>`
 * around the text) while the cell itself only carries the background. The
 * div's style is dropped when the schema parses the cell's blocks, so the
 * colour never reached the editor - only the background did. The font
 * declarations move onto the cell's style (the cell carries them to the
 * sent mail too), and a `<font color>` becomes a styled `<span>`, which
 * the textStyle mark parses as an inline colour.
 *
 * Three more places the colour hides, all fixed here:
 * - A wrapper around the whole table (a `<div class=cr>`, or the `<body>`
 *   styled by a tag rule) carries the colour of every cell's text; the
 *   schema drops the wrapper, so its font declarations move onto the
 *   table, where CSS inheritance restores them.
 * - A run-level `<b class=cr>` / `<i>` / `<u>` / `<a>`: the class rule is
 *   inlined onto it, but the textStyle mark only parses `<span>` styles.
 *   The font declarations move onto a span wrapping its children, so both
 *   the formatting mark and the colour survive.
 */
function carryFontStyles(doc: Document) {
  for (const font of Array.from(doc.querySelectorAll("font"))) {
    const span = doc.createElement("span");
    for (const attr of Array.from(font.attributes)) {
      if (attr.name.toLowerCase() === "color") appendStyle(span, `color: ${attr.value}`);
      else span.setAttribute(attr.name, attr.value);
    }
    while (font.firstChild) span.appendChild(font.firstChild);
    font.parentElement?.replaceChild(span, font);
  }
  // Run-level formatting elements: the colour rides on a span so the
  // textStyle mark can parse it, the formatting stays on the element.
  for (const el of Array.from(doc.querySelectorAll("b, strong, i, em, u, s, strike, del, a"))) {
    const carried = fontDeclarations(el.getAttribute("style") || "");
    if (carried.length === 0 || !el.firstChild) continue;
    stripStyleProperties(el, FONT_PROPERTIES);
    const span = doc.createElement("span");
    span.setAttribute("style", carried.join("; "));
    while (el.firstChild) span.appendChild(el.firstChild);
    el.appendChild(span);
  }
  for (const cell of doc.querySelectorAll("td, th")) {
    // WPS emits one div per cell; when there are several, the first one's
    // font declarations stand (they styled the whole cell).
    for (const div of cell.querySelectorAll("div")) {
      const carried = fontDeclarations(div.getAttribute("style") || "");
      if (carried.length === 0) continue;
      stripStyleProperties(div, FONT_PROPERTIES);
      setStyleDeclarations(cell, carried);
      break;
    }
  }
  // A wrapper around the whole table: its font declarations inherit into
  // every cell, but only if they reach an element the schema keeps. Walk
  // the ancestors (nearest first - its value wins per property) and merge
  // them onto the table's style.
  for (const table of Array.from(doc.querySelectorAll("table"))) {
    const carried: string[] = [];
    const seen = new Set<string>();
    for (let el = table.parentElement; el && el !== doc.documentElement; el = el.parentElement) {
      for (const declaration of fontDeclarations(el.getAttribute("style") || "")) {
        const name = declaration.slice(0, declaration.indexOf(":")).trim().toLowerCase();
        if (seen.has(name)) continue;
        seen.add(name);
        carried.push(declaration);
      }
    }
    if (carried.length > 0) setStyleDeclarations(table, carried);
  }
}

/**
 * Moves clipboard class rules onto the elements they style, maps legacy
 * bgcolor/width/height attributes, and returns HTML the table schema can
 * parse with its style attribute. Non-Office HTML without a style block is
 * returned unchanged.
 */
export function inlineClipboardStyles(html: string): string {
  if (!HAS_TABLE.test(html)) return html;
  if (!OFFICE_DOCUMENT.test(html) && !HAS_STYLE_BLOCK.test(html) && !FIXED_LAYOUT.test(html)) return html;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const styleText = Array.from(doc.querySelectorAll("style"))
    .map((style) => style.textContent || "")
    .join("\n");
  const rules = parseStyleRules(styleText);

  if (rules.length > 0) {
    // Every element, not just the table ones: WPS/Excel put the font
    // colour of a cell's text on the wrapping div, a span, a <b class=cr>
    // run, or a div (or the body, via a tag rule) around the whole table.
    // Rules match by class or tag name, so broadening the list only makes
    // the inlining more faithful to CSS. The div's declarations are then
    // carried to the cell (below); runs and wrappers carry in
    // carryFontStyles too.
    //
    // A cell regularly matches two rules at once: the td tag rule every
    // WPS sheet carries (colour, font) AND its own .etN class rule with
    // the real colour. In CSS the class wins (specificity); flattened
    // into one inline style, the LAST declaration of a property wins
    // instead. So the merge order is by priority: tag rules first
    // (weakest), class rules after (later-in-sheet beats earlier within
    // the tier, as in CSS), the element's own inline style last of all -
    // appendStyle prepends, so the tiers are processed weakest-last.
    for (const el of doc.querySelectorAll("*")) {
      const elClass = el.getAttribute("class") || "";
      const classes = elClass.split(/\s+/).filter(Boolean);
      const matched = rules.filter(
        (rule) => rule.tags.includes(el.tagName.toLowerCase()) || classes.some((c) => rule.classes.includes(c)),
      );
      // A rule matched by class outranks a tag-only match; equal
      // specificity keeps sheet order. appendStyle prepends, so each
      // tier is applied in reverse sheet order, and the class tier
      // BEFORE the tag tier: the last-applied rule lands first in the
      // style string, where it is weakest.
      const byClass = matched.filter((rule) => classes.some((c) => rule.classes.includes(c)));
      const byTag = matched.filter((rule) => !byClass.includes(rule));
      for (const rule of [...byClass].reverse()) appendStyle(el, filterDeclarations(rule.declarations));
      for (const rule of [...byTag].reverse()) appendStyle(el, filterDeclarations(rule.declarations));
    }
  }

  expandColSpans(doc);
  applyContentLayout(doc);
  carryFontStyles(doc);
  for (const el of doc.querySelectorAll("table, tr, td, th")) {
    dropInvalidTextAlign(el);
    mapLegacyAttributes(el);
    // The class did its job (its styles are inline now); the schema drops it anyway.
    el.removeAttribute("class");
  }
  // The style block itself would only confuse a second paste of this output.
  doc.querySelectorAll("style").forEach((style) => style.remove());

  return doc.body.innerHTML;
}

/** Command props as tiptap hands them to raw commands (subset we use). */
interface CommandProps {
  state: EditorState;
  tr: Transaction;
  dispatch?: (tr: Transaction) => void;
}

/**
 * Runs a stock insert command, then copies the reference cells' style onto
 * the freshly created cells. The reference is the row/column the cursor is
 * in (the user's "insert above/below/left/right of THIS cell"), so a new
 * cell inside a coloured region of a pasted table keeps the colour.
 *
 * The stock command mutates the chain's shared transaction (tiptap's
 * dispatch is a no-op there; the framework commits the tr); the patch rides
 * along on the same tr. Without a dispatch (can()/dry-run) the stock command
 * gets no dispatch either and mutates nothing.
 */
function insertStyled(
  stock: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean,
  kind: "row" | "column",
  side: "before" | "after",
) {
  return ({ state, dispatch }: CommandProps) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const wrapped = dispatch
      ? (tr: Transaction) => {
          // The transaction has the new row/column; positions inside the
          // table are read off the updated doc before it goes out.
          const table = tr.doc.nodeAt(rect.tableStart - 1);
          if (table) copyStyleToFreshCells(tr, rect, table, kind, side);
          dispatch(tr);
        }
      : undefined;
    return stock(state, wrapped);
  };
}

/**
 * The stock commands create the new cells empty (createAndFill, no attrs).
 * This walks them in the post-insert table and gives each the style of the
 * reference cell in the same column (new row) or row (new column).
 */
function copyStyleToFreshCells(
  tr: Transaction,
  rect: ReturnType<typeof selectedRect>,
  newTable: PMNode,
  kind: "row" | "column",
  side: "before" | "after",
) {
  const map = TableMap.get(newTable);
  if (kind === "row") {
    const insertRow = side === "after" ? rect.bottom : rect.top;
    // "before" shifts the reference row one further down in the new doc.
    const refRow = side === "after" ? rect.bottom - 1 : rect.top + 1;
    if (refRow < 0 || refRow >= map.height) return;
    let rowPos = rect.tableStart;
    for (let i = 0; i < insertRow; i++) rowPos += newTable.child(i).nodeSize;
    const row = newTable.child(insertRow);
    let col = 0;
    row.forEach((cell, offset) => {
      const ref = newTable.nodeAt(map.map[refRow * map.width + col]);
      if (ref?.attrs.style != null) {
        tr.setNodeMarkup(rowPos + 1 + offset, null, { ...cell.attrs, style: ref.attrs.style });
      }
      col += cell.attrs.colspan;
    });
  } else {
    const insertCol = side === "after" ? rect.right : rect.left;
    const refCol = side === "after" ? rect.right - 1 : rect.left + 1;
    if (refCol < 0 || refCol >= map.width) return;
    for (let row = 0; row < map.height; row++) {
      const index = row * map.width + insertCol;
      const pos = map.map[index];
      // A cell that starts here - not a rowspan/colspan continuation from
      // before the insert, which the stock command already extended.
      if (row > 0 && map.map[index - map.width] === pos) continue;
      if (insertCol > 0 && map.map[index - 1] === pos) continue;
      const cell = newTable.nodeAt(pos);
      const ref = newTable.nodeAt(map.map[row * map.width + refCol]);
      if (cell && ref?.attrs.style != null) {
        tr.setNodeMarkup(rect.tableStart + pos, null, { ...cell.attrs, style: ref.attrs.style });
      }
    }
  }
}

/**
 * Pastes Office tables with their styling: the clipboard HTML is normalized
 * (class rules inlined, legacy attributes mapped) before the editor's schema
 * parses it, and the styled table nodes keep what they parsed on edit and on
 * send.
 */
export const TablePaste = Extension.create({
  name: "tablePaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("tablePaste"),
        props: {
          transformPastedHTML: (html: string) => inlineClipboardStyles(html),
        },
      }),
    ];
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tablePaste: {
      /** Sets/clears the background colour of the selected cells. */
      setCellBackground: (color: string | null) => ReturnType;
      /** Toggles the header row, clearing pasted cell colours when it turns on. */
      toggleHeaderRowStyled: () => ReturnType;
    };
  }
}
