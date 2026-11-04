import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";

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
 */
export const StyledTable = Table.extend({
  addAttributes() {
    return { ...this.parent?.(), style: styleAttr };
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
    for (const el of doc.querySelectorAll("table, tr, td, th, col, colgroup")) {
      const elClass = el.getAttribute("class") || "";
      const classes = elClass.split(/\s+/).filter(Boolean);
      const matched = rules.filter(
        (rule) => rule.tags.includes(el.tagName.toLowerCase()) || classes.some((c) => rule.classes.includes(c)),
      );
      for (const rule of matched) appendStyle(el, filterDeclarations(rule.declarations));
    }
  }

  expandColSpans(doc);
  applyContentLayout(doc);
  for (const el of doc.querySelectorAll("table, tr, td, th")) {
    mapLegacyAttributes(el);
    // The class did its job (its styles are inline now); the schema drops it anyway.
    el.removeAttribute("class");
  }
  // The style block itself would only confuse a second paste of this output.
  doc.querySelectorAll("style").forEach((style) => style.remove());

  return doc.body.innerHTML;
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
