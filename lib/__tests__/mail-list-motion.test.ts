import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEmailStore } from '@/stores/email-store';
import { installMailMotion } from '../mail-list-motion';
import { renderHook } from '@testing-library/react';
import { useListboxFocus } from '@/components/email/list-a11y';

type Recorded = { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean; anim: Animation; index: number };
let animations: Recorded[] = [];
let painted = 0;
const fresh = (r: Recorded) => r.index >= painted;

const span = (o: KeyframeAnimationOptions) => Number(o.delay ?? 0) + Number(o.duration);
function fakeAnimate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  const rec = { el: this, keyframes, options, cancelled: false, index: animations.length } as Recorded;
  let at: number | undefined;
  rec.anim = {
    onfinish: null,
    cancel() { rec.cancelled = true; },
    get playState() { return rec.cancelled ? 'idle' : fresh(rec) && (at ?? 0) < span(options) ? 'running' : 'finished'; },
    get currentTime() { return at ?? (fresh(rec) ? 0 : span(options)); },
    set currentTime(t: number) { at = t; },
  } as unknown as Animation;
  animations.push(rec);
  return rec.anim;
}
function paint() {
  const started = animations.slice(painted);
  painted = animations.length;
  started.forEach((r) => { if (!r.cancelled) r.anim.onfinish?.(new Event('finish') as AnimationPlaybackEvent); });
}

const parse = (t: unknown) => {
  const m = /([-\d.]+)px[, ]+([-\d.]+)px/.exec(String(t));
  return m ? { x: +m[1], y: +m[2] } : { x: 0, y: 0 };
};
const moving = (a: Recorded) => String(a.keyframes[0].transform).startsWith('translate(');
const holding = (a: Recorded) => a.keyframes[0].translate !== undefined;
const lastOf = (el: Element, kind: (a: Recorded) => boolean) => animations.filter((a) => a.el === el && !a.cancelled && kind(a)).at(-1);
function eased(easing: unknown, x: number) {
  const [x1, y1, x2, y2] = (/cubic-bezier\(([^)]*)\)/.exec(String(easing))?.[1] ?? '0,0,1,1').split(',').map(Number);
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  let [lo, hi] = [0, 1];
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (at(x1, x2, mid) < x) lo = mid; else hi = mid; }
  return at(y1, y2, (lo + hi) / 2);
}
function progress(a: Recorded) {
  const t = Number(a.anim.currentTime) - Number(a.options.delay ?? 0);
  const d = Number(a.options.duration);
  return t <= 0 ? 0 : t >= d ? 1 : eased(a.options.easing, t / d);
}
const offset = (el: Element) => {
  const m = lastOf(el, moving);
  const h = lastOf(el, holding);
  const p = m ? progress(m) : 0;
  const [from, to] = m ? [parse(m.keyframes[0].transform), parse(m.keyframes.at(-1)!.transform)] : [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  const pm = { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p };
  const ph = h ? parse(h.keyframes[0].translate) : { x: 0, y: 0 };
  return { x: pm.x + ph.x, y: pm.y + ph.y };
};
const bases = new WeakMap<Element, { x: number; y: number }>();
function box(el: Element, x: number, y: number, w: number, h: number) {
  bases.set(el, { x, y });
  (el as HTMLElement).getBoundingClientRect = () => {
    const o = { x: 0, y: 0 };
    for (let n: Element | null = el; n; n = n.parentElement) { const p = offset(n); o.x += p.x; o.y += p.y; }
    const [l, t] = [x + o.x, y + o.y];
    return { x: l, y: t, left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, toJSON: () => ({}) } as DOMRect;
  };
}
const drawn = (el: Element) => el.getBoundingClientRect().top;
const settled = (el: Element) => { paint(); return drawn(el); };
function watchRows() {
  paint();
  const els = [...document.querySelectorAll<HTMLElement>('[role="treegrid"] > *')];
  const before = new Map(els.map((el) => [el, drawn(el)]));
  return () => [...before].filter(([el, y]) => el.isConnected && drawn(el) !== y).map(([el]) => el.textContent);
}

const ROW_H = 72;
const listItem = (index: number, key: string, text: string, threadKeys?: string) =>
  `<div data-index="${index}" role="presentation"><div role="row" tabindex="-1" data-row-key="${key}"${threadKeys ? ` data-thread-keys="${threadKeys}"` : ''}>${text}</div></div>`;
function setup() {
  document.body.innerHTML = `
    <div id="message-list" tabindex="-1" data-focus-fallback><div role="treegrid">
      ${listItem(0, 'e1', 'Lunch on Friday')}
      ${listItem(1, 'e2', 'Invoice')}
      ${listItem(2, 'e3', 'Re: plans')}
    </div></div>
    <article><div data-email-id="e1">The open message, not a list row</div></article>`;
  layout();
  box(document.querySelector('article [data-email-id]')!, 980, 0, 600, 600);
}
function layout() {
  document.querySelectorAll('[role="treegrid"] > *').forEach((el, i) => box(el, 260, i * ROW_H, 700, ROW_H));
}

const row = (id: string) => document.querySelector<HTMLElement>(`[role="row"][data-row-key="${id}"]`)?.parentElement as HTMLElement;
const on = (el: Element) => animations.filter((a) => a.el === el);
const copies = () => [...document.querySelectorAll<HTMLElement>('[data-motion-ghost]')];
const slidOut = (text: string) => copies().some((c) => c.textContent === text
  && on(c).some((a) => a.keyframes.at(-1)!.opacity === 0 && a.keyframes.every((k) => k.transform === undefined)));
const hidden = (el: Element) => on(el).some((a) => a.keyframes.every((k) => k.opacity === 0) && !a.cancelled);
const frame = () => new Promise((r) => setTimeout(r, 0));
const client = {} as never;
let calls: string[] = [];

function removeRows(ids: string[]) {
  ids.forEach((id) => row(id)?.remove());
  layout();
}

function fakeActions(result: boolean | Error = true) {
  const act = (name: string, ids: string[]) => {
    calls.push(name);
    if (result instanceof Error) throw result;
    if (result) removeRows(ids);
    return result;
  };
  useEmailStore.setState({
    deleteEmail: async (_c: never, id: string) => act('deleteEmail', [id]),
    moveToMailbox: async (_c: never, id: string) => act('moveToMailbox', [id]),
    moveThreadToMailbox: async (_c: never, id: string) => act('moveThreadToMailbox', [id]),
    batchArchive: async () => act('batchArchive', ['e1', 'e2']),
    markAsSpam: async (_c: never, id: string) => act('markAsSpam', [id]),
  } as never);
  installMailMotion();
}

beforeEach(() => {
  animations = [];
  painted = 0;
  calls = [];
  Element.prototype.animate = fakeAnimate as unknown as Element['animate'];
  delete document.documentElement.dataset.motion;
  window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
  useEmailStore.setState({
    mailboxes: [{ id: 'mb-inbox', role: 'inbox', name: 'Inbox' }, { id: 'mb-junk', role: 'junk', name: 'Junk' }, { id: 'mb-work', role: null, name: 'Work' }],
    selectedMailbox: 'mb-inbox',
    unifiedRole: null,
    emails: [{ id: 'e1', threadId: 't1' }, { id: 'e2', threadId: 't2' }, { id: 'e3', threadId: 't3' }],
    selectedEmailKeys: new Set<string>(),
  } as never);
  setup();
});
afterEach(async () => { document.body.innerHTML = ''; await Promise.resolve(); });

describe('a message leaving the list', () => {
  it('fades away where it was, at once, however fast the server takes it away', async () => {
    fakeActions();
    await useEmailStore.getState().deleteEmail(client, 'e2');
    expect(row('e2')).toBeUndefined();
    expect(slidOut('Invoice')).toBe(true);
    expect(calls).toEqual(['deleteEmail']);
  });

  it('is hidden where it was while the server answers', () => {
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    const el = row('e2');
    void useEmailStore.getState().deleteEmail(client, 'e2');
    expect(hidden(el)).toBe(true);
    expect(slidOut('Invoice')).toBe(true);
  });

  it('starts the messages below rising into the gap at once, while the server still answers', () => {
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    const [above, below] = [row('e1'), row('e3')];
    const jumps = watchRows();
    void useEmailStore.getState().deleteEmail(client, 'e2');
    expect(jumps()).toEqual([]);
    expect(settled(below)).toBe(ROW_H);
    expect(settled(above)).toBe(0);
  });

  it('keeps the messages below where they rose to once the server takes it away', async () => {
    let answer!: (ok: boolean) => void;
    useEmailStore.setState({ deleteEmail: () => new Promise<boolean>((r) => { answer = r; }).then((ok) => { removeRows(['e2']); return ok; }) } as never);
    installMailMotion();
    const below = row('e3');
    const p = useEmailStore.getState().deleteEmail(client, 'e2');
    const jumps = watchRows();
    answer(true);
    await p;
    await frame();
    expect(jumps()).toEqual([]);
    expect(settled(below)).toBe(ROW_H);
  });

  it('keeps the rise running, never restarting it, when the server answers mid-way', async () => {
    let answer!: (ok: boolean) => void;
    useEmailStore.setState({ deleteEmail: () => new Promise<boolean>((r) => { answer = r; }).then((ok) => { removeRows(['e2']); return ok; }) } as never);
    installMailMotion();
    const below = row('e3');
    const jumps = watchRows();
    const p = useEmailStore.getState().deleteEmail(client, 'e2');
    const rise = lastOf(below, moving)!;
    answer(true);
    await p;
    await frame();
    expect(rise.cancelled).toBe(false);
    expect(lastOf(below, moving)).toBe(rise);
    expect(jumps()).toEqual([]);
    expect(settled(below)).toBe(ROW_H);
  });

  it('holds the rows below on whole device pixels while the server answers', async () => {
    const dpr = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      document.querySelectorAll('[role="treegrid"] > *').forEach((el, i) => box(el, 260, i * 72.3, 700, 72.3));
      useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
      installMailMotion();
      const below = row('e2');
      void useEmailStore.getState().deleteEmail(client, 'e1');
      paint();
      const y = parse(lastOf(below, holding)?.keyframes[0].translate).y;
      expect(y * 2).toBe(Math.round(y * 2));
      expect(Math.abs(y + 72.3)).toBeLessThanOrEqual(0.25);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
    }
  });

  it('closes the gap of every message of a batch at once', async () => {
    useEmailStore.setState({ batchArchive: () => { removeRows(['e1', 'e2']); return new Promise(() => {}); } } as never);
    installMailMotion();
    useEmailStore.setState({ selectedEmailKeys: new Set(['e1', 'e2']) } as never);
    const below = row('e3');
    const jumps = watchRows();
    void useEmailStore.getState().batchArchive(client);
    await Promise.resolve();
    expect(jumps()).toEqual([]);
    expect(settled(below)).toBe(0);
  });

  it('draws a message scrolled into view by the gap right below the one above it', async () => {
    useEmailStore.setState({
      deleteEmail: async () => {
        removeRows(['e2']);
        document.querySelector('[role="treegrid"]')!.insertAdjacentHTML('beforeend', listItem(3, 'e4', 'New'));
        layout();
        return true;
      },
    } as never);
    installMailMotion();
    await useEmailStore.getState().deleteEmail(client, 'e2');
    await frame();
    expect(drawn(row('e4')) - drawn(row('e3'))).toBe(ROW_H);
    expect(settled(row('e4'))).toBe(2 * ROW_H);
  });

  it('lets a message the list draws while the server answers rise in step with the one above', async () => {
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    void useEmailStore.getState().deleteEmail(client, 'e2');
    const rise = lastOf(row('e3'), moving)!;
    rise.anim.currentTime = 120;
    document.querySelector('[role="treegrid"]')!.insertAdjacentHTML('beforeend', listItem(3, 'e4', 'Scrolled in'));
    layout();
    await frame();
    const joined = lastOf(row('e4'), moving);
    expect(joined?.keyframes).toEqual(rise.keyframes);
    expect(joined?.anim.currentTime).toBe(120);
    expect(settled(row('e4')) - settled(row('e3'))).toBe(ROW_H);
  });

  it('moves a row the list reuses for a message below the gap along with the others', async () => {
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    void useEmailStore.getState().deleteEmail(client, 'e2');
    paint();
    const reused = row('e1');
    reused.firstElementChild!.setAttribute('data-row-key', 'e7');
    box(reused, 260, 3 * ROW_H, 700, ROW_H);
    await frame();
    expect(settled(reused) - settled(row('e3'))).toBe(ROW_H);
  });

  it('takes the leaving message out of reach of the keyboard and screen readers, and gives the focus to the next one', () => {
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    const el = row('e2');
    el.querySelector<HTMLElement>('[role="row"]')!.focus();
    void useEmailStore.getState().deleteEmail(client, 'e2');
    expect(el.hasAttribute('inert')).toBe(true);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(row('e3').querySelector('[role="row"]'));
  });

  it('fades only the part of a message the list shows, and leaves rows it clips out alone', () => {
    const list = document.getElementById('message-list')!;
    list.style.overflow = 'auto';
    box(list, 260, 40, 700, 100);
    useEmailStore.setState({ batchArchive: () => new Promise(() => {}), selectedEmailKeys: new Set(['e1', 'e3']) } as never);
    installMailMotion();
    void useEmailStore.getState().batchArchive(client);
    expect(copies().map((c) => c.textContent)).toEqual(['Lunch on Friday']);
    expect(copies()[0].style.clipPath).toBe('inset(40px 0px 0px 0px)');
    expect(hidden(row('e3'))).toBe(false);
  });

  it('slides out every archived message', async () => {
    fakeActions();
    useEmailStore.setState({ selectedEmailKeys: new Set(['e1', 'e2']) } as never);
    await useEmailStore.getState().batchArchive(client);
    expect(slidOut('Lunch on Friday') && slidOut('Invoice')).toBe(true);
    expect(slidOut('Re: plans')).toBe(false);
  });

  it('slides out a whole conversation, whichever of its messages was named', async () => {
    fakeActions();
    useEmailStore.setState({ emails: [{ id: 'e1', threadId: 't1' }, { id: 'e0', threadId: 't1' }] } as never);
    await useEmailStore.getState().moveThreadToMailbox(client, 'e0', 'mb-work');
    expect(slidOut('Lunch on Friday')).toBe(true);
  });

  it('slides out a conversation row once all its messages leave, and keeps it while one stays', async () => {
    document.querySelector('[role="treegrid"]')!.insertAdjacentHTML('beforeend', listItem(3, 'e5', 'Weekend (2)', 'e5 e6'));
    layout();
    useEmailStore.setState({ emails: [{ id: 'e1', threadId: 't1' }, { id: 'e5', threadId: 't5' }, { id: 'e6', threadId: 't5' }] } as never);
    fakeActions();
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    void useEmailStore.getState().deleteEmail(client, 'e5');
    expect(copies()).toHaveLength(0);
    useEmailStore.setState({ moveThreadToMailbox: () => new Promise(() => {}) } as never);
    installMailMotion();
    void useEmailStore.getState().moveThreadToMailbox(client, 'e6', 'mb-work');
    expect(slidOut('Weekend (2)')).toBe(true);
  });

  it('moves the headings below the gap along with the messages', async () => {
    document.querySelector('[role="treegrid"]')!.insertAdjacentHTML('afterbegin', '<div data-index="0"><div>Unread</div></div>');
    row('e2').insertAdjacentHTML('afterend', '<div data-index="9"><div>Everything else</div></div>');
    layout();
    const heading = [...document.querySelectorAll<HTMLElement>('[role="treegrid"] > *')].find((el) => el.textContent === 'Everything else')!;
    fakeActions();
    const [headingAt, e3At] = [drawn(heading), drawn(row('e3'))];
    const jumps = watchRows();
    await useEmailStore.getState().deleteEmail(client, 'e1');
    expect(jumps()).toEqual([]);
    expect(settled(heading)).toBe(headingAt - ROW_H);
    expect(settled(row('e3'))).toBe(e3At - ROW_H);
  });

  it('lets a row the list stops drawing go without a trace, as it would scrolling', async () => {
    useEmailStore.setState({ deleteEmail: async () => { removeRows(['e1', 'e3']); return true; } } as never);
    installMailMotion();
    await useEmailStore.getState().deleteEmail(client, 'e1');
    expect(copies().map((c) => c.textContent)).toEqual(['Lunch on Friday']);
  });

  it('never moves the open message in the reading pane', async () => {
    fakeActions();
    const pane = document.querySelector('article [data-email-id]')!;
    await useEmailStore.getState().deleteEmail(client, 'e1');
    await frame();
    expect(on(pane)).toHaveLength(0);
  });

  it('leaves the list alone when the message stays in it', async () => {
    fakeActions(false);
    await useEmailStore.getState().moveToMailbox(client, 'e1', 'mb-inbox');
    useEmailStore.setState({ selectedMailbox: 'mb-junk' } as never);
    await useEmailStore.getState().markAsSpam(client, 'e2');
    useEmailStore.setState({ crossAccountMoveEmails: async () => true } as never);
    installMailMotion();
    await useEmailStore.getState().crossAccountMoveEmails(new Map([['acc', ['e3']]]), 'other', 'mb-x', undefined, undefined, { keepOriginal: true });
    expect(animations).toHaveLength(0);
  });
});

describe('a swiped message', () => {
  function swiped(id: string, dx: number) {
    row(id).querySelector('[role="row"]')!.innerHTML = `<div data-row-text style="transform: translateX(${dx}px)">Swiped away</div>`;
  }
  const flight = () => {
    const part = copies()[0]?.querySelector('[data-row-text]');
    return part ? on(part).find((a) => String(a.keyframes.at(-1)!.transform).startsWith('translateX(')) : undefined;
  };
  const fadeOf = (el: Element) => on(el).find((a) => a.keyframes[0].opacity === 1 && a.keyframes.at(-1)!.opacity === 0);

  it('flies on off the way it was swiped, and only then fades while the rows below rise', () => {
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    swiped('e2', -120);
    const below = row('e3');
    void useEmailStore.getState().deleteEmail(client, 'e2');
    const fly = flight()!;
    expect(fly.keyframes.map((k) => k.transform)).toEqual(['translateX(-120px)', 'translateX(-700px)']);
    expect(fly.options.duration).toBe(260);
    expect(fadeOf(copies()[0])!.options.delay).toBe(260);
    expect(fadeOf(copies()[0])!.options.duration).toBe(150);
    expect(lastOf(below, moving)!.options.delay).toBe(260);
    expect(settled(below)).toBe(ROW_H);
  });

  it('flies off as fast as the finger let go', () => {
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    swiped('e2', -120);
    const now = vi.spyOn(performance, 'now');
    const touch = (type: string, x: number, t: number) => {
      now.mockReturnValue(t);
      const e = new Event(type, { bubbles: true });
      Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 300 }] });
      Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: 300 }] });
      row('e2').dispatchEvent(e);
    };
    touch('touchstart', 600, 1000);
    touch('touchmove', 540, 1008);
    touch('touchmove', 480, 1016);
    touch('touchend', 480, 1018);
    void useEmailStore.getState().deleteEmail(client, 'e2');
    now.mockRestore();
    expect(flight()!.options.duration).toBeCloseTo((2 * 580) / 7.5, 0);
  });

  it('fades where it is when it was not swiped', () => {
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    void useEmailStore.getState().deleteEmail(client, 'e2');
    expect(flight()).toBeUndefined();
    expect(fadeOf(copies()[0])!.options.delay ?? 0).toBe(0);
  });
});

describe('undo', () => {
  const restore = (s: ReturnType<typeof useEmailStore.getState>) => s.restoreEmails(client, [{ client, points: [{ id: 'e2', mailboxIds: {}, keywords: {} }] }] as never);
  const fadesIn = (el: Element) => on(el).some((a) => a.keyframes[0].opacity === 0 && a.keyframes.at(-1)!.opacity === 1 && a.options.duration === 250);

  it('fades the message back in where it lands while the rows below slide apart', async () => {
    removeRows(['e2']);
    useEmailStore.setState({
      restoreEmails: async () => {
        row('e1').insertAdjacentHTML('afterend', listItem(1, 'e2', 'Invoice'));
        layout();
      },
    } as never);
    installMailMotion();
    const below = row('e3');
    const jumps = watchRows();
    await restore(useEmailStore.getState());
    await frame();
    expect(fadesIn(row('e2'))).toBe(true);
    expect(drawn(row('e2'))).toBe(ROW_H);
    expect(jumps()).toEqual([]);
    expect(settled(below)).toBe(2 * ROW_H);
  });

  it('fades the message back in even while another one is still leaving', async () => {
    removeRows(['e2']);
    useEmailStore.setState({
      deleteEmail: () => new Promise(() => {}),
      restoreEmails: async () => {
        row('e1').insertAdjacentHTML('afterend', listItem(1, 'e2', 'Invoice'));
        layout();
      },
    } as never);
    installMailMotion();
    void useEmailStore.getState().deleteEmail(client, 'e3');
    await restore(useEmailStore.getState());
    await frame();
    expect(fadesIn(row('e2'))).toBe(true);
  });

  it('lets go when another folder is opened before the message is back', async () => {
    removeRows(['e2']);
    let done!: () => void;
    useEmailStore.setState({ restoreEmails: () => new Promise<void>((r) => { done = r; }) } as never);
    installMailMotion();
    const p = restore(useEmailStore.getState());
    useEmailStore.setState({ selectedMailbox: 'mb-work' } as never);
    document.querySelector('[role="treegrid"]')!.innerHTML = listItem(0, 'e3', 'Re: plans') + listItem(1, 'e2', 'Invoice');
    layout();
    await frame();
    done();
    await p;
    await frame();
    expect(fadesIn(row('e2'))).toBe(false);
    expect(animations.filter(moving)).toHaveLength(0);
  });

  it('lets go when a tag is opened before the message is back', async () => {
    removeRows(['e2']);
    let done!: () => void;
    useEmailStore.setState({ restoreEmails: () => new Promise<void>((r) => { done = r; }) } as never);
    installMailMotion();
    const p = restore(useEmailStore.getState());
    useEmailStore.setState({ selectedKeyword: 'work' } as never);
    document.querySelector('[role="treegrid"]')!.innerHTML = listItem(0, 'e3', 'Re: plans') + listItem(1, 'e2', 'Invoice');
    layout();
    await frame();
    done();
    await p;
    await frame();
    expect(fadesIn(row('e2'))).toBe(false);
    expect(animations.filter(moving)).toHaveLength(0);
  });

  it('fades in a message a second Undo brings back while the first still waits', async () => {
    removeRows(['e2']);
    let calls = 0;
    let first!: () => void;
    useEmailStore.setState({
      restoreEmails: (_c: never, batches: { points: { id: string }[] }[]) => {
        calls += 1;
        if (calls === 1) return new Promise<void>((r) => { first = r; });
        row('e1').insertAdjacentHTML('afterend', listItem(1, batches[0].points[0].id, 'Second'));
        layout();
        return Promise.resolve();
      },
    } as never);
    installMailMotion();
    const waiting = restore(useEmailStore.getState());
    await useEmailStore.getState().restoreEmails(client, [{ client, points: [{ id: 'e5', mailboxIds: {}, keywords: {} }] }] as never);
    await frame();
    expect(fadesIn(row('e5'))).toBe(true);
    first();
    await waiting;
  });

  it('fades in a message moved back from another account under its new id', async () => {
    removeRows(['e2']);
    useEmailStore.setState({
      crossAccountMoveEmails: async (_m: never, _l: never, _f: never, _a: never, _b: never, options: { receipts: { destEmailId: string }[] }) => {
        options.receipts.push({ destEmailId: 'n2' });
        return true;
      },
      undoMove: async () => {
        const back: { destEmailId: string }[] = [];
        await useEmailStore.getState().crossAccountMoveEmails(new Map(), 'login', 'mb-inbox', undefined, undefined, { receipts: back } as never);
        row('e1').insertAdjacentHTML('afterend', listItem(1, back[0].destEmailId, 'Moved back'));
        layout();
      },
    } as never);
    installMailMotion();
    await useEmailStore.getState().undoMove(client, [{ client, points: [{ id: 'e2', mailboxIds: {}, keywords: {} }] }] as never, [{ sourceEmailId: 'e2' }] as never);
    await frame();
    expect(fadesIn(row('n2'))).toBe(true);
  });

  it('fades in only the message it brought back', async () => {
    removeRows(['e2']);
    useEmailStore.setState({
      restoreEmails: async () => {
        row('e1').insertAdjacentHTML('afterend', listItem(1, 'e2', 'Invoice'));
        document.querySelector('[role="treegrid"]')!.insertAdjacentHTML('beforeend', listItem(3, 'e8', 'Arrived meanwhile'));
        layout();
      },
    } as never);
    installMailMotion();
    await restore(useEmailStore.getState());
    await frame();
    expect(fadesIn(row('e2'))).toBe(true);
    expect(fadesIn(row('e8'))).toBe(false);
  });
});

describe('the same message id in two accounts', () => {
  it('lets only the message of the named account go', () => {
    document.querySelector('[role="treegrid"]')!.innerHTML = listItem(0, 'acc-a:m1', 'From A') + listItem(1, 'acc-b:m1', 'From B') + listItem(2, 'acc-b:m2', 'Below');
    layout();
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    void useEmailStore.getState().deleteEmail(client, 'm1', false, 'acc-a:m1');
    expect(slidOut('From A')).toBe(true);
    expect(slidOut('From B')).toBe(false);
    expect(hidden(row('acc-b:m1'))).toBe(false);
  });
});

describe('a message of an open conversation', () => {
  const CHILD_H = 40;
  function conversation() {
    document.querySelector('[role="treegrid"]')!.innerHTML = `
      <div data-index="0"><div role="row" tabindex="-1" data-row-key="c1" data-thread-keys="c1 c2 c3">Trip (3)</div>
        <div><div role="row" aria-level="2" data-row-key="c1">Trip one</div><div role="row" aria-level="2" data-row-key="c2">Trip two</div><div role="row" aria-level="2" data-row-key="c3">Trip three</div></div></div>
      ${listItem(1, 'e9', 'Below the conversation')}`;
    place();
  }
  function place() {
    let y = 0;
    document.querySelectorAll<HTMLElement>('[role="treegrid"] > *').forEach((item) => {
      const top = y;
      item.querySelectorAll<HTMLElement>('[role="row"]').forEach((r, i) => { box(r, 260, y, 700, i === 0 ? ROW_H : CHILD_H); y += i === 0 ? ROW_H : CHILD_H; });
      box(item, 260, top, 700, y - top);
    });
  }
  const child = (key: string) => document.querySelector<HTMLElement>(`[aria-level="2"][data-row-key="${key}"]`)!;
  function watchAll() {
    paint();
    const els = [...document.querySelectorAll<HTMLElement>('[role="treegrid"] > *, [aria-level="2"]')];
    const before = new Map(els.map((el) => [el, drawn(el)]));
    return () => [...before].filter(([el, y]) => el.isConnected && drawn(el) !== y).map(([el]) => el.firstChild?.textContent?.trim());
  }

  it('closes its gap inside the conversation and below it at once, and nothing jumps when it goes', async () => {
    conversation();
    let answer!: (ok: boolean) => void;
    useEmailStore.setState({ deleteEmail: () => new Promise<boolean>((r) => { answer = r; }).then((ok) => { child('c2').remove(); place(); return ok; }) } as never);
    installMailMotion();
    const [three, below] = [child('c3'), row('e9')];
    const [threeAt, belowAt] = [drawn(three), drawn(below)];
    let jumps = watchAll();
    const p = useEmailStore.getState().deleteEmail(client, 'c2', false, 'c2');
    expect(slidOut('Trip two')).toBe(true);
    expect(jumps()).toEqual([]);
    expect(settled(three)).toBe(threeAt - CHILD_H);
    expect(settled(below)).toBe(belowAt - CHILD_H);
    jumps = watchAll();
    answer(true);
    await p;
    await frame();
    expect(jumps()).toEqual([]);
    expect(settled(three)).toBe(threeAt - CHILD_H);
    expect(settled(below)).toBe(belowAt - CHILD_H);
  });
  it('closes the gap once when the whole conversation follows one of its messages out', () => {
    conversation();
    useEmailStore.setState({
      deleteEmail: () => new Promise(() => {}),
      moveThreadToMailbox: () => new Promise(() => {}),
      emails: [{ id: 'c1', threadId: 'tc' }, { id: 'c2', threadId: 'tc' }, { id: 'c3', threadId: 'tc' }],
    } as never);
    installMailMotion();
    const below = row('e9');
    const belowAt = drawn(below);
    void useEmailStore.getState().deleteEmail(client, 'c2', false, 'c2');
    void useEmailStore.getState().moveThreadToMailbox(client, 'c1', 'mb-work');
    expect(settled(below)).toBe(belowAt - ROW_H - 3 * CHILD_H);
  });

  it('fades a message back into the open conversation and makes room for it', async () => {
    conversation();
    child('c2').remove();
    place();
    useEmailStore.setState({
      restoreEmails: async () => {
        child('c1').insertAdjacentHTML('afterend', '<div role="row" tabindex="-1" aria-level="2" data-row-key="c2">Trip two</div>');
        place();
      },
    } as never);
    installMailMotion();
    const [three, below] = [child('c3'), row('e9')];
    const [threeAt, belowAt] = [drawn(three), drawn(below)];
    const jumps = watchAll();
    await useEmailStore.getState().restoreEmails(client, [{ client, points: [{ id: 'c2', mailboxIds: {}, keywords: {} }] }] as never);
    await frame();
    expect(on(child('c2')).some((a) => a.keyframes[0].opacity === 0 && a.keyframes.at(-1)!.opacity === 1)).toBe(true);
    expect(jumps()).toEqual([]);
    expect(settled(three)).toBe(threeAt + CHILD_H);
    expect(settled(below)).toBe(belowAt + CHILD_H);
  });

  it('keeps the conversation still when its newest message leaves', async () => {
    conversation();
    let answer!: (ok: boolean) => void;
    useEmailStore.setState({
      deleteEmail: () => new Promise<boolean>((r) => { answer = r; }).then((ok) => {
        child('c1').remove();
        const head = document.querySelector<HTMLElement>('[data-thread-keys]')!;
        head.setAttribute('data-row-key', 'c2');
        head.setAttribute('data-thread-keys', 'c2 c3');
        place();
        return ok;
      }),
    } as never);
    installMailMotion();
    const head = document.querySelector<HTMLElement>('[data-thread-keys]')!;
    const [two, below] = [child('c2'), row('e9')];
    const [headAt, twoAt, belowAt] = [drawn(head), drawn(two), drawn(below)];
    let jumps = watchAll();
    const p = useEmailStore.getState().deleteEmail(client, 'c1', false, 'c1');
    expect(slidOut('Trip one')).toBe(true);
    expect(jumps()).toEqual([]);
    expect(settled(head)).toBe(headAt);
    expect(settled(two)).toBe(twoAt - CHILD_H);
    expect(settled(below)).toBe(belowAt - CHILD_H);
    jumps = watchAll();
    answer(true);
    await p;
    await frame();
    expect(jumps()).toEqual([]);
    expect(settled(head)).toBe(headAt);
    expect(settled(two)).toBe(twoAt - CHILD_H);
    expect(settled(below)).toBe(belowAt - CHILD_H);
  });
});

describe('when the action does not happen', () => {
  it('keeps a way into the list for the keyboard while the message leaves, and gives it back if it stays', async () => {
    const list = document.getElementById('message-list')!;
    renderHook(() => useListboxFocus({ current: list }, 'e2', 0));
    let answer!: (ok: boolean) => void;
    useEmailStore.setState({ deleteEmail: () => new Promise<boolean>((r) => { answer = r; }) } as never);
    installMailMotion();
    const own = row('e2').querySelector<HTMLElement>('[role="row"]')!;
    const next = row('e3').querySelector<HTMLElement>('[role="row"]')!;
    own.focus();
    const p = useEmailStore.getState().deleteEmail(client, 'e2');
    expect(own.getAttribute('tabindex')).toBe('-1');
    expect(next.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(next);
    answer(false);
    await p;
    expect(own.getAttribute('tabindex')).toBe('0');
    expect(next.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(own);
  });

  it('keeps the Tab stop off the leaving message when the list draws again', async () => {
    const list = document.getElementById('message-list')!;
    const { rerender } = renderHook(({ v }) => useListboxFocus({ current: list }, 'e2', v), { initialProps: { v: 0 } });
    let answer!: (ok: boolean) => void;
    useEmailStore.setState({ deleteEmail: () => new Promise<boolean>((r) => { answer = r; }) } as never);
    installMailMotion();
    const own = row('e2').querySelector<HTMLElement>('[role="row"]')!;
    const next = row('e3').querySelector<HTMLElement>('[role="row"]')!;
    own.focus();
    const p = useEmailStore.getState().deleteEmail(client, 'e2');
    rerender({ v: 1 });
    await frame();
    expect(own.getAttribute('tabindex')).toBe('-1');
    expect(next.getAttribute('tabindex')).toBe('0');
    answer(false);
    await p;
    expect(own.getAttribute('tabindex')).toBe('0');
    expect(next.getAttribute('tabindex')).toBe('-1');
  });

  it('gives the focus back after the list handed it on to another row', async () => {
    const list = document.getElementById('message-list')!;
    const other = row('e1').querySelector<HTMLElement>('[role="row"]')!;
    list.addEventListener('focus', (e) => { if (e.target === list) other.focus(); });
    useEmailStore.setState({ deleteEmail: async () => false } as never);
    installMailMotion();
    const own = row('e2').querySelector<HTMLElement>('[role="row"]')!;
    own.focus();
    await useEmailStore.getState().deleteEmail(client, 'e2');
    expect(document.activeElement).toBe(own);
  });

  it('gives the message back to the keyboard, screen readers and the focus', async () => {
    fakeActions(false);
    const el = row('e1');
    const own = el.querySelector<HTMLElement>('[role="row"]')!;
    own.focus();
    await useEmailStore.getState().deleteEmail(client, 'e1');
    expect(el.hasAttribute('inert')).toBe(false);
    expect(el.hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement).toBe(own);
  });

  it('shows the message again when the action is turned down, and passes on its answer', async () => {
    fakeActions(false);
    const el = row('e1');
    const below = row('e2');
    const result = await useEmailStore.getState().deleteEmail(client, 'e1');
    expect(result).toBe(false);
    expect(hidden(el)).toBe(false);
    expect(copies()).toHaveLength(0);
    expect(settled(below)).toBe(ROW_H);
  });

  it('shows the message again and rethrows when the server fails', async () => {
    const err = new Error('server said no');
    fakeActions(err);
    const el = row('e1');
    await expect(useEmailStore.getState().deleteEmail(client, 'e1')).rejects.toBe(err);
    expect(hidden(el)).toBe(false);
  });

  it('shows a row at once when the list reuses it for another message', async () => {
    useEmailStore.setState({
      deleteEmail: async () => { row('e1').firstElementChild!.setAttribute('data-row-key', 'e2b'); return true; },
    } as never);
    installMailMotion();
    const el = row('e1');
    await useEmailStore.getState().deleteEmail(client, 'e1');
    await frame();
    expect(hidden(el)).toBe(false);
    expect(on(el).some((a) => a.keyframes[0].opacity === 0 && a.keyframes.at(-1)!.opacity === 1)).toBe(false);
  });

  it.each([['the row below', 2], ['the leaving row', 1]])(
    'leaves the Tab stop and the focus to the list when another folder takes the rows, and the list picks %s',
    async (_, pick) => {
      const rows = ['e1', 'e2', 'e3'].map((id) => row(id).querySelector<HTMLElement>('[role="row"]')!);
      const own = rows[1];
      let answer!: (ok: boolean) => void;
      useEmailStore.setState({ deleteEmail: () => new Promise<boolean>((r) => { answer = r; }) } as never);
      installMailMotion();
      own.setAttribute('tabindex', '0');
      own.focus();
      const p = useEmailStore.getState().deleteEmail(client, 'e2');
      // Another folder opens while the server answers: the list draws its
      // messages in the same rows and puts its Tab stop on one of them.
      rows.forEach((r, i) => {
        r.setAttribute('data-row-key', `n${i + 1}`);
        r.setAttribute('tabindex', i === pick ? '0' : '-1');
      });
      await frame();
      answer(true);
      await p;
      await frame();
      expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(rows.map((_, i) => (i === pick ? '0' : '-1')));
      expect(document.activeElement).not.toBe(own);
    },
  );
});

describe('the fading copy', () => {
  it('stays under what floats over the list, such as the Compose button', () => {
    const list = document.getElementById('message-list')!;
    list.style.position = 'relative';
    list.insertAdjacentHTML('beforeend', '<button style="position: absolute; z-index: 30">Compose</button>');
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    void useEmailStore.getState().deleteEmail(client, 'e2');
    expect(copies()).toHaveLength(1);
    expect(Number(copies()[0].style.zIndex)).toBeLessThan(30);
  });

  it('still shows when the list sits in a raised layer', () => {
    const list = document.getElementById('message-list')!;
    const pane = document.createElement('div');
    pane.style.position = 'fixed';
    pane.style.zIndex = '60';
    list.replaceWith(pane);
    pane.appendChild(list);
    useEmailStore.setState({ deleteEmail: () => new Promise(() => {}) } as never);
    installMailMotion();
    void useEmailStore.getState().deleteEmail(client, 'e2');
    expect(Number(copies()[0].style.zIndex)).toBeGreaterThanOrEqual(60);
  });
});

describe('the store', () => {
  it('wraps each action once, however often it is installed', () => {
    fakeActions();
    const once = useEmailStore.getState().deleteEmail;
    installMailMotion();
    installMailMotion();
    expect(useEmailStore.getState().deleteEmail).toBe(once);
  });

  it('animates nothing with Reduce motion on, and still runs the action', async () => {
    fakeActions();
    document.documentElement.dataset.motion = 'reduce';
    await useEmailStore.getState().deleteEmail(client, 'e1');
    await frame();
    expect(animations).toHaveLength(0);
    expect(calls).toEqual(['deleteEmail']);
  });
});
