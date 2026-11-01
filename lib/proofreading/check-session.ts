// One checker working on one composer: when to send text, what to send, and
// what came back.
//
// - Typing restarts a timer (the checker's debounce); paste and blur send
//   at once.
// - One request at a time. Edits made while it runs mark the session dirty,
//   and the next request goes when the answer is in: the newest text wins,
//   nothing piles up.
// - Only paragraphs the checker hasn't seen go out (segment ids name exact
//   text). The first request, and the first after a recheck or a language
//   change, is `full`: the checker forgets what it had for this composer.
// - Long drafts go in several requests of at most MAX_CHARS new text.
// - Answers are kept per paragraph. A paragraph that changed has a new id,
//   so its old answer is dropped; one that is gone is dropped too.
// - A failing or slow checker sets the status to unavailable and is left
//   alone for a while; one that says it is paused (rate limited) for as
//   long as it asks.
// - Nothing is sent while `allowed()` says no (proofreading off, the draft
//   will be signed or encrypted, the policy isn't known yet).

import { validateAnnotations, readCheckResult, MAX_ANNOTATIONS, type Annotation } from './annotations';
import { OBJECT_CHAR, type Segment } from './segments';
import type { CheckerSpec } from '@/lib/plugin-sandbox/checkers';

export const CHECK_TIMEOUT_MS = 15_000;
export const MAX_CHARS = 20_000;
export const MAX_REQUESTS_PER_MINUTE = 30;
export const RETRY_AFTER_FAILURE_MS = 30_000;
const DEFAULT_PAUSE_MS = 60_000;

export type CheckStatus = 'idle' | 'checking' | 'ok' | 'unavailable' | 'paused' | 'off';

export interface CheckRequest {
  composerId: string;
  revision: string;
  language: string;
  full: boolean;
  order: string[];
  segments: { id: string; text: string }[];
  objectReplacement: string;
}

export interface SessionDeps {
  composerId: string;
  spec: () => CheckerSpec;
  readSegments: () => Segment[];
  language: () => string;
  allowed: () => boolean;
  send: (request: CheckRequest) => Promise<unknown>;
  /** Annotations or status changed. */
  onChange: () => void;
  timeoutMs?: number;
  maxChars?: number;
  maxPerMinute?: number;
}

interface Issued {
  n: number;
  texts: Map<string, string>;
}

let nonceSeq = 0;

export class CheckSession {
  status: CheckStatus = 'idle';
  message: string | undefined;
  /** Segment id → what the checker said about it. */
  readonly annotations = new Map<string, Annotation[]>();

  private readonly deps: SessionDeps;
  private readonly nonce = `${Date.now().toString(36)}${(nonceSeq++).toString(36)}`;
  private seq = 0;
  private lastApplied = 0;
  private readonly issued = new Map<string, Issued>();
  private readonly sent = new Set<string>();
  private sentEpoch = -1;
  private sentLanguage: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private dirty = false;
  private blockedUntil = 0;
  private readonly sendTimes: number[] = [];
  private disposed = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  /** Text changed: `typing` waits for the debounce, `now` (paste, blur, start) doesn't. */
  schedule(reason: 'typing' | 'now' = 'typing'): void {
    if (this.disposed) return;
    if (this.inFlight) { this.dirty = true; return; }
    const wait = Math.max(reason === 'now' ? 0 : this.deps.spec().debounceMs, this.blockedUntil - Date.now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, wait);
  }

  /** Stop and forget every answer (checking was switched off here). */
  clear(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.dirty = false;
    // An answer still on its way is dropped when it lands.
    this.lastApplied = this.seq;
    this.issued.clear();
    const had = this.annotations.size > 0 || this.status !== 'off';
    this.annotations.clear();
    this.status = 'off';
    this.message = undefined;
    if (had) this.deps.onChange();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.issued.clear();
  }

  /** Every annotation for the given segments, in their order, at most MAX_ANNOTATIONS. */
  issuesFor(segments: Segment[]): Annotation[] {
    const out: Annotation[] = [];
    for (const s of segments) {
      for (const a of this.annotations.get(s.id) ?? []) {
        if (out.length >= MAX_ANNOTATIONS) return out;
        out.push(a);
      }
    }
    return out;
  }

  private issue(segments: Segment[]): string {
    const n = ++this.seq;
    const revision = `${this.nonce}-${n}`;
    this.issued.set(revision, { n, texts: new Map(segments.map((s) => [s.id, s.text])) });
    // A plugin answers within one request's time; keep only the last few.
    if (this.issued.size > 8) this.issued.delete(this.issued.keys().next().value as string);
    return revision;
  }

  private prune(segments: Segment[]): boolean {
    const present = new Set(segments.map((s) => s.id));
    let removed = false;
    for (const id of [...this.annotations.keys()]) {
      if (!present.has(id)) { this.annotations.delete(id); removed = true; }
    }
    for (const id of [...this.sent]) if (!present.has(id)) this.sent.delete(id);
    return removed;
  }

  /** The whole text, for a checker that checks when asked (getCheckText). */
  checkText(): CheckRequest | null {
    if (this.disposed || !this.deps.allowed()) return null;
    const segments = this.deps.readSegments();
    const revision = this.issue(segments);
    return {
      composerId: this.deps.composerId,
      revision,
      language: this.deps.language(),
      full: true,
      order: segments.map((s) => s.id),
      segments: segments.map(({ id, text }) => ({ id, text })),
      objectReplacement: OBJECT_CHAR,
    };
  }

  /** An answer for `revision`; returns how many annotations were kept. */
  apply(revision: string, raw: unknown): number {
    const issued = this.issued.get(revision);
    if (this.disposed || !issued || issued.n < this.lastApplied || !this.deps.allowed()) return 0;
    this.lastApplied = issued.n;
    const { annotations } = validateAnnotations(raw, issued.texts, this.deps.spec().kinds);
    const bySegment = new Map<string, Annotation[]>();
    for (const a of annotations) {
      const list = bySegment.get(a.segmentId) ?? [];
      list.push(a);
      bySegment.set(a.segmentId, list);
    }
    for (const id of issued.texts.keys()) this.annotations.set(id, bySegment.get(id) ?? []);
    this.prune(this.deps.readSegments());
    this.status = 'ok';
    this.message = undefined;
    this.deps.onChange();
    return annotations.length;
  }

  private withinRate(now: number): boolean {
    while (this.sendTimes.length && now - this.sendTimes[0] >= 60_000) this.sendTimes.shift();
    const max = this.deps.maxPerMinute ?? MAX_REQUESTS_PER_MINUTE;
    if (this.sendTimes.length < max) return true;
    this.blockedUntil = this.sendTimes[0] + 60_000;
    return false;
  }

  /** Send what the checker hasn't seen yet. Exposed for tests. */
  async run(): Promise<void> {
    if (this.disposed) return;
    if (!this.deps.allowed()) {
      if (this.status !== 'off' || this.annotations.size) this.clear();
      return;
    }
    if (this.inFlight) { this.dirty = true; return; }
    const now = Date.now();
    if (now < this.blockedUntil) { this.schedule('now'); return; }
    const spec = this.deps.spec();
    if (spec.mode !== 'typing') return;
    const language = this.deps.language();
    let full = false;
    if (spec.epoch !== this.sentEpoch || language !== this.sentLanguage) {
      this.sent.clear();
      this.sentEpoch = spec.epoch;
      this.sentLanguage = language;
      full = true;
    }
    const segments = this.deps.readSegments();
    if (this.prune(segments)) this.deps.onChange();
    const fresh = segments.filter((s) => !this.sent.has(s.id));
    if (!full && fresh.length === 0) {
      if (this.status === 'idle' || this.status === 'off') { this.status = 'ok'; this.deps.onChange(); }
      return;
    }
    if (!this.withinRate(now)) { this.schedule('now'); return; }
    const maxChars = this.deps.maxChars ?? MAX_CHARS;
    const chunk: Segment[] = [];
    let size = 0;
    for (const s of fresh) {
      if (chunk.length && size + s.text.length > maxChars) break;
      chunk.push(s);
      size += s.text.length;
    }
    const revision = this.issue(chunk);
    const request: CheckRequest = {
      composerId: this.deps.composerId,
      revision,
      language,
      full,
      order: segments.map((s) => s.id),
      segments: chunk.map(({ id, text }) => ({ id, text })),
      objectReplacement: OBJECT_CHAR,
    };
    this.sendTimes.push(now);
    this.inFlight = true;
    this.dirty = false;
    const wasStatus = this.status;
    this.status = 'checking';
    if (wasStatus !== 'checking') this.deps.onChange();
    let result: unknown;
    let failed: string | null = null;
    try {
      result = await withTimeout(this.deps.send(request), this.deps.timeoutMs ?? CHECK_TIMEOUT_MS);
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    this.inFlight = false;
    if (this.disposed) return;
    if (failed !== null) {
      this.fail('unavailable', failed, RETRY_AFTER_FAILURE_MS, full);
    } else {
      const outcome = readCheckResult(result);
      if (outcome.status === 'ok') {
        for (const s of chunk) this.sent.add(s.id);
        if (!this.apply(revision, outcome.annotations)) {
          // Dropped (stale or switched off); the status still moves on.
          if (this.status === 'checking') { this.status = 'ok'; this.deps.onChange(); }
        }
      } else {
        this.fail(outcome.status, outcome.message, outcome.retryAfterMs ?? (outcome.status === 'paused' ? DEFAULT_PAUSE_MS : RETRY_AFTER_FAILURE_MS), full);
      }
    }
    const more = chunk.length < fresh.length && this.status === 'ok';
    if (this.dirty || more) {
      this.dirty = false;
      this.schedule(more ? 'now' : 'typing');
    }
  }

  private fail(status: 'unavailable' | 'paused', message: string | undefined, retryMs: number, wasFull: boolean): void {
    this.status = status;
    this.message = message;
    this.blockedUntil = Date.now() + retryMs;
    // A full request that failed must be full again.
    if (wasFull) this.sentEpoch = -1;
    this.deps.onChange();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the checker took too long')), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
