/**
 * Parse the JSON-LD a sender wrote, including the broken forms real booking
 * mail carries: missing commas between objects (Eurowings), several objects
 * without the array brackets (Volotea), trailing commas (Eventbrite) and
 * XML-entity-encoded JSON (Airbnb). Returns undefined when nothing sensible
 * comes out; never throws.
 */

const MAX_BLOCK_LENGTH = 200_000;

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function stripWrappers(text: string): string {
  return text
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * One string-aware pass: drop commas right before `}` or `]`, put a comma
 * between a closing `}` or `]` and an opening `{` or `[` (only where a
 * comma or nothing could go), and escape raw control characters inside
 * strings. Returns the text and how many values sit at the top level.
 */
function repairStructure(text: string): { text: string; topLevel: number } {
  let out = '';
  let inString = false;
  let depth = 0;
  let topLevel = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        out += c + (text[i + 1] ?? '');
        i++;
        continue;
      }
      if (c === '"') inString = false;
      if (c < ' ') {
        out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '';
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') {
      if (depth === 0) topLevel++;
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']' || j >= text.length) continue;
      out += c;
      continue;
    }
    if (c === '{' || c === '[') {
      if (depth === 0) {
        topLevel++;
      } else {
        // `}{` or `]{` inside an array: the comma is missing.
        const prev = out.trimEnd().slice(-1);
        if (prev === '}' || prev === ']') out = out.trimEnd() + ',';
      }
      depth++;
      out += c;
      continue;
    }
    if (c === '}' || c === ']') {
      depth = Math.max(0, depth - 1);
      out += c;
      continue;
    }
    out += c;
  }
  return { text: out, topLevel };
}

export function parseLenientJson(input: string): unknown {
  if (!input || input.length > MAX_BLOCK_LENGTH) return undefined;
  const direct = tryParse(input);
  if (direct.ok) return direct.value;

  let text = stripWrappers(input);
  let attempt = tryParse(text);
  if (attempt.ok) return attempt.value;

  if (/&(quot|#34|#x22);/i.test(text)) {
    text = decodeEntities(text);
    attempt = tryParse(text);
    if (attempt.ok) return attempt.value;
  }

  const repaired = repairStructure(text);
  attempt = tryParse(repaired.text);
  if (attempt.ok) return attempt.value;

  if (repaired.topLevel > 1) {
    // Several top-level values: the brackets are missing. The commas between
    // them may be missing too, which the pass inside brackets adds.
    attempt = tryParse(repairStructure(`[${repaired.text}]`).text);
    if (attempt.ok) return attempt.value;
  }
  return undefined;
}
