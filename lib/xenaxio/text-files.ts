// Xenaxio step 115, part 2: every text file opens in the editor, shown by its
// kind - Markdown as on GitHub, CSV as a table, JSON formatted, HTML as a page
// in a locked frame, code and settings files highlighted, the rest as text.
// Links are clickable in every view.
import { getFilePreviewKind } from "@/lib/file-preview";
import { languageOf } from "@/lib/xenaxio/chat/snippet";

/** Bigger files open in the read-only preview, as before. */
export const TEXT_EDIT_MAX_BYTES = 1024 * 1024;

export type TextKind = "markdown" | "csv" | "json" | "html" | "code" | "plain";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A file the editor opens: any text file the app knows, up to 1 MB. */
export function isTextFile(name: string, size?: number): boolean {
  const kind = getFilePreviewKind(name);
  if (kind !== "text" && kind !== "markdown" && kind !== "html") return false;
  return size === undefined || size <= TEXT_EDIT_MAX_BYTES;
}

export function textKindOf(name: string): TextKind {
  const ext = extensionOf(name);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "json") return "json";
  if (ext === "html" || ext === "htm") return "html";
  return codeLanguageOf(name) ? "code" : "plain";
}

/** The highlight.js language of a code or settings file, or null for text. */
export function codeLanguageOf(name: string): string | null {
  const ext = extensionOf(name);
  if (ext === "cjs") return "javascript";
  const lang = languageOf(ext);
  return lang && lang !== "plaintext" && lang !== "markdown" ? lang : null;
}

/** The type a new file of this name is stored with. */
export function textContentType(name: string): string {
  switch (extensionOf(name)) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "csv":
      return "text/csv";
    case "tsv":
      return "text/tab-separated-values";
    case "json":
      return "application/json";
    case "html":
    case "htm":
      return "text/html";
    case "xml":
      return "application/xml";
    default:
      return "text/plain";
  }
}

// ---- CSV ---------------------------------------------------------------------

/** The separator of a CSV: tab, ";" (usual in Germany) or ",", whichever the first line has most of. */
export function csvSeparator(text: string, name = ""): string {
  if (extensionOf(name) === "tsv") return "\t";
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => firstLine.split(c).length - 1;
  const candidates = ["\t", ";", ","];
  let best = ",";
  let most = 0;
  for (const c of candidates) {
    const n = count(c);
    if (n > most) {
      most = n;
      best = c;
    }
  }
  return best;
}

/** Rows of a CSV, with quoted fields ("a ""b""", line breaks inside quotes). */
export function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === separator) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---- JSON --------------------------------------------------------------------

export type JsonCheck = { ok: true; pretty: string } | { ok: false; line: number | null; message: string };

/** Formatted JSON, or the line where it is broken. */
export function checkJson(text: string): JsonCheck {
  try {
    return { ok: true, pretty: JSON.stringify(JSON.parse(text), null, 2) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Browsers word the error differently and not all of them say where it
    // is; a small scan of our own finds the place.
    const at = jsonErrorAt(text);
    return { ok: false, line: at === null ? null : text.slice(0, at).split("\n").length, message };
  }
}

/** Index of the first character where `text` stops being JSON (null if it is JSON). */
export function jsonErrorAt(text: string): number | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const literal = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail();
  };
  const string = () => {
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        i++;
        if (text[i] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail();
          i += 4;
        } else if (!'"\\/bfnrt'.includes(text[i] ?? "")) fail();
      } else if (text.charCodeAt(i) < 0x20) fail();
      i++;
    }
    if (i >= text.length) fail();
    i++;
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m || !m[0] || m[0] === "-") fail();
    i += (m as RegExpExecArray)[0].length;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        string();
        ws();
        if (text[i] !== ":") fail();
        i++;
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") {
          i++;
          return;
        } else fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") {
          i++;
          return;
        } else fail();
      }
    }
    if (c === '"') return string();
    if (c === "t") return literal("true");
    if (c === "f") return literal("false");
    if (c === "n") return literal("null");
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return number();
    fail();
  };
  try {
    value();
    ws();
    return i < text.length ? i : null;
  } catch (at) {
    return typeof at === "number" ? Math.min(at, text.length) : null;
  }
}

// ---- Links -------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/g;

/** Text split into plain pieces and http(s) links. */
export function splitLinks(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: m[0], href: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/**
 * Highlighted code (highlight.js HTML, already escaped) with its URLs as
 * links. Only text nodes are touched; every link gets an http(s) address and
 * opens in a new tab.
 */
export function linkifyHtml(html: string): string {
  // A template is inert: nothing in it loads or runs while it is worked on.
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const box = tpl.content;
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const parts = splitLinks(node.data);
    if (parts.length === 1 && !parts[0].href) continue;
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if (!p.href) {
        frag.append(p.text);
        continue;
      }
      const a = document.createElement("a");
      a.href = p.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      a.textContent = p.text;
      frag.append(a);
    }
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}
