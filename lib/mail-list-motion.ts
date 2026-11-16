import { useEmailStore } from "@/stores/email-store";
import { emailKeyFor } from "@/lib/thread-utils";
import { around, arrive, depart, NOOP, shown, type Departure, type Surface } from "./list-motion";

type State = ReturnType<typeof useEmailStore.getState>;
type Args = unknown[];

const LIST_ITEMS = '[role="treegrid"] > *';
const ROW = '[role="row"][data-row-key]';
const LIST = '[role="treegrid"]';
const keysOf = (row: HTMLElement) => (row.dataset.threadKeys || row.dataset.rowKey || "").split(" ").filter(Boolean);
const idOf = (key: string) => key.slice(key.lastIndexOf(":") + 1);

const recent: { x: number; t: number }[] = [];
let release = { speed: 0, at: -Infinity };

function trackTouches() {
  const point = (e: Event) => (e as TouchEvent).touches?.[0];
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("touchstart", (e) => {
    recent.length = 0;
    const p = point(e);
    if (p) recent.push({ x: p.clientX, t: performance.now() });
  }, opts);
  window.addEventListener("touchmove", (e) => {
    const p = point(e);
    if (!p) return;
    recent.push({ x: p.clientX, t: performance.now() });
    if (recent.length > 6) recent.shift();
  }, opts);
  window.addEventListener("touchend", () => {
    const now = performance.now();
    const last = recent.filter((r) => now - r.t <= 100);
    const span = last.length > 1 ? last[last.length - 1].t - last[0].t : 0;
    release = { speed: span > 0 ? Math.abs(last[last.length - 1].x - last[0].x) / span : 0, at: now };
  }, opts);
}

function shiftX(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  const m = /matrix(3d)?\(([^)]*)\)/.exec(t);
  if (m) return Number(m[2].split(",")[m[1] ? 12 : 4]) || 0;
  const x = /translateX\((-?[\d.]+)px\)/.exec(t);
  return x ? Number(x[1]) : 0;
}

const MAIL: Surface = {
  items: () => [...document.querySelectorAll<HTMLElement>(LIST_ITEMS)],
  keyOf: (el) => {
    const row = el.matches(ROW) ? el : el.querySelector<HTMLElement>(ROW);
    if (row) return `${row.getAttribute("aria-level") === "2" ? "child" : "row"}:${row.dataset.rowKey}`;
    const text = el.textContent?.trim();
    return text ? `item:${text.slice(0, 60)}` : null;
  },
  watch: ["data-row-key"],
  fades: (key) => key.startsWith("item:"),
  settleMs: 800,
  closes: "stack",
  nested: (item) => [...item.querySelectorAll<HTMLElement>(`${ROW}[aria-level="2"]`)],
  fling: (el) => {
    const part = el.querySelector<HTMLElement>("[data-row-text]");
    const from = part ? shiftX(part) : 0;
    if (!part || Math.abs(from) < 1) return null;
    return { part, from, speed: performance.now() - release.at < 500 ? release.speed : 0 };
  },
  handOff: (el) => {
    const list = el.closest<HTMLElement>(LIST);
    const stopsIn = () => [el, ...el.querySelectorAll<HTMLElement>("*")].filter((n) => n.getAttribute("tabindex") === "0");
    const heirOf = () => {
      const rows = [...(list?.querySelectorAll<HTMLElement>(ROW) ?? [])].filter((r) => !r.closest("[inert]"));
      return rows.find((r) => el.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING)
        ?? rows.reverse().find((r) => el.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_PRECEDING);
    };
    const stops = new Set<HTMLElement>();
    let heir = heirOf();
    const pass = () => {
      const found = stopsIn();
      if (!found.length) return;
      if (!heir?.isConnected || heir.closest("[inert]")) heir = heirOf();
      if (!heir) return;
      found.forEach((n) => { stops.add(n); n.setAttribute("tabindex", "-1"); });
      heir.setAttribute("tabindex", "0");
    };
    const first = heir;
    pass();
    const keep = list && typeof MutationObserver === "function" ? new MutationObserver(() => {
      if (el.isConnected && el.hasAttribute("inert")) pass(); else keep?.disconnect();
    }) : null;
    keep?.observe(list!, { subtree: true, attributes: true, attributeFilter: ["tabindex"] });
    return {
      to: first ?? el.closest<HTMLElement>("[data-focus-fallback]"),
      back: () => {
        keep?.disconnect();
        if (!stops.size || !heir || heir.getAttribute("tabindex") !== "0") return;
        heir.setAttribute("tabindex", "-1");
        stops.forEach((n) => n.isConnected && n.setAttribute("tabindex", "0"));
      },
      done: () => keep?.disconnect(),
    };
  },
};

function leavingItems(keys: Iterable<string>): HTMLElement[] {
  const wanted = new Set(keys);
  const gone = (row: HTMLElement) => {
    const own = keysOf(row);
    return own.length > 0 && own.every((k) => wanted.has(k) || wanted.has(idOf(k)));
  };
  const out: HTMLElement[] = [];
  MAIL.items().forEach((item) => {
    const row = item.querySelector<HTMLElement>(ROW);
    if (!row || !shown(item)) return;
    if (gone(row)) { out.push(item); return; }
    item.querySelectorAll<HTMLElement>(`${ROW}[aria-level="2"]`).forEach((child) => { if (gone(child) && shown(child)) out.push(child); });
  });
  return out;
}

const here = (s: State) => s.mailboxes.find((m) => m.id === s.selectedMailbox);
const role = (s: State) => here(s)?.role ?? s.unifiedRole ?? null;

const selection = (s: State) => [...s.selectedEmailKeys];

function resolve(s: State, ids: string[], accountId?: string): string[] {
  return ids.flatMap((id) => {
    const found = s.emails.filter((e) => e.id === id && (!accountId || !e.sourceAccountId || e.sourceAccountId === accountId));
    return found.length ? found.map(emailKeyFor) : [id];
  });
}

function threadOf(s: State, id: string, key?: string): string[] {
  const email = s.emails.find((e) => (key ? emailKeyFor(e) === key : e.id === id));
  if (!email) return [key ?? id];
  const scope = (e: State["emails"][number]) => `${e.sourceClientAccountId ?? ""}/${e.sourceAccountId ?? ""}`;
  return s.emails.filter((e) => e.threadId === email.threadId && scope(e) === scope(email)).map(emailKeyFor);
}

const targeted = (s: State, target: unknown) => {
  const t = target as { emailIds?: string[]; accountId?: string } | undefined;
  return t?.emailIds ? resolve(s, t.emailIds, t.accountId) : selection(s);
};
const unlessHere = (s: State, to: unknown, ids: string[]) => {
  const m = here(s);
  return m && (to === m.id || to === m.originalId) ? null : ids;
};

const LEAVING: Record<string, (s: State, a: Args) => string[] | null> = {
  deleteEmail: (s, [, id, , key]) => (key ? [key as string] : resolve(s, [id as string])),
  batchDelete: (s) => selection(s),
  moveToMailbox: (s, [, id, to, key]) => unlessHere(s, to, key ? [key as string] : resolve(s, [id as string])),
  moveToMailboxCrossAware: (s, [, id, to, key]) => unlessHere(s, to, key ? [key as string] : resolve(s, [id as string])),
  moveEmailsToMailbox: (s, [, ids, to, , rows]) =>
    unlessHere(s, to, (rows as State["emails"] | undefined)?.map(emailKeyFor) ?? resolve(s, ids as string[])),
  moveThreadToMailbox: (s, [, id, to, key]) => unlessHere(s, to, threadOf(s, id as string, key as string | undefined)),
  batchMoveToMailbox: (s, [, to, target]) => unlessHere(s, to, targeted(s, target)),
  batchArchive: (s, [, target]) => (role(s) === "archive" ? null : targeted(s, target)),
  markAsSpam: (s, [, id, key]) => (role(s) === "junk" ? null : key ? [key as string] : resolve(s, [id as string])),
  batchMarkAsSpam: (s, [, ids]) => (role(s) === "junk" ? null : resolve(s, ids as string[])),
  undoSpam: (s, [, id, key]) => (role(s) === "junk" ? (key ? [key as string] : resolve(s, [id as string])) : null),
  batchUndoSpam: (s, [, ids]) => (role(s) === "junk" ? resolve(s, ids as string[]) : null),
  removeFromMailbox: (_s, [, emails]) => (emails as State["emails"]).map(emailKeyFor),
  crossAccountMoveEmails: (_s, [bySource, , , , , options]) =>
    (options as { keepOriginal?: boolean } | undefined)?.keepOriginal ? null : [...(bySource as Map<string, string[]>).values()].flat(),
};

function start(name: string, args: Args): Departure {
  try {
    if (typeof document === "undefined") return NOOP;
    const ids = LEAVING[name](useEmailStore.getState(), args);
    if (!ids) return NOOP;
    return depart(leavingItems(ids), MAIL);
  } catch {
    return NOOP;
  }
}

type Restore = { points: { id: string }[] }[];
const restored = (_s: State, [, batches]: Args) => new Set((batches as Restore).flatMap((b) => b.points.map((p) => p.id)));
const ARRIVING: Record<string, (s: State, a: Args) => Set<string>> = {
  restoreEmails: restored,
  undoMove: restored,
};
type Arrival = { ids: Set<string>; arrival: Departure; pending: number; view: string };
let active: Arrival | null = null;
const view = (s: State) => JSON.stringify([
  s.selectedMailbox, s.selectedKeyword, s.selectedKeywordAccountId, s.searchQuery, s.searchFilters, s.searchMailboxId,
  s.isUnifiedView, s.unifiedRole, s.crossView, s.viewingAccountId,
]);

function join(name: string, args: Args): Arrival {
  const state = useEmailStore.getState();
  const current = view(state);
  const ids = ARRIVING[name](state, args);
  if (active && active.view === current && active.arrival.live?.()) {
    ids.forEach((id) => active!.ids.add(id));
    return active;
  }
  const mine: Arrival = { ids, arrival: NOOP, pending: 0, view: current };
  mine.arrival = arrive(MAIL, (key) => /^(row|child):/.test(key) && mine.ids.has(idOf(key)), () => view(useEmailStore.getState()) === current);
  active = mine;
  return mine;
}

async function arriving(name: string, args: Args, action: Action): Promise<unknown> {
  if (typeof document === "undefined") return action(...args);
  let mine: Arrival | null = null;
  try {
    mine = join(name, args);
    mine.pending += 1;
  } catch {
    mine = null;
  }
  try {
    return await action(...args);
  } finally {
    if (mine && --mine.pending === 0) {
      mine.arrival.finish(true);
      if (active === mine) active = null;
    }
  }
}

function movedBack(args: Args) {
  const receipts = (args[5] as { receipts?: { destEmailId?: string }[] } | undefined)?.receipts;
  receipts?.forEach((r) => { if (r.destEmailId) active?.ids.add(r.destEmailId); });
}

const WRAPPED = Symbol.for("bulwark.mailMotion");
const TRACKING = Symbol.for("bulwark.mailMotion.touches");
type Action = ((...args: Args) => Promise<unknown>) & { [WRAPPED]?: true };

export function installMailMotion(): void {
  const state = useEmailStore.getState() as unknown as Record<string, Action | undefined>;
  const patch: Record<string, Action> = {};
  for (const name of [...Object.keys(LEAVING), ...Object.keys(ARRIVING)]) {
    const action = state[name];
    if (typeof action !== "function" || action[WRAPPED]) continue;
    const wrapped: Action = name in ARRIVING
      ? (...args) => arriving(name, args, action)
      : name === "crossAccountMoveEmails"
        ? (...args) => around(start(name, args), () => action(...args)).finally(() => movedBack(args))
        : (...args) => around(start(name, args), () => action(...args));
    wrapped[WRAPPED] = true;
    patch[name] = wrapped;
  }
  const w = window as unknown as Record<symbol, boolean>;
  if (!w[TRACKING]) {
    w[TRACKING] = true;
    trackTouches();
  }
  if (Object.keys(patch).length > 0) useEmailStore.setState(patch as never);
}

if (typeof window !== "undefined") installMailMotion();
