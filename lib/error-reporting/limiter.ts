/**
 * Keeps error reporting from flooding anyone: each fingerprint once per
 * window, at most `perMinute` reports in any minute and `perSession` in all.
 * The browser keeps its state in sessionStorage, so a page that crashes on
 * every load doesn't start over each time.
 */

export interface LimiterOptions {
  perMinute: number;
  perSession: number;
  /** How long a fingerprint stays "already sent"; Infinity for the whole session. */
  dedupWindowMs: number;
  /** Persist across page loads (sessionStorage); absent on the server. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  storageKey?: string;
  now?: () => number;
}

interface State {
  total: number;
  sent: Record<string, number>;
}

const MAX_REMEMBERED = 500;

export class ReportLimiter {
  private readonly options: Required<Omit<LimiterOptions, 'storage'>> & { storage: LimiterOptions['storage'] };
  private recent: number[] = [];
  private state: State = { total: 0, sent: {} };

  constructor(options: LimiterOptions) {
    this.options = { storageKey: 'bulwark.error-reporting', now: () => Date.now(), storage: null, ...options };
    this.load();
  }

  private load(): void {
    const { storage, storageKey } = this.options;
    if (!storage) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<State>;
      if (typeof parsed.total === 'number' && parsed.sent && typeof parsed.sent === 'object') {
        this.state = { total: parsed.total, sent: parsed.sent as Record<string, number> };
      }
    } catch {
      // Unreadable or blocked storage: start fresh, in memory.
    }
  }

  private save(): void {
    const { storage, storageKey } = this.options;
    if (!storage) return;
    try {
      storage.setItem(storageKey, JSON.stringify(this.state));
    } catch {
      // Quota or privacy mode: the in-memory state still applies.
    }
  }

  /** Whether a report with this fingerprint may go out now; counts it when it may. */
  allow(fingerprint: string): boolean {
    const now = this.options.now();
    const last = this.state.sent[fingerprint];
    if (last !== undefined && now - last < this.options.dedupWindowMs) return false;
    if (this.state.total >= this.options.perSession) return false;
    this.recent = this.recent.filter((at) => now - at < 60_000);
    if (this.recent.length >= this.options.perMinute) return false;
    this.recent.push(now);
    this.state.total += 1;
    this.state.sent[fingerprint] = now;
    const keys = Object.keys(this.state.sent);
    if (keys.length > MAX_REMEMBERED) {
      for (const key of keys.sort((a, b) => this.state.sent[a] - this.state.sent[b]).slice(0, keys.length - MAX_REMEMBERED)) {
        delete this.state.sent[key];
      }
    }
    this.save();
    return true;
  }
}
