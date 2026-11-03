import { describe, expect, it } from 'vitest';
import { MAX_ANNOTATIONS, readCheckResult, validateAnnotations } from '@/lib/proofreading/annotations';
import { OBJECT_CHAR } from '@/lib/proofreading/segments';

const TEXT = `Ich habe dem Brief 👋 ${OBJECT_CHAR} geschrieben.\nZweite Zeile`;
const SEGS = new Map([['s1', TEXT]]);
const ALL = ['spelling', 'grammar', 'style', 'other'] as const;
const at = (word: string) => TEXT.indexOf(word);
const ann = (over: Record<string, unknown> = {}) => ({
  segmentId: 's1', offset: at('dem'), length: 3, kind: 'grammar', message: 'Use den', replacements: ['den'], ...over,
});

describe('validateAnnotations', () => {
  it('keeps a good annotation and records the text it covers', () => {
    const { annotations, dropped } = validateAnnotations([ann({ ruleId: 'DE_CASE', ruleLabel: 'Case' })], SEGS, ALL);
    expect(dropped).toBe(0);
    expect(annotations).toEqual([expect.objectContaining({ text: 'dem', replacements: ['den'], ruleId: 'DE_CASE' })]);
  });

  it('drops annotations for unknown segments, unknown or unregistered kinds and empty messages', () => {
    const raw = [ann({ segmentId: 'nope' }), ann({ kind: 'nonsense' }), ann({ kind: 'style' }), ann({ message: '  ' })];
    const { annotations, dropped } = validateAnnotations(raw, SEGS, ['grammar', 'spelling']);
    expect(annotations).toHaveLength(0);
    expect(dropped).toBe(4);
  });

  it('drops ranges outside the segment and cuts one that runs past its end', () => {
    const { annotations } = validateAnnotations([
      ann({ offset: -1 }),
      ann({ offset: TEXT.length }),
      ann({ offset: 1.5 }),
      ann({ length: 0 }),
      ann({ offset: at('Zeile'), length: 99 }),
    ], SEGS, ALL);
    expect(annotations).toEqual([expect.objectContaining({ offset: at('Zeile'), length: 5, text: 'Zeile' })]);
  });

  it('drops ranges over a line break, an inline object, or half an emoji', () => {
    const emoji = at('👋');
    const { annotations } = validateAnnotations([
      ann({ offset: at('geschrieben.'), length: 14 }),
      ann({ offset: at(OBJECT_CHAR), length: 1 }),
      ann({ offset: emoji, length: 1 }),
      ann({ offset: emoji + 1, length: 1 }),
      ann({ offset: emoji, length: 2 }),
    ], SEGS, ALL);
    expect(annotations.map((a) => a.text)).toEqual(['👋']);
  });

  it('caps the count, the replacements and the strings', () => {
    const many = Array.from({ length: MAX_ANNOTATIONS + 20 }, () => ann());
    expect(validateAnnotations(many, SEGS, ALL).annotations).toHaveLength(MAX_ANNOTATIONS);
    const [one] = validateAnnotations([ann({
      message: 'x'.repeat(2000),
      replacements: ['a', 'b\nc', 'dem', 'd', 'e', 'f', 'g', 'h', 7, 'a', `o${OBJECT_CHAR}`],
    })], SEGS, ALL).annotations;
    expect(one.message.length).toBeLessThanOrEqual(500);
    // No line breaks, no objects, not the text itself, no duplicates, at most 5.
    expect(one.replacements).toEqual(['a', 'd', 'e', 'f', 'g']);
  });
});

describe('readCheckResult', () => {
  it('takes a bare list or an object with a status', () => {
    expect(readCheckResult([1])).toEqual({ annotations: [1], status: 'ok' });
    expect(readCheckResult({ status: 'paused', retryAfterMs: 5000, message: 'Rate limit' })).toEqual({ annotations: [], status: 'paused', retryAfterMs: 5000, message: 'Rate limit' });
    expect(readCheckResult({ status: 'weird' }).status).toBe('ok');
    expect(readCheckResult({ status: 'paused', retryAfterMs: 1e12 }).retryAfterMs).toBe(600_000);
  });
});
