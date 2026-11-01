// Proofreading for one open composer: a CheckSession per registered checker,
// the rules for when text may go out, and the issues to show.
//
// Text goes to a checker only while all of these hold, checked each time
// (not cached), so a change of policy, setting or protection takes effect on
// the next keystroke:
// - the admin's policy and the user's choice let this checker run
//   (gate.ts), and the user didn't switch checking off in this composer
//   (unless the admin requires it);
// - the message won't be signed or encrypted (protection.ts);
// - the composer has been open for a moment (crypto plugins reset their
//   choice for a new message when it opens).
// When one stops holding, every session drops what it had at once.

import { CheckSession, type CheckRequest, type CheckStatus } from './check-session';
import type { Annotation, CheckKind } from './annotations';
import type { Segment } from './segments';
import type { CheckerAccess } from './gate';
import type { Protection } from './protection';
import type { CheckerSpec } from '@/lib/plugin-sandbox/checkers';

export const OPEN_GRACE_MS = 1000;

export interface PlacedIssue {
  key: string;
  checkerKey: string;
  pluginId: string;
  checkerId: string;
  checkerLabel: string;
  kind: CheckKind;
  annotation: Annotation;
  /** Where it is: document positions (rich) or textarea indexes (plain). */
  from: number;
  to: number;
  /** Other checkers' findings on the same text, shown in the same popup. */
  alternatives: PlacedIssue[];
}

export type DismissAction = 'ignore' | 'dictionary' | 'disable-rule';

export interface ProofreaderStatus {
  /** Some checker may run here (installed, allowed by policy and user). */
  available: boolean;
  /** At least one checker is on in this composer. */
  on: boolean;
  /** The admin requires checking: no switch. */
  forced: boolean;
  /** The admin turned checking off. */
  lockedOff: boolean;
  /** Checking is on but paused for a signed or encrypted message. */
  paused: Protection & { protected: true } | null;
  checking: boolean;
  /** A checker failed or asked to wait; its label and message. */
  trouble: { label: string; status: 'unavailable' | 'paused'; message?: string } | null;
  count: number;
  /** Labels of the checkers that are on, for the notice. */
  activeLabels: string[];
}

export interface ProofreaderDeps {
  composerId: string;
  checkers: () => CheckerSpec[];
  readSegments: () => Segment[];
  language: () => string;
  access: (pluginId: string) => CheckerAccess;
  protection: () => Protection;
  /** The per-composer switch. */
  composerOn: () => boolean;
  send: (spec: CheckerSpec, request: CheckRequest) => Promise<unknown>;
  action: (spec: CheckerSpec, payload: unknown) => Promise<unknown>;
  onChange: () => void;
  openedAt?: number;
}

export const checkerKeyOf = (spec: Pick<CheckerSpec, 'pluginId' | 'id'>) => `${spec.pluginId}/${spec.id}`;

interface Dismissal {
  checkerKey: string;
  action: DismissAction;
  segmentId: string;
  offset: number;
  text: string;
  ruleId?: string;
}

export class ComposerProofreader {
  private readonly deps: ProofreaderDeps;
  private readonly sessions = new Map<string, { spec: CheckerSpec; session: CheckSession }>();
  private readonly dismissed: Dismissal[] = [];
  private readonly wasAllowed = new Map<string, boolean>();
  private readonly openedAt: number;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(deps: ProofreaderDeps) {
    this.deps = deps;
    this.openedAt = deps.openedAt ?? Date.now();
    this.sync();
  }

  /** Whether `spec` may get text from this composer now. */
  allowed(spec: CheckerSpec): boolean {
    if (this.disposed) return false;
    const access = this.deps.access(spec.pluginId);
    if (!access.on) return false;
    if (!access.forced && !this.deps.composerOn()) return false;
    if (this.deps.protection().protected) return false;
    return Date.now() - this.openedAt >= OPEN_GRACE_MS;
  }

  /** Match the sessions to the registered checkers. */
  sync(): void {
    if (this.disposed) return;
    const specs = this.deps.checkers();
    const seen = new Set<string>();
    for (const spec of specs) {
      const key = checkerKeyOf(spec);
      seen.add(key);
      const entry = this.sessions.get(key);
      if (entry) {
        const recheck = entry.spec.epoch !== spec.epoch;
        entry.spec = spec;
        // recheck(), or the plugin registered again: send everything anew.
        if (recheck && spec.mode === 'typing' && this.allowed(spec)) entry.session.schedule('now');
        continue;
      }
      const holder = { spec, session: null as unknown as CheckSession };
      holder.session = new CheckSession({
        composerId: this.deps.composerId,
        spec: () => holder.spec,
        readSegments: this.deps.readSegments,
        language: this.deps.language,
        allowed: () => this.allowed(holder.spec),
        send: (request) => this.deps.send(holder.spec, request),
        onChange: this.deps.onChange,
      });
      this.sessions.set(key, holder);
    }
    let removed = false;
    for (const [key, entry] of this.sessions) {
      if (seen.has(key)) continue;
      entry.session.dispose();
      this.sessions.delete(key);
      this.wasAllowed.delete(key);
      removed = true;
    }
    if (removed) this.deps.onChange();
    this.gateChanged();
  }

  /** The text changed. */
  edited(reason: 'typing' | 'now' = 'typing'): void {
    for (const { spec, session } of this.sessions.values()) {
      if (spec.mode === 'typing' && this.allowed(spec)) session.schedule(reason);
    }
  }

  /** Policy, settings, protection or the composer switch changed. */
  gateChanged(): void {
    if (this.disposed) return;
    let waiting = false;
    for (const [key, { spec, session }] of this.sessions) {
      const now = this.allowed(spec);
      const before = this.wasAllowed.get(key) ?? false;
      this.wasAllowed.set(key, now);
      if (now) {
        // Only on the way in: a gate that stays open leaves the debounce alone.
        if (!before && spec.mode === 'typing') session.schedule('now');
        if (!before) this.deps.onChange();
      } else {
        if (before || session.status !== 'off' || session.annotations.size) session.clear();
        if (before) this.deps.onChange();
        if (Date.now() - this.openedAt < OPEN_GRACE_MS) waiting = true;
      }
    }
    if (waiting && !this.graceTimer) {
      this.graceTimer = setTimeout(() => { this.graceTimer = null; this.gateChanged(); }, OPEN_GRACE_MS - (Date.now() - this.openedAt));
    }
  }

  getCheckText(spec: CheckerSpec): CheckRequest | null {
    return this.sessions.get(checkerKeyOf(spec))?.session.checkText() ?? null;
  }

  setAnnotations(spec: CheckerSpec, revision: string, raw: unknown): number {
    return this.sessions.get(checkerKeyOf(spec))?.session.apply(revision, raw) ?? 0;
  }

  private isDismissed(key: string, a: Annotation): boolean {
    return this.dismissed.some((d) => {
      if (d.checkerKey !== key) return false;
      if (d.action === 'dictionary') return a.kind === 'spelling' && a.text === d.text;
      if (d.action === 'disable-rule') return !!d.ruleId && a.ruleId === d.ruleId;
      return a.segmentId === d.segmentId && a.offset === d.offset && a.text === d.text;
    });
  }

  /**
   * The issues to show, in text order. Where findings of several checkers
   * overlap, the first-registered checker's is shown and the others are
   * its alternatives.
   */
  issues(segments: Segment[] = this.deps.readSegments()): PlacedIssue[] {
    const entries = [...this.sessions.values()].sort((a, b) => a.spec.order - b.spec.order);
    const shown: PlacedIssue[] = [];
    for (const { spec, session } of entries) {
      if (!this.allowed(spec)) continue;
      const ck = checkerKeyOf(spec);
      const bySegment = new Map(segments.map((s) => [s.id, s]));
      for (const a of session.issuesFor(segments)) {
        if (this.isDismissed(ck, a)) continue;
        const seg = bySegment.get(a.segmentId);
        if (!seg || seg.text.slice(a.offset, a.offset + a.length) !== a.text) continue;
        const from = seg.start + a.offset;
        const issue: PlacedIssue = {
          key: `${ck}|${a.segmentId}|${a.offset}|${a.length}|${a.ruleId ?? ''}`,
          checkerKey: ck, pluginId: spec.pluginId, checkerId: spec.id, checkerLabel: spec.label,
          kind: a.kind, annotation: a, from, to: from + a.length, alternatives: [],
        };
        const over = shown.find((s) => s.from < issue.to && issue.from < s.to);
        if (over) {
          if (over.checkerKey !== ck) over.alternatives.push(issue);
          continue;
        }
        shown.push(issue);
      }
    }
    return shown.sort((a, b) => a.from - b.from);
  }

  /** Hide an issue (and, for the dictionary or a rule, its kind) and tell its checker. */
  dismiss(issue: PlacedIssue, action: DismissAction): void {
    const entry = this.sessions.get(issue.checkerKey);
    if (!entry) return;
    const a = issue.annotation;
    this.dismissed.push({ checkerKey: issue.checkerKey, action, segmentId: a.segmentId, offset: a.offset, text: a.text, ruleId: a.ruleId });
    this.deps.onChange();
    const { text, ...rest } = a;
    void this.deps.action(entry.spec, { composerId: this.deps.composerId, annotation: { ...rest, text }, action }).catch(() => {});
  }

  status(): ProofreaderStatus {
    const protection = this.deps.protection();
    let available = false;
    let forced = false;
    let lockedOff = this.sessions.size > 0;
    let on = false;
    let checking = false;
    let trouble: ProofreaderStatus['trouble'] = null;
    const activeLabels: string[] = [];
    for (const { spec, session } of this.sessions.values()) {
      const access = this.deps.access(spec.pluginId);
      if (!access.lockedOff) lockedOff = false;
      if (access.lockedOff) continue;
      available = true;
      if (access.forced) forced = true;
      const isOn = access.on && (access.forced || this.deps.composerOn());
      if (!isOn) continue;
      on = true;
      activeLabels.push(spec.label);
      if (protection.protected) continue;
      if (session.status === 'checking') checking = true;
      if ((session.status === 'unavailable' || session.status === 'paused') && !trouble) {
        trouble = { label: spec.label, status: session.status, message: session.message };
      }
    }
    return {
      available, on, forced, lockedOff,
      paused: on && protection.protected ? protection : null,
      checking, trouble,
      count: on && !protection.protected ? this.issues().length : 0,
      activeLabels,
    };
  }

  /**
   * Whether the browser's own spell check should stay on: yes unless a
   * spelling checker is running here and working.
   */
  browserSpellcheck(): boolean {
    for (const { spec, session } of this.sessions.values()) {
      if (spec.mode !== 'typing' || !spec.kinds.includes('spelling') || !this.allowed(spec)) continue;
      if (session.status !== 'unavailable' && session.status !== 'paused') return false;
    }
    return true;
  }

  /** Open issues of checkers that asked for a warning before sending. */
  issuesForSendWarning(): PlacedIssue[] {
    const warn = new Set([...this.sessions.values()].filter((e) => e.spec.warnBeforeSend).map((e) => checkerKeyOf(e.spec)));
    if (!warn.size || this.deps.protection().protected) return [];
    return this.issues().filter((i) => warn.has(i.checkerKey));
  }

  dispose(): void {
    this.disposed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    for (const { session } of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  /** Test helper: the session of a checker. */
  sessionOf(spec: Pick<CheckerSpec, 'pluginId' | 'id'>): CheckSession | undefined {
    return this.sessions.get(checkerKeyOf(spec))?.session;
  }

  /** Every session's status, for tests and the status control. */
  statuses(): Record<string, CheckStatus> {
    return Object.fromEntries([...this.sessions].map(([k, v]) => [k, v.session.status]));
  }
}
