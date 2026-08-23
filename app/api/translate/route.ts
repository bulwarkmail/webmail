import { NextRequest, NextResponse } from 'next/server';
import { readFileEnv } from "@/lib/read-file-env";

// Host-side proxy backing the "Translate" plugin (manifest apiPostPaths:
// ["/api/translate"]). The plugin slot iframe POSTs { text, target, source,
// provider } here via api.http.post; we forward to a free translation backend
// and return { translatedText, detectedSource } in a stable shape.
//
// Two providers:
//   - "mymemory"     — public MyMemory API, no configuration required. Its
//                       langpair needs an explicit source language, so when the
//                       plugin asks for "auto" we detect it locally first.
//   - "libretranslate" — only available when the host sets LIBRETRANSLATE_URL
//                       (and optionally LIBRETRANSLATE_API_KEY or LIBRETRANSLATE_API_KEY_FILE). Supports native
//                       source auto-detection.

export const runtime = 'nodejs';

const MAX_CHARS = 5000;
// Long bodies are split into ~480-char chunks for MyMemory and translated
// sequentially, so allow enough headroom for ~10 round-trips.
const TIMEOUT_MS = 25000;

type Provider = 'mymemory' | 'libretranslate';

interface TranslateBody {
  text?: unknown;
  target?: unknown;
  source?: unknown;
  provider?: unknown;
}

interface TranslateResult {
  translatedText: string;
  detectedSource?: string;
}

// ─── Lightweight language detection ───────────────────────────
//
// MyMemory has no auto-detect, so we infer a source language from the text.
// Non-Latin scripts are decided by Unicode range; Latin-script European
// languages are scored by stop-word frequency. Detection only needs to be good
// enough to (a) pick a sensible langpair and (b) let the plugin skip messages
// already in the target language.

const SCRIPT_RANGES: ReadonlyArray<[RegExp, string]> = [
  [/[぀-ヿ]/, 'ja'], // Hiragana / Katakana
  [/[가-힯]/, 'ko'], // Hangul
  [/[一-鿿]/, 'zh'], // CJK ideographs (after JP/KR checks)
  [/[Ѐ-ӿ]/, 'ru'], // Cyrillic (ru vs uk refined below)
  [/[Ͱ-Ͽ]/, 'el'], // Greek
  [/[؀-ۿ]/, 'ar'], // Arabic
  [/[֐-׿]/, 'he'], // Hebrew
  [/[ऀ-ॿ]/, 'hi'], // Devanagari
];

// Distinctive stop words per Latin-script language from the manifest's option
// list. Kept small and high-signal to avoid cross-language collisions.
const LATIN_STOPWORDS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'you', 'that', 'with', 'for', 'this', 'have', 'are'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'mit', 'sie', 'ein', 'auch'],
  fr: ['les', 'des', 'une', 'est', 'pour', 'que', 'vous', 'dans', 'avec', 'pas'],
  es: ['que', 'los', 'una', 'por', 'con', 'para', 'como', 'pero', 'más', 'esta'],
  it: ['che', 'non', 'per', 'una', 'sono', 'con', 'come', 'questo', 'anche', 'della'],
  pt: ['que', 'não', 'uma', 'com', 'para', 'como', 'mais', 'você', 'está', 'isso'],
  nl: ['het', 'een', 'van', 'dat', 'niet', 'met', 'voor', 'aan', 'zijn', 'maar'],
  pl: ['nie', 'jest', 'się', 'ale', 'oraz', 'tego', 'jak', 'tym', 'przez', 'dla'],
  sv: ['och', 'att', 'det', 'som', 'för', 'med', 'inte', 'den', 'till', 'har'],
  no: ['og', 'det', 'som', 'for', 'med', 'ikke', 'har', 'til', 'denne', 'jeg'],
  da: ['og', 'det', 'som', 'for', 'med', 'ikke', 'har', 'til', 'denne', 'jeg'],
  fi: ['että', 'olen', 'tämä', 'kanssa', 'mutta', 'sekä', 'ei', 'on', 'ja', 'jotta'],
  cs: ['není', 'jsem', 'pro', 'ale', 'jako', 'tento', 'také', 'přes', 'jsou', 'své'],
  ro: ['este', 'pentru', 'care', 'dar', 'sunt', 'această', 'mai', 'din', 'sau', 'nu'],
  hu: ['hogy', 'nem', 'egy', 'van', 'ezt', 'vagy', 'mint', 'csak', 'ezzel', 'így'],
  tr: ['bir', 'için', 'değil', 'bu', 'çok', 'daha', 'ama', 'gibi', 've', 'ile'],
};

function detectLanguage(text: string): string {
  const sample = text.slice(0, 1000);
  for (const [range, lang] of SCRIPT_RANGES) {
    if (range.test(sample)) {
      // Ukrainian shares Cyrillic with Russian; its unique glyphs decide it.
      if (lang === 'ru' && /[єіїґ]/.test(sample)) return 'uk';
      return lang;
    }
  }

  const words = sample.toLowerCase().match(/[a-zà-ÿčśžłńęąółżźć]+/gi) || [];
  if (words.length === 0) return 'en';
  const counts: Record<string, number> = {};
  const wordSet = new Set(words);
  for (const [lang, stops] of Object.entries(LATIN_STOPWORDS)) {
    let score = 0;
    for (const stop of stops) if (wordSet.has(stop)) score += 1;
    counts[lang] = score;
  }
  let best = 'en';
  let bestScore = -1;
  for (const [lang, score] of Object.entries(counts)) {
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : 'en';
}

function baseLang(code: string): string {
  return String(code || '').toLowerCase().split('-')[0];
}

// ─── Chunking ─────────────────────────────────────────────────
//
// MyMemory's free endpoint caps each request's `q` at 500 characters and
// silently returns only the translated prefix beyond that — which is why long
// emails came back truncated ("…about Sel…"). We split the text into
// line-aware chunks under the limit, translate each, then rejoin so the whole
// body is covered.

const MYMEMORY_CHUNK = 480;

function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) {
      chunks.push(cur);
      cur = '';
    }
  };
  for (const line of text.split('\n')) {
    if (line.length > max) {
      flush();
      // A single over-long line (e.g. a long URL list): split on words, and
      // hard-cut any word that is itself longer than the limit.
      let seg = '';
      for (const word of line.split(' ')) {
        const piece = seg ? seg + ' ' + word : word;
        if (piece.length > max) {
          if (seg) {
            chunks.push(seg);
            seg = '';
          }
          if (word.length > max) {
            for (let i = 0; i < word.length; i += max) chunks.push(word.slice(i, i + max));
          } else {
            seg = word;
          }
        } else {
          seg = piece;
        }
      }
      if (seg) chunks.push(seg);
      continue;
    }
    if (cur && cur.length + 1 + line.length > max) flush();
    cur = cur ? cur + '\n' + line : line;
  }
  flush();
  return chunks;
}

// ─── Providers ────────────────────────────────────────────────

async function mymemoryRequest(
  q: string,
  langpair: string,
  signal: AbortSignal,
): Promise<string> {
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', q);
  url.searchParams.set('langpair', langpair);

  const res = await fetch(url.toString(), {
    signal,
    headers: { 'User-Agent': 'JMAP-Webmail/1.0 Translate-Plugin' },
  });
  const data = (await res.json().catch(() => null)) as
    | { responseStatus?: number | string; responseData?: { translatedText?: string }; responseDetails?: string }
    | null;
  if (!res.ok || !data) {
    throw new Error(`MyMemory returned ${res.status}`);
  }
  const status = Number(data.responseStatus);
  if (status && status !== 200) {
    throw new Error(data.responseDetails || `MyMemory error ${status}`);
  }
  const translatedText = data.responseData?.translatedText || '';
  if (!translatedText) {
    throw new Error('MyMemory returned no translation');
  }
  return translatedText;
}

async function translateMyMemory(
  text: string,
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<TranslateResult> {
  const detected = source === 'auto' || !source ? detectLanguage(text) : baseLang(source);
  const tgt = baseLang(target);
  // Nothing to do if already in the target language; the plugin skips display.
  if (detected === tgt) {
    return { translatedText: text, detectedSource: detected };
  }
  const langpair = `${detected}|${tgt}`;
  const chunks = chunkText(text, MYMEMORY_CHUNK);
  // Sequential to stay friendly to MyMemory's free-tier rate limits; emails are
  // usually one or two chunks.
  const translated: string[] = [];
  for (const chunk of chunks) {
    translated.push(await mymemoryRequest(chunk, langpair, signal));
  }
  return { translatedText: translated.join('\n'), detectedSource: detected };
}

async function translateLibre(
  text: string,
  source: string,
  target: string,
  signal: AbortSignal,
): Promise<TranslateResult> {
  const endpoint = process.env.LIBRETRANSLATE_URL;
  if (!endpoint) {
    throw new Error('LibreTranslate is not configured on this server');
  }
  const apiKey =
    process.env.LIBRETRANSLATE_API_KEY ||
    readFileEnv(process.env.LIBRETRANSLATE_API_KEY_FILE);
  const url = endpoint.replace(/\/+$/, '') + '/translate';
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: source || 'auto',
      target: baseLang(target),
      format: 'text',
      ...(apiKey ? { api_key: apiKey } : {}),
    }),
  });
  const data = (await res.json().catch(() => null)) as
    | { translatedText?: string; detectedLanguage?: { language?: string }; error?: string }
    | null;
  if (!res.ok || !data) {
    throw new Error(data?.error || `LibreTranslate returned ${res.status}`);
  }
  if (!data.translatedText) {
    throw new Error(data.error || 'LibreTranslate returned no translation');
  }
  return {
    translatedText: data.translatedText,
    detectedSource: data.detectedLanguage?.language || (source !== 'auto' ? baseLang(source) : undefined),
  };
}

// ─── Route ────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let body: TranslateBody;
  try {
    body = (await request.json()) as TranslateBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const target = typeof body.target === 'string' && body.target.trim() ? body.target.trim() : 'en';
  const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'auto';
  const provider: Provider = body.provider === 'libretranslate' ? 'libretranslate' : 'mymemory';

  if (!text) {
    return NextResponse.json({ error: 'No text to translate' }, { status: 400 });
  }
  if (text.length > MAX_CHARS) {
    return NextResponse.json(
      { error: `Text exceeds the ${MAX_CHARS}-character limit` },
      { status: 413 },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result =
      provider === 'libretranslate'
        ? await translateLibre(text, source, target, controller.signal)
        : await translateMyMemory(text, source, target, controller.signal);
    return NextResponse.json(result, { status: 200 });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json({ error: 'Translation timed out' }, { status: 504 });
    }
    const message = error instanceof Error ? error.message : 'Translation failed';
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
