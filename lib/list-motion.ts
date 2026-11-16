import { prefersReducedMotion } from "@/lib/reduced-motion";

export interface Surface {
  items(): HTMLElement[];
  keyOf(el: HTMLElement): string | null;
  watch: string[];
  fades?(key: string): boolean;
  settleMs: number;
  closes: "layout" | "stack";
  handOff?(el: HTMLElement): { to: HTMLElement | null; back(): void; done?(): void };
  fling?(el: HTMLElement): { part: HTMLElement; from: number; speed: number } | null;
  nested?(item: HTMLElement): HTMLElement[];
}

const FADE_MS = 150;
const SHIFT_MS = 300;
const SHIFT_EASING = "cubic-bezier(.3,.5,.2,1)";
const RETURN_MS = 250;
const FLY_MIN_MS = 120;
const FLY_MAX_MS = 260;
const FLY_EASING = "cubic-bezier(.5,1,.89,1)";

function flyDuration(distance: number, speed: number): number {
  if (!speed) return FLY_MAX_MS;
  return Math.max(FLY_MIN_MS, Math.min(FLY_MAX_MS, (2 * Math.abs(distance)) / Math.abs(speed)));
}
const DEPARTING = "data-departing";
const GIVE_UP_MS = 30_000;
const STRIP = ["id", "data-testid", "data-index", DEPARTING];

function motionAllowed(): boolean {
  if (typeof document === "undefined" || typeof Element.prototype.animate !== "function") return false;
  return !prefersReducedMotion();
}

type Pos = { left: number; top: number };
type Box = Pos & { width: number; height: number };

const onScreen = (r: Box) => r.width > 0 && r.height > 0 && r.top + r.height >= 0 && r.top <= window.innerHeight;

function clipOf(el: Element): Box {
  let [left, top, right, bottom] = [0, 0, window.innerWidth, window.innerHeight];
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (![s.overflow, s.overflowX, s.overflowY].some((o) => o && o !== "visible")) continue;
    const r = n.getBoundingClientRect();
    left = Math.max(left, r.left);
    top = Math.max(top, r.top);
    right = Math.min(right, r.left + r.width);
    bottom = Math.min(bottom, r.top + r.height);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

const within = (r: Box, c: Box) =>
  r.width > 0 && r.height > 0 && r.top < c.top + c.height && r.top + r.height > c.top && r.left < c.left + c.width && r.left + r.width > c.left;

export function shown(el: Element | null): el is HTMLElement {
  if (!el) return false;
  return within(el.getBoundingClientRect(), clipOf(el));
}

const clear = (c: string) => !c || c === "transparent" || c === "rgba(0, 0, 0, 0)";

function backdrop(el: Element): string {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (!clear(bg)) return bg;
  }
  return "var(--color-background)";
}

function lookOf(el: HTMLElement): Partial<CSSStyleDeclaration> {
  const s = getComputedStyle(el);
  return {
    fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
    lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, color: s.color,
  };
}

function inset(r: Box, c: Box): string {
  const sides = [c.top - r.top, r.left + r.width - c.left - c.width, r.top + r.height - c.top - c.height, c.left - r.left].map((v) => Math.max(0, v));
  return sides.some((v) => v > 0) ? `inset(${sides.map((v) => `${v}px`).join(" ")})` : "";
}

function copyAt(el: HTMLElement, r: Box, look: Partial<CSSStyleDeclaration>, strip: string[], clip: Box): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  [copy, ...copy.querySelectorAll<HTMLElement>("*")].forEach((n) => strip.forEach((a) => n.removeAttribute(a)));
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("inert", "");
  copy.setAttribute("data-motion-ghost", "");
  Object.assign(copy.style, look, {
    position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    margin: "0", boxSizing: "border-box", zIndex: "2147483000", pointerEvents: "none", overflow: "hidden", transform: "none",
    clipPath: inset(r, clip),
  });
  document.body.appendChild(copy);
  return copy;
}

function fadeOut(el: HTMLElement, r: Box, look: Partial<CSSStyleDeclaration>, clip: Box) {
  const copy = copyAt(el, r, look, STRIP, clip);
  const fade = copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-out", fill: "both" });
  fade.onfinish = () => copy.remove();
}

function fadeAway(el: HTMLElement, surface: Surface): { copy: HTMLElement; delay: number } {
  const r = el.getBoundingClientRect();
  const fling = surface.fling?.(el) ?? null;
  const copy = copyAt(el, r, { ...lookOf(el), backgroundColor: backdrop(el) }, [...STRIP, ...surface.watch], clipOf(el));
  const painted = [el, ...el.querySelectorAll<HTMLElement>("*")];
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  painted.forEach((n, i) => {
    const bg = getComputedStyle(n).backgroundColor;
    if (!clear(bg) && copies[i]) copies[i].style.backgroundColor = bg;
  });
  let delay = 0;
  const part = fling ? copies[painted.indexOf(fling.part)] : undefined;
  if (fling && part) {
    const to = Math.sign(fling.from) * r.width;
    delay = flyDuration(to - fling.from, fling.speed);
    part.animate(
      [{ transform: `translateX(${fling.from}px)` }, { transform: `translateX(${to}px)` }],
      { duration: delay, easing: FLY_EASING, fill: "forwards" },
    );
  }
  const fade = copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, delay, easing: "ease-out", fill: "both" });
  fade.onfinish = () => copy.remove();
  return { copy, delay };
}

function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid; else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}
const ease = bezier(0.3, 0.5, 0.2, 1);

type Shift = { key: string | null; base: Pos; held?: Animation; anim?: Animation; from: Pos; to: Pos; delay?: number };
type Place = { el: HTMLElement; pos: Pos; width: number; height: number; look: Partial<CSSStyleDeclaration>; clip?: Box };

const shifts = new WeakMap<HTMLElement, Shift>();
const placesBySurface = new WeakMap<Surface, Map<string, Place>>();
const waitingBySurface = new WeakMap<Surface, Map<HTMLElement, string | null>>();
const activeBySurface = new WeakMap<Surface, number>();
const nestedBySurface = new WeakMap<Surface, Map<HTMLElement, { frame: HTMLElement; followers: HTMLElement[] }>>();

type Tracked = { el: HTMLElement; frame?: HTMLElement };

function tracked(surface: Surface): Tracked[] {
  const items = surface.items();
  const out = new Map<HTMLElement, Tracked>(items.map((el) => [el, { el }]));
  if (surface.nested) {
    items.forEach((item) => surface.nested!(item).forEach((n) => { if (!out.has(n)) out.set(n, { el: n, frame: item }); }));
  }
  nestedBySurface.get(surface)?.forEach(({ frame, followers }, el) => {
    [el, ...followers].forEach((f) => { if (f.isConnected && !out.has(f)) out.set(f, { el: f, frame }); });
  });
  return [...out.values()];
}

const layoutPos = (el: HTMLElement, r: DOMRect, frame?: HTMLElement) =>
  minus(minus(r, offsetOf(el)), frame ? offsetOf(frame) : ZERO);

const ZERO: Pos = { left: 0, top: 0 };
const plus = (a: Pos, b: Pos): Pos => ({ left: a.left + b.left, top: a.top + b.top });
const minus = (a: Pos, b: Pos): Pos => ({ left: a.left - b.left, top: a.top - b.top });
const still = (a: Pos) => Math.abs(a.left) < 0.5 && Math.abs(a.top) < 0.5;
const translate = (p: Pos) => `translate(${p.left}px, ${p.top}px)`;
const running = (a: Animation) => a.playState === "running" || a.playState === "paused";

function offsetOf(el: HTMLElement): Pos {
  const s = shifts.get(el);
  if (!s) return ZERO;
  if (!s.anim) return s.base;
  const t = (typeof s.anim.currentTime === "number" ? s.anim.currentTime : SHIFT_MS + (s.delay ?? 0)) - (s.delay ?? 0);
  const p = t <= 0 ? 0 : t >= SHIFT_MS ? 1 : ease(t / SHIFT_MS);
  return plus(s.base, { left: s.from.left + (s.to.left - s.from.left) * p, top: s.from.top + (s.to.top - s.from.top) * p });
}

function forget(el: HTMLElement) {
  const s = shifts.get(el);
  s?.anim?.cancel();
  s?.held?.cancel();
  shifts.delete(el);
}

function rebase(el: HTMLElement, s: Shift, base: Pos) {
  const old = s.held;
  s.base = base;
  s.held = still(base) ? undefined : el.animate(
    [{ translate: `${base.left}px ${base.top}px` }, { translate: `${base.left}px ${base.top}px` }],
    { duration: 1, fill: "forwards" },
  );
  old?.cancel();
}

function settleShift(el: HTMLElement, s: Shift) {
  const end = plus(s.base, s.anim ? s.to : ZERO);
  s.anim?.cancel();
  s.anim = undefined;
  if (still(end)) { forget(el); return; }
  rebase(el, s, end);
}

function join(el: HTMLElement, key: string | null, lead: Shift) {
  forget(el);
  const anim = el.animate(
    [{ transform: translate(lead.from) }, { transform: translate(lead.to) }],
    { duration: SHIFT_MS, delay: lead.delay ?? 0, easing: SHIFT_EASING, fill: lead.delay ? "both" : "forwards" },
  );
  anim.currentTime = lead.anim?.currentTime ?? 0;
  const next: Shift = { key, base: ZERO, anim, from: lead.from, to: lead.to, delay: lead.delay };
  rebase(el, next, lead.base);
  shifts.set(el, next);
  anim.onfinish = () => { if (shifts.get(el) === next && next.anim === anim) settleShift(el, next); };
}

function move(el: HTMLElement, key: string | null, seen: Pos, target: Pos, delay = 0) {
  const s = shifts.get(el);
  if (s?.anim && running(s.anim)) {
    const d = minus(seen, offsetOf(el));
    if (still(minus(plus(plus(s.base, d), s.to), target))) {
      if (!still(d)) rebase(el, s, plus(s.base, d));
      return;
    }
  }
  if (still(minus(seen, target))) {
    if (s && still(minus(offsetOf(el), target)) && !(s.anim && running(s.anim))) return;
    forget(el);
    if (still(target)) return;
    const held: Shift = { key, base: ZERO, from: ZERO, to: ZERO };
    rebase(el, held, target);
    shifts.set(el, held);
    return;
  }
  forget(el);
  const anim = el.animate(
    [{ transform: translate(seen) }, { transform: translate(target) }],
    { duration: SHIFT_MS, delay, easing: SHIFT_EASING, fill: delay ? "both" : "forwards" },
  );
  const next: Shift = { key, base: ZERO, anim, from: seen, to: target, delay };
  shifts.set(el, next);
  anim.onfinish = () => { if (shifts.get(el) === next && next.anim === anim) settleShift(el, next); };
}

type Reflow = { delay?: number; arriving?: (key: string) => boolean };

function reflow(surface: Surface, committed: boolean, change: () => void = () => {}, opts: Reflow = {}) {
  const places = placesBySurface.get(surface) ?? new Map<string, Place>();
  const keyOffset = new Map<string, Pos>();
  const was = new Map<string, Pos>();
  tracked(surface).forEach(({ el, frame }) => {
    const moved = shifts.get(el)?.key;
    if (moved) keyOffset.set(moved, offsetOf(el));
    if (committed) return;
    const key = surface.keyOf(el);
    const r = el.getBoundingClientRect();
    if (key && r.height > 0) was.set(key, layoutPos(el, r, frame));
  });
  if (committed) places.forEach((p, key) => was.set(key, p.pos));

  change();

  const now = measure(surface, true);

  const gaps = surface.closes === "stack"
    ? [...(waitingBySurface.get(surface) ?? new Map()).entries()]
      .filter(([el, key]) => el.isConnected && surface.keyOf(el) === key)
      .map(([el]) => now.find((n) => n.el === el))
      .filter((n): n is (typeof now)[number] => !!n)
      .filter((g, _, all) => !all.some((o) => o !== g && o.el.contains(g.el)))
    : [];

  let carried = ZERO;
  let lead: HTMLElement | undefined;
  now.forEach(({ el, key, pos, frame }) => {
    const prev = key ? was.get(key) : undefined;
    const seen = prev ? minus(plus(prev, shifts.has(el) ? offsetOf(el) : (keyOffset.get(key!) ?? ZERO)), pos) : carried;
    carried = seen;
    const above = gaps.filter((g) => g.pos.top < pos.top - 0.5 && (frame ? g.frame === frame : g.frame !== el));
    const target = { left: 0, top: -above.reduce((h, g) => h + g.r.height, 0) };
    const ahead = lead && shifts.get(lead);
    if (key && opts.arriving?.(key)) {
      move(el, key, target, target);
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RETURN_MS, easing: "ease-out" });
    } else if (!prev && ahead?.anim && running(ahead.anim) && still(minus(plus(ahead.base, ahead.to), target))) join(el, key, ahead);
    else move(el, key, seen, target, opts.delay);
    if (!gaps.some((g) => g.el === el)) lead = el;
  });

  const next = record(surface, now);
  if (committed) {
    places.forEach((p, key) => {
      if (next.has(key) || p.el.isConnected || !(surface.fades?.(key) ?? true)) return;
      const at = { ...plus(p.pos, keyOffset.get(key) ?? ZERO), width: p.width, height: p.height };
      const clip = p.clip ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      if (within(at, clip)) fadeOut(p.el, at, p.look, clip);
    });
  }
}

function measure(surface: Surface, retarget: boolean) {
  return tracked(surface).map(({ el, frame }) => {
    const key = surface.keyOf(el);
    if (retarget && shifts.has(el) && shifts.get(el)!.key !== key) forget(el);
    const r = el.getBoundingClientRect();
    return { el, key, r, pos: layoutPos(el, r, frame), frame };
  }).filter(({ r }) => r.height > 0).sort((a, b) => a.pos.top - b.pos.top || a.pos.left - b.pos.left);
}

function record(surface: Surface, now: ReturnType<typeof measure>) {
  const places = placesBySurface.get(surface) ?? new Map<string, Place>();
  const next = new Map<string, Place>();
  now.forEach(({ el, key, r, pos }) => {
    if (!key) return;
    const old = places.get(key);
    const kept = old?.el === el && Object.keys(old.look).length > 0;
    const look = kept ? old.look : onScreen(r) && (surface.fades?.(key) ?? true) ? lookOf(el) : {};
    const clip = kept ? old.clip : Object.keys(look).length ? clipOf(el) : undefined;
    next.set(key, { el, pos, width: r.width, height: r.height, look, clip });
  });
  placesBySurface.set(surface, next);
  return next;
}

const remember = (surface: Surface) => record(surface, measure(surface, false));

function regrouped(surface: Surface): boolean {
  const places = placesBySurface.get(surface);
  if (!places) return false;
  const now = measure(surface, false).filter((n) => n.key);
  return now.length !== places.size || now.some((n) => places.get(n.key!)?.el !== n.el);
}

function given(el: HTMLElement, focused: HTMLElement | null, landed: Element | null = null) {
  const now = document.activeElement;
  if (focused?.isConnected && (!now || now === document.body || now === landed || now.contains(el))) focused.focus({ preventScroll: true });
}

export interface Departure { finish(ok: boolean): void; live?(): boolean }
export const NOOP: Departure = { finish() {} };

export function depart(leaving: HTMLElement[], surface: Surface): Departure {
  if (!motionAllowed()) return NOOP;
  const items = [...new Set(leaving)].filter((el) => !el.hasAttribute(DEPARTING));
  if (items.length === 0) return NOOP;
  activeBySurface.set(surface, (activeBySurface.get(surface) ?? 0) + 1);
  const listed = new Set(surface.items());
  const waiting = waitingBySurface.get(surface) ?? new Map<HTMLElement, string | null>();
  waitingBySurface.set(surface, waiting);
  const nested = nestedBySurface.get(surface) ?? new Map<HTMLElement, { frame: HTMLElement; followers: HTMLElement[] }>();
  nestedBySurface.set(surface, nested);
  if (surface.closes === "stack") {
    items.forEach((el) => {
      if (listed.has(el)) return;
      const frame = [...listed].find((item) => item.contains(el));
      if (!frame) return;
      const followers: HTMLElement[] = [];
      for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (n instanceof HTMLElement) followers.push(n);
      nested.set(el, { frame, followers });
    });
  }

  const flights = items.map((el) => fadeAway(el, surface));
  const copies = flights.map((f) => f.copy);
  const delay = Math.max(0, ...flights.map((f) => f.delay));
  const hiding = new Map<HTMLElement, { key: string | null; copy: HTMLElement; show: () => void }>();
  const handing: { el: HTMLElement; focused: HTMLElement | null; back?: () => void; done?: () => void; landed?: Element | null }[] = [];
  reflow(surface, false, () => { items.forEach((el, i) => {
    const key = surface.keyOf(el);
    let show: () => void;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && el.contains(active) ? active : null;
    const hand: (typeof handing)[number] = { el, focused };
    handing.push(hand);
    if (surface.closes === "layout" && listed.has(el)) {
      const display = el.style.display;
      el.style.display = "none";
      show = () => {
        el.style.display = display;
        hand.back?.();
        given(el, focused, hand.landed);
      };
    } else {
      const hide = el.animate([{ opacity: 0 }, { opacity: 0 }], { duration: 1, fill: "forwards" });
      const ariaHidden = el.getAttribute("aria-hidden");
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
      show = () => {
        hide.cancel();
        el.removeAttribute("inert");
        if (ariaHidden === null) el.removeAttribute("aria-hidden"); else el.setAttribute("aria-hidden", ariaHidden);
        hand.back?.();
        given(el, focused, hand.landed);
      };
      if (listed.has(el) || nested.has(el)) waiting.set(el, key);
    }
    hiding.set(el, { key, copy: copies[i], show });
    el.setAttribute(DEPARTING, "");
  });
  handing.forEach((hand) => {
    const off = surface.handOff?.(hand.el);
    hand.back = off?.back;
    hand.done = off?.done;
    if (!hand.focused) return;
    off?.to?.focus({ preventScroll: true });
    hand.landed = document.activeElement;
  });
  }, { delay });

  const unhide = (el: HTMLElement, fadeIn: boolean) => {
    const entry = hiding.get(el);
    if (!entry) return;
    hiding.delete(el);
    waiting.delete(el);
    el.removeAttribute(DEPARTING);
    entry.show();
    entry.copy.remove();
    if (fadeIn) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: RETURN_MS, easing: "ease-out" });
  };
  const left = (el: HTMLElement) => !el.isConnected || surface.keyOf(el) !== hiding.get(el)?.key;

  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = 0;
  const release = () => {
    items.forEach((el) => nested.delete(el));
    const others = (activeBySurface.get(surface) ?? 1) - 1;
    if (others > 0) { activeBySurface.set(surface, others); return; }
    activeBySurface.delete(surface);
    placesBySurface.delete(surface);
  };
  const onScroll = () => remember(surface);
  const end = () => {
    done = true;
    handing.forEach((hand) => hand.done?.());
    observer?.disconnect();
    clearTimeout(timer);
    document.removeEventListener("scroll", onScroll, true);
  };
  const settle = () => {
    if (done) return;
    let changed = false;
    hiding.forEach((_, el) => { if (el.isConnected && left(el)) { unhide(el, false); changed = true; } });
    const out = [...hiding.keys()].filter(left);
    out.forEach((el) => waiting.delete(el));
    if (out.length > gone) changed = true;
    gone = out.length;
    if (out.length === hiding.size) {
      end();
      hiding.clear();
      reflow(surface, true);
      release();
    } else if (changed || regrouped(surface)) {
      reflow(surface, true);
    } else {
      remember(surface);
    }
  };
  const observer = typeof MutationObserver === "function" ? new MutationObserver(settle) : null;
  observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: surface.watch });
  const restore = () => {
    end();
    reflow(surface, false, () => [...hiding.keys()].forEach((el) => unhide(el, true)));
    release();
  };
  timer = setTimeout(restore, GIVE_UP_MS);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });

  return {
    finish(ok) {
      if (done) return;
      if (!ok) { restore(); return; }
      clearTimeout(timer);
      timer = setTimeout(restore, surface.settleMs);
      settle();
    },
  };
}

export function arrive(surface: Surface, expected: (key: string) => boolean, alive: () => boolean = () => true): Departure {
  if (!motionAllowed()) return NOOP;
  activeBySurface.set(surface, (activeBySurface.get(surface) ?? 0) + 1);
  remember(surface);
  const known = new Set(placesBySurface.get(surface)?.keys() ?? []);
  const fresh = (key: string) => expected(key) && !known.has(key);
  let done = false;
  let finished = false;
  let landed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onScroll = () => remember(surface);
  const settle = () => {
    if (done) return;
    if (!alive()) { end(); return; }
    const pending = measure(surface, false).some((n) => n.key && fresh(n.key));
    if (pending || regrouped(surface)) reflow(surface, true, undefined, { arriving: fresh });
    else remember(surface);
    placesBySurface.get(surface)?.forEach((_, key) => {
      if (expected(key)) landed = true;
      known.add(key);
    });
    if (finished && landed) end();
  };
  const observer = typeof MutationObserver === "function" ? new MutationObserver(settle) : null;
  const end = () => {
    if (done) return;
    done = true;
    observer?.disconnect();
    clearTimeout(timer);
    document.removeEventListener("scroll", onScroll, true);
    const others = (activeBySurface.get(surface) ?? 1) - 1;
    if (others > 0) { activeBySurface.set(surface, others); return; }
    activeBySurface.delete(surface);
    placesBySurface.delete(surface);
  };
  observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: surface.watch });
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  timer = setTimeout(end, GIVE_UP_MS);
  return {
    finish() {
      if (done) return;
      finished = true;
      clearTimeout(timer);
      timer = setTimeout(end, surface.settleMs);
      settle();
    },
    live: () => !done,
  };
}

export async function around<T>(departure: Departure, action: () => Promise<T>): Promise<T> {
  try {
    const result = await action();
    departure.finish(Boolean(result));
    return result;
  } catch (err) {
    departure.finish(false);
    throw err;
  }
}
