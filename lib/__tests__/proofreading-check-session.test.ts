import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckSession, type CheckRequest, RETRY_AFTER_FAILURE_MS } from '@/lib/proofreading/check-session';
import type { Segment } from '@/lib/proofreading/segments';
import type { CheckerSpec } from '@/lib/plugin-sandbox/checkers';

const spec = (over: Partial<CheckerSpec> = {}): CheckerSpec => ({
  pluginId: 'lt', pluginName: 'LT', id: 'lt', label: 'LT', kinds: ['spelling', 'grammar'],
  debounceMs: 800, languages: [], mode: 'typing', warnBeforeSend: false, epoch: 1, order: 0, ...over,
});

interface Rig {
  session: CheckSession;
  sent: CheckRequest[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  segments: Segment[];
  allowed: boolean;
  spec: CheckerSpec;
  changes: number;
}

function rig(segments: Segment[], opts: { maxChars?: number; timeoutMs?: number; maxPerMinute?: number } = {}): Rig {
  const r = { sent: [] as CheckRequest[], segments, allowed: true, spec: spec(), changes: 0 } as Rig;
  r.session = new CheckSession({
    composerId: 'c1',
    spec: () => r.spec,
    readSegments: () => r.segments,
    language: () => 'de-DE',
    allowed: () => r.allowed,
    send: (request) => {
      r.sent.push(request);
      return new Promise((resolve, reject) => { r.resolve = resolve; r.reject = reject; });
    },
    onChange: () => { r.changes++; },
    ...opts,
  });
  return r;
}

const seg = (id: string, text: string, start = 0): Segment => ({ id, text, start });
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('CheckSession', () => {
  it('waits for the debounce after typing, and sends at once on "now"', async () => {
    const r = rig([seg('a', 'Hallo')]);
    r.session.schedule('typing');
    await vi.advanceTimersByTimeAsync(500);
    r.session.schedule('typing');
    await vi.advanceTimersByTimeAsync(700);
    expect(r.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.sent).toHaveLength(1);

    const s = rig([seg('a', 'Hallo')]);
    s.session.schedule('now');
    await flush();
    expect(s.sent).toHaveLength(1);
  });

  it('sends everything first, then only paragraphs that changed', async () => {
    const r = rig([seg('a', 'Eins'), seg('b', 'Zwei')]);
    r.session.schedule('now');
    await flush();
    expect(r.sent[0]).toMatchObject({ full: true, order: ['a', 'b'], segments: [{ id: 'a', text: 'Eins' }, { id: 'b', text: 'Zwei' }], language: 'de-DE' });
    r.resolve([]);
    await flush();
    r.segments = [seg('a', 'Eins'), seg('b2', 'Zwei!')];
    r.session.schedule('now');
    await flush();
    expect(r.sent[1]).toMatchObject({ full: false, order: ['a', 'b2'], segments: [{ id: 'b2', text: 'Zwei!' }] });
    r.resolve([]);
    await flush();
    // Nothing new: nothing sent.
    r.session.schedule('now');
    await flush();
    expect(r.sent).toHaveLength(2);
  });

  it('keeps one request in flight and sends the newest text after it', async () => {
    const r = rig([seg('a', 'Eins')]);
    r.session.schedule('now');
    await flush();
    r.segments = [seg('a2', 'Eins zwei')];
    r.session.schedule('now');
    r.segments = [seg('a3', 'Eins zwei drei')];
    r.session.schedule('now');
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.sent).toHaveLength(1);
    r.resolve([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1].segments).toEqual([{ id: 'a3', text: 'Eins zwei drei' }]);
  });

  it('keeps answers per paragraph and drops those of paragraphs that are gone', async () => {
    const r = rig([seg('a', 'teh cat'), seg('b', 'a dog')]);
    r.session.schedule('now');
    await flush();
    r.resolve([{ segmentId: 'a', offset: 0, length: 3, kind: 'spelling', message: 'Typo', replacements: ['the'] }]);
    await flush();
    expect(r.session.issuesFor(r.segments)).toHaveLength(1);
    r.segments = [seg('b', 'a dog')];
    expect(r.session.issuesFor(r.segments)).toHaveLength(0);
  });

  it('drops an answer for an older or unknown revision', async () => {
    const r = rig([seg('a', 'teh cat')]);
    const first = r.session.checkText()!;
    const second = r.session.checkText()!;
    const typo = [{ segmentId: 'a', offset: 0, length: 3, kind: 'spelling', message: 'Typo' }];
    expect(r.session.apply(second.revision, typo)).toBe(1);
    expect(r.session.apply(first.revision, typo)).toBe(0);
    expect(r.session.apply('made-up', typo)).toBe(0);
  });

  it('marks the checker unavailable on a timeout and leaves it alone for a while', async () => {
    const r = rig([seg('a', 'Eins')], { timeoutMs: 1000 });
    r.session.schedule('now');
    await vi.advanceTimersByTimeAsync(1001);
    expect(r.session.status).toBe('unavailable');
    r.segments = [seg('b', 'Zwei')];
    r.session.schedule('now');
    await vi.advanceTimersByTimeAsync(RETRY_AFTER_FAILURE_MS - 2000);
    expect(r.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.sent).toHaveLength(2);
    // The failed request was full, so the retry is full too.
    expect(r.sent[1].full).toBe(true);
  });

  it('pauses for as long as a rate-limited checker asks', async () => {
    const r = rig([seg('a', 'Eins')]);
    r.session.schedule('now');
    await flush();
    r.resolve({ status: 'paused', retryAfterMs: 10_000, message: 'Too many requests' });
    await flush();
    expect(r.session.status).toBe('paused');
    expect(r.session.message).toBe('Too many requests');
    r.session.schedule('now');
    await vi.advanceTimersByTimeAsync(9000);
    expect(r.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(r.sent).toHaveLength(2);
  });

  it('splits a long draft into requests of at most maxChars', async () => {
    const r = rig([seg('a', 'x'.repeat(10)), seg('b', 'y'.repeat(10)), seg('c', 'z'.repeat(10))], { maxChars: 15 });
    r.session.schedule('now');
    await flush();
    expect(r.sent[0].segments.map((s) => s.id)).toEqual(['a']);
    r.resolve([]);
    await flush();
    expect(r.sent[1].segments.map((s) => s.id)).toEqual(['b']);
    r.resolve([]);
    await flush();
    expect(r.sent[2].segments.map((s) => s.id)).toEqual(['c']);
  });

  it('sends nothing and forgets its answers while not allowed', async () => {
    const r = rig([seg('a', 'teh')]);
    r.session.schedule('now');
    await flush();
    r.resolve([{ segmentId: 'a', offset: 0, length: 3, kind: 'spelling', message: 'Typo' }]);
    await flush();
    r.allowed = false;
    r.segments = [seg('b', 'new text')];
    r.session.schedule('now');
    await flush();
    await r.session.run();
    expect(r.sent).toHaveLength(1);
    expect(r.session.annotations.size).toBe(0);
    expect(r.session.status).toBe('off');
  });

  it('drops an answer that lands after checking was switched off', async () => {
    const r = rig([seg('a', 'teh')]);
    r.session.schedule('now');
    await flush();
    r.allowed = false;
    r.resolve([{ segmentId: 'a', offset: 0, length: 3, kind: 'spelling', message: 'Typo' }]);
    await flush();
    expect(r.session.annotations.size).toBe(0);
  });

  it('sends everything again after a recheck', async () => {
    const r = rig([seg('a', 'Eins')]);
    r.session.schedule('now');
    await flush();
    r.resolve([]);
    await flush();
    r.spec = spec({ epoch: 2 });
    r.session.schedule('now');
    await flush();
    expect(r.sent[1]).toMatchObject({ full: true, segments: [{ id: 'a', text: 'Eins' }] });
  });

  it('keeps to the rate per minute', async () => {
    const r = rig([seg('a0', '0')], { maxPerMinute: 2 });
    for (let i = 1; i <= 3; i++) {
      r.session.schedule('now');
      await flush();
      r.resolve([]);
      await flush();
      r.segments = [seg(`a${i}`, String(i))];
    }
    expect(r.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.sent).toHaveLength(3);
  });
});
