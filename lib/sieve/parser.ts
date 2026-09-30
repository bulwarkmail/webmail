import type {
  FilterAction,
  FilterCondition,
  FilterComparator,
  FilterConditionField,
  FilterMetadata,
  FilterRule,
  VacationSieveConfig,
} from '@/lib/jmap/sieve-types';
import { debug } from '@/lib/debug';

export interface ParseResult {
  rules: FilterRule[];
  isOpaque: boolean;
  vacation?: VacationSieveConfig;
  externalRequires: string[];
  /** The script runs the server's "vacation" script via `include`. */
  includeVacation?: boolean;
}

const OPAQUE: ParseResult = { rules: [], isOpaque: true, externalRequires: [] };

const METADATA_BEGIN = '/* @metadata:begin';
const METADATA_END = '@metadata:end */';

const NEXTCLOUD_BLOCK_MARKER = "### Nextcloud Mail: Filters ### DON'T EDIT ###";

const BULWARK_EXTERNAL_HEADER_RE =
  /^[ \t]*#[ \t]*---[ \t]*External rules \(managed outside Bulwark\)[ \t]*---[ \t]*\r?\n/m;

const FIELD_FROM_HEADER: Record<string, FilterConditionField> = {
  from: 'from',
  to: 'to',
  cc: 'cc',
  subject: 'subject',
};

function isValidCondition(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const cond = c as Record<string, unknown>;
  if (typeof cond.field !== 'string' || typeof cond.comparator !== 'string') return false;
  // value may be a string OR a non-empty array of strings (Patch 11
  // multi-value semantics). Accept both.
  if (typeof cond.value === 'string') return true;
  return Array.isArray(cond.value) && cond.value.every((v) => typeof v === 'string');
}

function isValidAction(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const act = a as Record<string, unknown>;
  return typeof act.type === 'string';
}

function isValidRule(rule: unknown): rule is FilterRule {
  if (!rule || typeof rule !== 'object') return false;
  const r = rule as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.enabled !== 'boolean' ||
    (r.matchType !== 'all' && r.matchType !== 'any') ||
    !Array.isArray(r.conditions) ||
    !Array.isArray(r.actions) ||
    typeof r.stopProcessing !== 'boolean'
  ) return false;

  return r.conditions.every(isValidCondition) && r.actions.every(isValidAction);
}

/**
 * Detect Stalwart-generated vacation-only scripts (no metadata).
 */
function detectVacationOnlyScript(content: string): ParseResult | null {
  if (!/\bvacation\b/.test(content)) return null;

  const stripped = content
    .replace(/^\s*require\s+\[[^\]]*\]\s*;/gm, '')
    .replace(/#[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  const structural = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""');

  if (/\b(?:if|elsif|else)\b/.test(structural)) return null;
  if (!/\bvacation\b/.test(structural)) return null;

  const subjectMatch = stripped.match(/:subject\s+"((?:[^"\\]|\\.)*)"/);
  const subject = subjectMatch ? unescapeSieveString(subjectMatch[1]) : '';

  let textBody = '';
  const mimeBodyMatch = stripped.match(/Content-Transfer-Encoding:[^\r\n]*\r?\n\r?\n([\s\S]*?)"[\s\S]*?;/);
  if (mimeBodyMatch) {
    textBody = mimeBodyMatch[1].trim();
  } else {
    const allQuoted = [...stripped.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
    const last = allQuoted[allQuoted.length - 1];
    if (last) textBody = unescapeSieveString(last[1]);
  }

  return {
    rules: [],
    isOpaque: false,
    vacation: { isEnabled: true, subject, textBody },
    externalRequires: [],
  };
}

function unescapeSieveString(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

function skipStringLit(s: string, i: number): number {
  i++;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '"') return i + 1;
    i++;
  }
  return i;
}

function skipHashComment(s: string, i: number): number {
  while (i < s.length && s[i] !== '\n') i++;
  return i;
}

function skipBlockComment(s: string, i: number): number {
  const end = s.indexOf('*/', i + 2);
  return end === -1 ? s.length : end + 2;
}

function skipStatement(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i = skipStringLit(s, i); continue; }
    if (c === '#') { i = skipHashComment(s, i); continue; }
    if (c === '/' && s[i + 1] === '*') { i = skipBlockComment(s, i); continue; }
    if (c === ';') return i + 1;
    i++;
  }
  return i;
}

function skipBalanced(s: string, i: number, open: string, close: string): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i = skipStringLit(s, i); continue; }
    if (c === '#') { i = skipHashComment(s, i); continue; }
    if (c === '/' && s[i + 1] === '*') { i = skipBlockComment(s, i); continue; }
    if (c === open) { depth++; i++; continue; }
    if (c === close) {
      depth--;
      i++;
      if (depth === 0) return i;
      continue;
    }
    i++;
  }
  return i;
}

function skipIfStatement(s: string, i: number): number {
  // positioned after 'if' keyword; skip through condition expression and body braces
  while (i < s.length && s[i] !== '{') {
    const c = s[i];
    if (c === '"') { i = skipStringLit(s, i); continue; }
    if (c === '(') { i = skipBalanced(s, i, '(', ')'); continue; }
    if (c === '#') { i = skipHashComment(s, i); continue; }
    if (c === '/' && s[i + 1] === '*') { i = skipBlockComment(s, i); continue; }
    i++;
  }
  if (i >= s.length) return i;
  return skipBalanced(s, i, '{', '}');
}

interface TopBlock {
  kind: 'require' | 'if' | 'vacation' | 'other';
  raw: string;          // from start-of-leading-text to end of statement
  statement: string;    // the statement itself (no leading comments/whitespace)
  startIdx: number;
  endIdx: number;
}

function scanTopLevel(content: string): TopBlock[] {
  const blocks: TopBlock[] = [];
  let i = 0;
  let segmentStart = 0;

  const consume = (kind: TopBlock['kind'], stmtStart: number, stmtEnd: number) => {
    blocks.push({
      kind,
      raw: content.slice(segmentStart, stmtEnd),
      statement: content.slice(stmtStart, stmtEnd),
      startIdx: segmentStart,
      endIdx: stmtEnd,
    });
    segmentStart = stmtEnd;
  };

  while (i < content.length) {
    // Skip whitespace
    while (i < content.length && /\s/.test(content[i])) i++;
    if (i >= content.length) break;

    const c = content[i];

    // Comments (stay attached to next block as leading text)
    if (c === '#') { i = skipHashComment(content, i); continue; }
    if (c === '/' && content[i + 1] === '*') { i = skipBlockComment(content, i); continue; }

    // Identifier
    const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(content.slice(i));
    if (!m) { i++; continue; }

    const ident = m[0];
    const stmtStart = i;
    i += ident.length;

    if (ident === 'require') {
      i = skipStatement(content, i);
      consume('require', stmtStart, i);
    } else if (ident === 'if') {
      i = skipIfStatement(content, i);
      consume('if', stmtStart, i);
    } else if (ident === 'vacation') {
      i = skipStatement(content, i);
      consume('vacation', stmtStart, i);
    } else {
      i = skipStatement(content, i);
      consume('other', stmtStart, i);
    }
  }

  return blocks;
}

function extractRequireTokens(stmt: string): string[] {
  const mList = /require\s+\[([\s\S]*?)\]\s*;/.exec(stmt);
  if (mList) return [...mList[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  const mSingle = /require\s+"([^"]+)"\s*;/.exec(stmt);
  return mSingle ? [mSingle[1]] : [];
}

/**
 * Extract the last contiguous block of comments immediately preceding a
 * statement - comments separated from the statement by a blank line are not
 * considered its leading commentary (they likely belong to the previous
 * block, e.g. a trailing "# Nextcloud Mail - end" marker).
 */
function lastCommentChunk(leading: string): string {
  const parts = leading.split(/\r?\n\s*\r?\n/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function detectOriginLabel(leading: string): string {
  const chunk = lastCommentChunk(leading);
  const lower = chunk.toLowerCase();
  if (/rule:\s*\[/i.test(chunk) || /roundcube|managesieve/.test(lower)) return 'Roundcube';
  if (/nextcloud/.test(lower)) return 'Nextcloud';
  if (/horde|ingo/.test(lower)) return 'Horde';
  if (/kolab/.test(lower)) return 'Kolab';
  if (/dovecot/.test(lower)) return 'Dovecot';
  if (/thunderbird/.test(lower)) return 'Thunderbird';
  return 'External';
}

function extractName(leading: string, fallback: string): string {
  // Roundcube: "# rule:[Name]"
  const rc = leading.match(/#\s*rule:\s*\[([^\]]+)\]/i);
  if (rc) return rc[1].trim();

  // "# Rule: Name"
  const rr = leading.match(/#\s*Rule:\s*(.+?)\s*$/mi);
  if (rr) return rr[1].trim();

  // Last non-empty trimmed comment line
  const lines = leading.split('\n').map(l => l.replace(/^\s*#\s*/, '').trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last && last.length <= 80 && !/^\/\*|\*\/$/.test(last)) return last;

  return fallback;
}

function splitTopLevelComma(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i = skipStringLit(s, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
    if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(s.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

function splitStatements(body: string): string[] {
  const stmts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"') { i = skipStringLit(body, i); continue; }
    if (c === '#') { i = skipHashComment(body, i); continue; }
    if (c === '/' && body[i + 1] === '*') { i = skipBlockComment(body, i); continue; }
    if (c === ';') {
      stmts.push(body.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  const tail = body.slice(start).trim();
  if (tail) stmts.push(tail);
  return stmts.map(s => s.trim()).filter(Boolean);
}

function normalizeHeaderName(name: string): { field: FilterConditionField; headerName?: string } {
  const lc = name.toLowerCase();
  if (FIELD_FROM_HEADER[lc]) return { field: FIELD_FROM_HEADER[lc] };
  return { field: 'header', headerName: name };
}

function parseAtom(raw: string): FilterCondition | null {
  let s = raw.trim();
  let negated = false;

  if (/^not\b/.test(s)) {
    negated = true;
    s = s.replace(/^not\s*/, '').trim();
    if (s.startsWith('(') && s.endsWith(')')) {
      s = s.slice(1, -1).trim();
    }
  }

  // Parse the value-tail of a header/body test: either a single quoted
  // string or a Sieve list literal ["a", "b", ...]. Returns the unwrapped
  // value(s), preserving the array shape when present so the caller can
  // detect multi-value conditions.
  const parseValueTail = (raw: string): string | string[] | null => {
    const trimmed = raw.trim();
    // List form
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1);
      const items: string[] = [];
      const re = /"((?:[^"\\]|\\.)*)"/g;
      let mm: RegExpExecArray | null;
      let cursor = 0;
      while ((mm = re.exec(inner)) !== null) {
        // Ensure only whitespace and commas appear between items
        if (inner.slice(cursor, mm.index).replace(/[\s,]/g, '') !== '') return null;
        items.push(unescapeSieveString(mm[1]));
        cursor = mm.index + mm[0].length;
      }
      if (inner.slice(cursor).replace(/[\s,]/g, '') !== '') return null;
      if (items.length === 0) return null;
      return items.length === 1 ? items[0] : items;
    }
    // Single string form
    const single = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
    if (single) return unescapeSieveString(single[1]);
    return null;
  };

  // Classify a :matches value (or values) into starts_with / ends_with /
  // matches by inspecting wildcard positions. For multi-value, all items
  // must share the same shape; otherwise we fall back to 'matches' and
  // keep the wildcards verbatim.
  const classifyMatches = (
    values: string | string[],
  ): { comparator: 'starts_with' | 'ends_with' | 'matches'; stripped: string | string[] } => {
    const arr = Array.isArray(values) ? values : [values];
    const isTrailing = (v: string) => {
      const stars = [...v].filter((c) => c === '*').length;
      return stars === 1 && v.endsWith('*');
    };
    const isLeading = (v: string) => {
      const stars = [...v].filter((c) => c === '*').length;
      return stars === 1 && v.startsWith('*');
    };
    if (arr.every(isTrailing)) {
      const stripped = arr.map((v) => v.slice(0, -1));
      return { comparator: 'starts_with', stripped: Array.isArray(values) ? stripped : stripped[0] };
    }
    if (arr.every(isLeading)) {
      const stripped = arr.map((v) => v.slice(1));
      return { comparator: 'ends_with', stripped: Array.isArray(values) ? stripped : stripped[0] };
    }
    return { comparator: 'matches', stripped: values };
  };

  // Match attachment-aware :mime :anychild tests before the generic header
  // pattern - emitted by our own generator for field === 'attachment'.
  // has_any: ":contains Content-Disposition attachment"
  let m = /^header\s+:mime\s+:anychild\s+:contains\s+"Content-Disposition"\s+"attachment"$/.exec(s);
  if (m) {
    return { field: 'attachment', comparator: 'has_any', value: '' };
  }
  // has_type: ":matches <headers> <value-tail>"
  // - Current emit form uses a header-list ["Content-Disposition", "Content-Type"]
  //   to catch senders who put the filename only in Content-Type's name= param
  //   (Microsoft SMTPSVC, PrintToMail.net, etc.).
  // - Legacy emit form used a single "Content-Disposition" header - still
  //   recognised here so rules saved before the fix remain editable.
  // Each value item must be a "*.<ext>*" wildcard pattern.
  const tryHasType = (rawHeaders: string, rawValue: string): FilterCondition | null => {
    // Header part: accept either a single quoted string or a 2-element list
    // containing exactly Content-Disposition + Content-Type (in any order).
    const single = /^"Content-Disposition"$/.exec(rawHeaders.trim());
    const listForm = /^\[\s*((?:"(?:[^"\\]|\\.)*"\s*,?\s*)+)\]$/.exec(rawHeaders.trim());
    let headersOk = false;
    if (single) {
      headersOk = true;
    } else if (listForm) {
      const inner = listForm[1];
      const items: string[] = [];
      const re = /"((?:[^"\\]|\\.)*)"/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(inner)) !== null) items.push(unescapeSieveString(mm[1]));
      const expected = new Set(['Content-Disposition', 'Content-Type']);
      const got = new Set(items);
      headersOk =
        items.length === expected.size &&
        [...expected].every((h) => got.has(h));
    }
    if (!headersOk) return null;
    const tail = parseValueTail(rawValue);
    if (tail === null) return null;
    const arr = Array.isArray(tail) ? tail : [tail];
    const exts: string[] = [];
    for (const item of arr) {
      const em = /^\*\.((?:[^*\\]|\\.)+)\*$/.exec(item);
      if (!em) return null;
      exts.push(unescapeSieveString(em[1]));
    }
    return { field: 'attachment', comparator: 'has_type', value: exts.length === 1 ? exts[0] : exts };
  };
  m = /^header\s+:mime\s+:anychild\s+:matches\s+(\[[\s\S]+?\]|"[^"]+")\s+([\s\S]+)$/.exec(s);
  if (m) {
    const result = tryHasType(m[1], m[2]);
    if (result) return result;
  }
  // Unknown :mime :anychild pattern (e.g. from external scripts) - bail to
  // opaque rendering so we don't silently misrepresent the script.
  if (/^header\s+:mime\s+:anychild\b/.test(s)) {
    return null;
  }

  m = /^header\s+:(contains|is|matches)\s+"((?:[^"\\]|\\.)*)"\s+([\s\S]+)$/.exec(s);
  if (m) {
    const [, tag, headerName, rawTail] = m;
    const value = parseValueTail(rawTail);
    if (value === null) return null;
    const { field, headerName: customHeaderName } = normalizeHeaderName(unescapeSieveString(headerName));

    let comparator: FilterComparator;
    let finalValue: string | string[];
    if (tag === 'contains') {
      comparator = negated ? 'not_contains' : 'contains';
      finalValue = value;
    } else if (tag === 'is') {
      comparator = negated ? 'not_is' : 'is';
      finalValue = value;
    } else {
      const classified = classifyMatches(value);
      comparator = classified.comparator;
      finalValue = classified.stripped;
    }

    const cond: FilterCondition = { field, comparator, value: finalValue };
    if (customHeaderName !== undefined) cond.headerName = customHeaderName;
    return cond;
  }

  m = /^body\s+:(contains|is)\s+([\s\S]+)$/.exec(s);
  if (m) {
    const value = parseValueTail(m[2]);
    if (value === null) return null;
    return { field: 'body', comparator: m[1] === 'is' ? 'is' : 'contains', value };
  }

  m = /^size\s+:(over|under)\s+(\d+)$/.exec(s);
  if (m) {
    return { field: 'size', comparator: m[1] === 'over' ? 'greater_than' : 'less_than', value: m[2] };
  }

  return null;
}

function parseCondition(raw: string): { matchType: 'all' | 'any'; conditions: FilterCondition[] } | null {
  const s = raw.trim();
  if (!s) return null;

  const allMatch = /^allof\s*\(([\s\S]*)\)$/.exec(s);
  const anyMatch = /^anyof\s*\(([\s\S]*)\)$/.exec(s);
  let matchType: 'all' | 'any' = 'all';
  let inner: string;
  if (allMatch) { matchType = 'all'; inner = allMatch[1]; }
  else if (anyMatch) { matchType = 'any'; inner = anyMatch[1]; }
  else inner = s;

  const parts = splitTopLevelComma(inner);
  const conditions: FilterCondition[] = [];
  for (const part of parts) {
    const atom = parseAtom(part);
    if (!atom) return null;
    conditions.push(atom);
  }
  return { matchType, conditions };
}

function parseAction(raw: string): FilterAction | null {
  const s = raw.trim();

  let m = /^fileinto\s+:copy\s+"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) return { type: 'copy', value: unescapeSieveString(m[1]) };

  m = /^fileinto\s+"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) return { type: 'move', value: unescapeSieveString(m[1]) };

  m = /^fileinto\s+(:copy\s+)?:mailboxid\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) {
    return {
      type: m[1] ? 'copy' : 'move',
      value: unescapeSieveString(m[3]),
      mailboxId: unescapeSieveString(m[2]),
    };
  }

  m = /^redirect\s+(:copy\s+)?"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) {
    const action: FilterAction = { type: 'forward', value: unescapeSieveString(m[2]) };
    if (m[1]) action.keepCopy = true;
    return action;
  }

  m = /^addflag\s+"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) {
    const flag = unescapeSieveString(m[1]);
    if (flag === '\\Seen') return { type: 'mark_read' };
    if (flag === '\\Flagged') return { type: 'star' };
    if (flag.startsWith('$label:')) return { type: 'add_label', value: flag.slice('$label:'.length) };
    return null;
  }

  m = /^reject\s+"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) return { type: 'reject', value: unescapeSieveString(m[1]) };

  if (/^discard$/.test(s)) return { type: 'discard' };
  if (/^keep$/.test(s)) return { type: 'keep' };
  if (/^stop$/.test(s)) return { type: 'stop' };

  return null;
}

function findBodyOpenBrace(s: string): number {
  // Locate the first `{` that introduces the if-block body, skipping over
  // string literals and comments. A naive indexOf('{') would otherwise pick
  // up braces inside condition values (e.g. `:contains "{foo}"`).
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') { i = skipStringLit(s, i); continue; }
    if (c === '#') { i = skipHashComment(s, i); continue; }
    if (c === '/' && s[i + 1] === '*') { i = skipBlockComment(s, i); continue; }
    if (c === '{') return i;
    i++;
  }
  return -1;
}

function parseIfBlockToRule(block: TopBlock, idPrefix: string, index: number): FilterRule | null {
  const stmt = block.statement;
  const afterIf = stmt.replace(/^if\s+/, '');
  const braceIdx = findBodyOpenBrace(afterIf);
  // scanTopLevel's skipIfStatement uses balanced-brace scanning, so the
  // statement always terminates at the matching `}`.
  const lastBraceIdx = afterIf.length - 1;
  if (braceIdx === -1 || afterIf[lastBraceIdx] !== '}' || lastBraceIdx < braceIdx) return null;

  const condStr = afterIf.slice(0, braceIdx).trim();
  const bodyStr = afterIf.slice(braceIdx + 1, lastBraceIdx).trim();

  const cond = parseCondition(condStr);
  if (!cond || cond.conditions.length === 0) return null;

  const actionStmts = splitStatements(bodyStr);
  const actions: FilterAction[] = [];
  for (const st of actionStmts) {
    const a = parseAction(st);
    if (!a) return null;
    actions.push(a);
  }
  if (actions.length === 0) return null;

  let stopProcessing = false;
  if (actions.length > 0 && actions[actions.length - 1].type === 'stop') {
    const hasNonStop = actions.some(a => a.type !== 'stop');
    if (hasNonStop) {
      stopProcessing = true;
      actions.pop();
    }
  }

  const leading = block.raw.slice(0, block.statement ? block.raw.length - block.statement.length : 0);
  const originLabel = detectOriginLabel(leading);
  const name = extractName(leading, `Rule ${index + 1}`);

  return {
    id: `${idPrefix}-${index}`,
    name,
    enabled: true,
    matchType: cond.matchType,
    conditions: cond.conditions,
    actions,
    stopProcessing,
    origin: 'external',
    originLabel,
    rawBlock: block.raw,
  };
}

function makeOpaqueRule(block: TopBlock, idPrefix: string, index: number): FilterRule {
  const leading = block.raw.slice(0, block.raw.length - block.statement.length);
  const originLabel = detectOriginLabel(leading);
  const name = extractName(leading, `External rule ${index + 1}`);
  return {
    id: `${idPrefix}-${index}`,
    name,
    enabled: true,
    matchType: 'all',
    conditions: [],
    actions: [],
    stopProcessing: false,
    origin: 'opaque',
    originLabel,
    rawBlock: block.raw,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Nextcloud Mail wraps its managed filter region with a pair of
 * `### Nextcloud Mail: Filters ### DON'T EDIT ###` markers and typically
 * emits two such regions - one enclosing its own `require [...]` line and
 * another enclosing the if-blocks it generates from its `# FILTER: [...]`
 * JSON comments. Parsing the interior blocks individually loses the outer
 * markers (causing later rules to fall back to "External") and mis-attaches
 * them to neighboring blocks on round-trip.
 *
 * Treat each marker-pair as one opaque external rule so the whole region
 * round-trips verbatim, merge any require tokens into the top-level list,
 * and drop regions that carry nothing but a require (their extensions are
 * already represented in the merged require line).
 */
function extractNextcloudRegions(content: string): {
  cleaned: string;
  rules: FilterRule[];
  requires: string[];
} {
  const marker = NEXTCLOUD_BLOCK_MARKER;
  const positions: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = content.indexOf(marker, searchFrom);
    if (idx === -1) break;
    const atLineStart = idx === 0 || content[idx - 1] === '\n';
    if (atLineStart) positions.push(idx);
    searchFrom = idx + marker.length;
  }

  if (positions.length < 2) {
    return { cleaned: content, rules: [], requires: [] };
  }

  const rules: FilterRule[] = [];
  const requires: string[] = [];
  const markerRe = new RegExp(escapeRegex(marker), 'g');

  let cleaned = '';
  let cursor = 0;

  for (let i = 0; i + 1 < positions.length; i += 2) {
    const start = positions[i];
    const closeStart = positions[i + 1];
    const lineEnd = content.indexOf('\n', closeStart + marker.length);
    const end = lineEnd === -1 ? content.length : lineEnd + 1;

    cleaned += content.slice(cursor, start);
    const raw = content.slice(start, end);

    for (const m of raw.matchAll(/require\s+\[([\s\S]*?)\]\s*;/g)) {
      for (const tok of m[1].matchAll(/"([^"]+)"/g)) {
        if (!requires.includes(tok[1])) requires.push(tok[1]);
      }
    }
    const singleReq = /require\s+"([^"]+)"\s*;/.exec(raw);
    if (singleReq && !requires.includes(singleReq[1])) requires.push(singleReq[1]);

    const stripped = raw
      .replace(markerRe, '')
      .replace(/require\s+\[[\s\S]*?\]\s*;/g, '')
      .replace(/require\s+"[^"]+"\s*;/g, '')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/#[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();

    if (stripped.length > 0) {
      rules.push({
        id: `nextcloud-${rules.length}`,
        name: 'Nextcloud Mail filters',
        enabled: true,
        matchType: 'all',
        conditions: [],
        actions: [],
        stopProcessing: false,
        origin: 'opaque',
        originLabel: 'Nextcloud',
        rawBlock: raw,
      });
    }

    cursor = end;
  }

  cleaned += content.slice(cursor);
  return { cleaned, rules, requires };
}

function stripBulwarkExternalHeader(content: string): string {
  return content.replace(BULWARK_EXTERNAL_HEADER_RE, '');
}

function parseExternalRules(
  content: string,
  idPrefix: string,
): { rules: FilterRule[]; externalRequires: string[]; hasContent: boolean } {
  const blocks = scanTopLevel(content);
  const rules: FilterRule[] = [];
  const externalRequires: string[] = [];
  let index = 0;
  let sawAnyStatement = false;

  for (const block of blocks) {
    if (block.kind === 'require') {
      sawAnyStatement = true;
      for (const tok of extractRequireTokens(block.statement)) {
        if (!externalRequires.includes(tok)) externalRequires.push(tok);
      }
      continue;
    }

    if (block.kind === 'if') {
      sawAnyStatement = true;
      const rule = parseIfBlockToRule(block, idPrefix, index);
      rules.push(rule ?? makeOpaqueRule(block, idPrefix, index));
      index++;
      continue;
    }

    // vacation/other: treat as opaque preserved block
    sawAnyStatement = true;
    rules.push(makeOpaqueRule(block, idPrefix, index));
    index++;
  }

  return { rules, externalRequires, hasContent: sawAnyStatement };
}

export function parseScript(content: string): ParseResult {
  const beginIdx = content.indexOf(METADATA_BEGIN);

  if (beginIdx !== -1) {
    const endIdx = content.indexOf(METADATA_END, beginIdx);
    if (endIdx === -1) return OPAQUE;

    const jsonStart = beginIdx + METADATA_BEGIN.length;
    const jsonStr = content.slice(jsonStart, endIdx).trim();

    let metadata: FilterMetadata;
    try {
      metadata = JSON.parse(jsonStr);
    } catch (e) {
      debug.warn('filters', 'Failed to parse Sieve metadata JSON:', e);
      return OPAQUE;
    }

    if (!metadata || metadata.version !== 1) return OPAQUE;
    if (!Array.isArray(metadata.rules)) return OPAQUE;

    for (const rule of metadata.rules) {
      if (!isValidRule(rule)) return OPAQUE;
    }

    // Scan the portion AFTER the metadata block for external rules. A prior
    // Bulwark save may have emitted its "External rules" header here; strip
    // it so it does not get re-attached to the first external rule's rawBlock
    // and written out twice on the next save.
    const afterMetadata = stripBulwarkExternalHeader(
      content.slice(endIdx + METADATA_END.length),
    );
    const nextcloud = extractNextcloudRegions(afterMetadata);
    const external = parseExternalRules(nextcloud.cleaned, 'ext');

    // Parsed bulwark rules intentionally omit an explicit `origin` field so
    // round-trip equality with metadata-only callers holds. Absence of origin
    // is treated as 'bulwark' everywhere downstream.
    const bulwarkRules: FilterRule[] = metadata.rules;

    let externalRequires = [
      ...external.externalRequires,
      ...nextcloud.requires.filter(r => !external.externalRequires.includes(r)),
    ];

    // Drop any external "rules" that are really the bulwark-managed if-blocks or vacation.
    // Recognizable by the leading comment "# Rule: <name>" or "# Vacation auto-reply".
    // This applies regardless of whether the block parsed as a structured rule or
    // fell back to opaque - a Bulwark-emitted block may fail to round-trip cleanly
    // (e.g. a value with literal braces) but the `# Rule: <name>` marker still
    // identifies it as ours.
    const filteredExternal = external.rules.filter(r => {
      const raw = r.rawBlock || '';
      const match = raw.match(/#\s*Rule:\s*(.+?)\s*$/m);
      if (match) {
        const name = match[1].trim();
        if (bulwarkRules.some(b => b.name === name)) return false;
      }
      if (/#\s*Vacation auto-reply/i.test(raw)) return false;
      return true;
    });

    // "include" belongs to the vacation include, which the generator adds
    // back on its own; keep it only if an external rule uses it too, so that
    // turning the auto-reply off drops it from the script.
    const otherRules = [...nextcloud.rules, ...filteredExternal];
    if (!otherRules.some(r => /\binclude\b/.test(r.rawBlock || ''))) {
      externalRequires = externalRequires.filter(r => r !== 'include');
    }

    return {
      rules: [...bulwarkRules, ...otherRules],
      isOpaque: false,
      vacation: metadata.vacation,
      externalRequires,
      ...(metadata.includeVacation === true ? { includeVacation: true } : {}),
    };
  }

  // No metadata - check vacation-only first
  const vacationOnly = detectVacationOnlyScript(content);
  if (vacationOnly) return vacationOnly;

  // Extract Nextcloud-managed marker regions first so their interior is not
  // parsed as a series of loose if-blocks (which would lose the outer markers
  // and mis-label later blocks as generic "External").
  const nextcloud = extractNextcloudRegions(content);
  const external = parseExternalRules(nextcloud.cleaned, 'ext');

  const allRules = [...nextcloud.rules, ...external.rules];
  const allRequires = [
    ...external.externalRequires,
    ...nextcloud.requires.filter(r => !external.externalRequires.includes(r)),
  ];

  if (!external.hasContent && allRules.length === 0) {
    // Entirely empty or whitespace/comments only - treat as empty, editable.
    // Preserve any require tokens lifted out of Nextcloud marker regions so
    // they can be re-emitted in the top-level require line.
    return { rules: [], isOpaque: false, externalRequires: allRequires };
  }

  // If at least one block parsed into a structured rule, expose them as external.
  const anyParsed = external.rules.some(r => r.origin === 'external');
  if (anyParsed || allRules.length > 0) {
    return { rules: allRules, isOpaque: false, externalRequires: allRequires };
  }

  return OPAQUE;
}
