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
}

const OPAQUE: ParseResult = { rules: [], isOpaque: true, externalRequires: [] };

const METADATA_BEGIN = '/* @metadata:begin';
const METADATA_END = '@metadata:end */';

const FIELD_FROM_HEADER: Record<string, FilterConditionField> = {
  from: 'from',
  to: 'to',
  cc: 'cc',
  subject: 'subject',
};

function isValidCondition(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const cond = c as Record<string, unknown>;
  return typeof cond.field === 'string' && typeof cond.comparator === 'string' && typeof cond.value === 'string';
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
 * statement — comments separated from the statement by a blank line are not
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

  let m = /^header\s+:(contains|is|matches)\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) {
    const [, tag, headerName, rawValue] = m;
    const value = unescapeSieveString(rawValue);
    const { field, headerName: customHeaderName } = normalizeHeaderName(unescapeSieveString(headerName));

    let comparator: FilterComparator;
    if (tag === 'contains') {
      comparator = negated ? 'not_contains' : 'contains';
    } else if (tag === 'is') {
      comparator = negated ? 'not_is' : 'is';
    } else {
      // :matches — distinguish starts_with / ends_with / matches
      const starPositions = [...value].reduce<number[]>((acc, ch, idx) => (ch === '*' ? [...acc, idx] : acc), []);
      if (starPositions.length === 1 && starPositions[0] === value.length - 1) {
        comparator = 'starts_with';
        const cond: FilterCondition = { field, comparator, value: value.slice(0, -1) };
        if (customHeaderName !== undefined) cond.headerName = customHeaderName;
        return cond;
      }
      if (starPositions.length === 1 && starPositions[0] === 0) {
        comparator = 'ends_with';
        const cond: FilterCondition = { field, comparator, value: value.slice(1) };
        if (customHeaderName !== undefined) cond.headerName = customHeaderName;
        return cond;
      }
      comparator = 'matches';
    }

    const cond: FilterCondition = { field, comparator, value };
    if (customHeaderName !== undefined) cond.headerName = customHeaderName;
    return cond;
  }

  m = /^body\s+:(contains|is)\s+"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) {
    return { field: 'body', comparator: m[1] === 'is' ? 'is' : 'contains', value: unescapeSieveString(m[2]) };
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

  m = /^redirect\s+"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) return { type: 'forward', value: unescapeSieveString(m[1]) };

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

function parseIfBlockToRule(block: TopBlock, idPrefix: string, index: number): FilterRule | null {
  const stmt = block.statement;
  const afterIf = stmt.replace(/^if\s+/, '');
  const braceIdx = afterIf.indexOf('{');
  const lastBraceIdx = afterIf.lastIndexOf('}');
  if (braceIdx === -1 || lastBraceIdx === -1 || lastBraceIdx < braceIdx) return null;

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

    // Scan the portion AFTER the metadata block for external rules.
    const afterMetadata = content.slice(endIdx + METADATA_END.length);
    const external = parseExternalRules(afterMetadata, 'ext');

    // Parsed bulwark rules intentionally omit an explicit `origin` field so
    // round-trip equality with metadata-only callers holds. Absence of origin
    // is treated as 'bulwark' everywhere downstream.
    const bulwarkRules: FilterRule[] = metadata.rules;

    // Exclude requires and the vacation line that we emit ourselves from externalRequires.
    const externalRequires = external.externalRequires;

    // Drop any external "rules" that are really the bulwark-managed if-blocks or vacation.
    // Recognizable by the leading comment "# Rule: <name>" or "# Vacation auto-reply".
    const filteredExternal = external.rules.filter(r => {
      const raw = r.rawBlock || '';
      if (/#\s*Rule:\s*/.test(raw) && r.origin === 'external') {
        // If the name matches a bulwark rule name exactly, treat as bulwark-emitted
        const match = raw.match(/#\s*Rule:\s*(.+?)\s*$/m);
        const name = match ? match[1].trim() : '';
        if (bulwarkRules.some(b => b.name === name)) return false;
      }
      if (/#\s*Vacation auto-reply/i.test(raw)) return false;
      return true;
    });

    return {
      rules: [...bulwarkRules, ...filteredExternal],
      isOpaque: false,
      vacation: metadata.vacation,
      externalRequires,
    };
  }

  // No metadata — check vacation-only first
  const vacationOnly = detectVacationOnlyScript(content);
  if (vacationOnly) return vacationOnly;

  // Try to parse the whole script as external rules.
  const external = parseExternalRules(content, 'ext');

  if (!external.hasContent) {
    // Entirely empty or whitespace/comments only — treat as empty, editable.
    return { rules: [], isOpaque: false, externalRequires: [] };
  }

  // If at least one block parsed into a structured rule, expose them as external.
  const anyParsed = external.rules.some(r => r.origin === 'external');
  if (anyParsed || external.rules.length > 0) {
    return { rules: external.rules, isOpaque: false, externalRequires: external.externalRequires };
  }

  return OPAQUE;
}
