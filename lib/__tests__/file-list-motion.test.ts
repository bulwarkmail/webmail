import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { departing, departFiles } from '../file-list-motion';

type Recorded = { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancelled: boolean; anim: Animation; index: number };
let animations: Recorded[] = [];
let painted = 0;
const fresh = (r: Recorded) => r.index >= painted;

function fakeAnimate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  const rec = { el: this, keyframes, options, cancelled: false, index: animations.length } as Recorded;
  let at: number | undefined;
  rec.anim = {
    onfinish: null,
    cancel() { rec.cancelled = true; },
    get playState() { return rec.cancelled ? 'idle' : fresh(rec) && (at ?? 0) < Number(options.duration) ? 'running' : 'finished'; },
    get currentTime() { return at ?? (fresh(rec) ? 0 : Number(options.duration)); },
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
const offset = (el: Element) => {
  const m = lastOf(el, moving);
  const h = lastOf(el, holding);
  const pm = m ? parse((Number(m.anim.currentTime) > 0 ? m.keyframes.at(-1)! : m.keyframes[0]).transform) : { x: 0, y: 0 };
  const ph = h ? parse(h.keyframes[0].translate) : { x: 0, y: 0 };
  return { x: pm.x + ph.x, y: pm.y + ph.y };
};
type Spot = { x: number; y: number; w: number; h: number };
let arrange: () => Map<Element, Spot> = () => new Map();
const visible = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => el.style.display !== 'none');
const base = (el: Element) => arrange().get(el) ?? { x: 0, y: 0, w: 0, h: 0 };
function live(fn: () => Map<Element, Spot>) {
  arrange = fn;
  document.querySelectorAll<HTMLElement>('h3, [data-resource]').forEach((el) => {
    el.getBoundingClientRect = () => {
      const b = base(el);
      const o = offset(el);
      return { x: b.x + o.x, y: b.y + o.y, left: b.x + o.x, top: b.y + o.y, width: b.w, height: b.h, right: b.x + o.x + b.w, bottom: b.y + o.y + b.h, toJSON: () => ({}) } as DOMRect;
    };
  });
}

function setup(grid = false) {
  document.body.innerHTML = `
    <div id="list">${['a.txt', 'b.txt', 'c.txt'].map((n, i) => `<div data-resource="${n}" tabindex="${i ? -1 : 0}">${n}</div>`).join('')}</div>`;
  live(() => new Map(visible('[data-resource]').map((el, i) => [el,
    grid ? { x: (i % 2) * 200, y: Math.floor(i / 2) * 200, w: 180, h: 180 } : { x: 0, y: i * 40, w: 800, h: 40 }])));
}

const at = (el: Element) => { const r = el.getBoundingClientRect(); return [r.left, r.top]; };
const settled = (el: Element) => { paint(); return at(el); };
function watch() {
  paint();
  const before = new Map(visible('h3, [data-resource]').map((el) => [el, at(el).join()]));
  return () => [...before].filter(([el, p]) => el.isConnected && el.style.display !== 'none' && at(el).join() !== p).map(([el]) => el.textContent);
}

const file = (name: string) => document.querySelector<HTMLElement>(`[data-resource="${name}"]`)!;
const on = (el: Element) => animations.filter((a) => a.el === el);
const copies = () => [...document.querySelectorAll<HTMLElement>('[data-motion-ghost]')];
const slides = () => copies().flatMap(on);
const hidden = (el: HTMLElement) => el.style.display === 'none';
const frame = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  animations = [];
  painted = 0;
  Element.prototype.animate = fakeAnimate as unknown as Element['animate'];
  delete document.documentElement.dataset.motion;
  window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
  setup();
});
afterEach(async () => { document.body.innerHTML = ''; await Promise.resolve(); });

describe('a file leaving the list', () => {
  it('fades away where it was, without moving, and is hidden', () => {
    departFiles(['b.txt']);
    expect(copies().map((c) => c.textContent)).toEqual(['b.txt']);
    expect(slides()[0].keyframes.at(-1)).toEqual({ opacity: 0 });
    expect(hidden(file('b.txt'))).toBe(true);
  });

  it('is quick: the copy is gone in a sixth of a second', () => {
    departFiles(['b.txt']);
    expect(slides()[0].options.duration).toBeLessThanOrEqual(170);
  });

  it('fades several files away together, none waiting for another', () => {
    departFiles(['a.txt', 'b.txt']);
    expect(slides()).toHaveLength(2);
    expect(slides().every((sl) => !sl.options.delay)).toBe(true);
  });

  it('closes the gap at once, while the server still answers', () => {
    const jumps = watch();
    departFiles(['a.txt']);
    expect(jumps()).toEqual([]);
    expect(settled(file('b.txt'))).toEqual([0, 0]);
    expect(settled(file('c.txt'))).toEqual([0, 40]);
  });

  it('keeps the files where they rose to once the list drops the file', async () => {
    let answer!: () => void;
    const p = departing(['a.txt'], () => new Promise<number>((r) => { answer = () => { file('a.txt').remove(); r(1); }; }));
    const jumps = watch();
    answer();
    await p;
    await frame();
    expect(jumps()).toEqual([]);
    expect(settled(file('b.txt'))).toEqual([0, 0]);
  });

  it('moves grid tiles along into the gap, across and up, at once', () => {
    setup(true);
    const jumps = watch();
    departFiles(['a.txt']);
    expect(jumps()).toEqual([]);
    expect(settled(file('b.txt'))).toEqual([0, 0]);
    expect(settled(file('c.txt'))).toEqual([200, 0]);
  });

  it('puts everything back when the file stays', async () => {
    const jumps = watch();
    await departing(['a.txt'], async () => 0);
    expect(jumps()).toEqual([]);
    expect(settled(file('b.txt'))).toEqual([0, 40]);
  });
});

describe('a group the list empties', () => {
  it('fades its heading where it was, while the files below rise', async () => {
    document.body.innerHTML = `
      <div role="grid">
        <div role="rowgroup"><h3>Folders</h3><div role="row"><div data-resource="Docs">Docs</div></div></div>
        <div role="rowgroup"><h3>Files</h3><div role="row"><div data-resource="a.txt">a.txt</div></div></div>
      </div>`;
    live(() => {
      let y = 0;
      return new Map(visible('h3, [data-resource]').filter((el) => el.isConnected).map((el) => {
        const h = el.tagName === 'H3' ? 20 : 180;
        const spot = { x: 0, y, w: 180, h };
        y += h;
        return [el, spot];
      }));
    });
    let jumps = watch();
    await departing(['Docs'], async () => {
      expect(jumps()).toEqual([]);
      expect(settled(file('a.txt'))).toEqual([0, 40]);
      jumps = watch();
      document.querySelector('[role="rowgroup"]')!.remove();
      document.querySelector('h3')!.remove();
      return 1;
    });
    const faded = (text: string) => copies().some((c) => c.textContent === text && on(c).some((a) => a.keyframes.at(-1)!.opacity === 0));
    expect(faded('Folders') && faded('Files')).toBe(true);
    expect(jumps()).toEqual([]);
    expect(settled(file('a.txt'))).toEqual([0, 0]);
  });
});

describe('reduce motion', () => {
  it('animates nothing when Reduce motion is on in the app', () => {
    document.documentElement.dataset.motion = 'reduce';
    departFiles(['a.txt']);
    expect(animations).toHaveLength(0);
  });

  it('animates nothing when the system asks for reduced motion and the app follows it', () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q })) as unknown as typeof window.matchMedia;
    departFiles(['a.txt']);
    expect(animations).toHaveLength(0);
  });

  it('animates when the app overrides the system with Reduce motion off', () => {
    document.documentElement.dataset.motion = 'full';
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q })) as unknown as typeof window.matchMedia;
    departFiles(['a.txt']);
    expect(animations.length).toBeGreaterThan(0);
  });
});

describe('departing()', () => {
  it('gives the keyboard focus back to the file when the action does not happen', async () => {
    file('b.txt').tabIndex = 0;
    file('b.txt').focus();
    await departing(['b.txt'], async () => {
      (document.activeElement as HTMLElement).blur();
      return 0;
    });
    expect(document.activeElement).toBe(file('b.txt'));
  });
  it('hands the keyboard focus to the next file while the server answers', async () => {
    file('b.txt').focus();
    let answer!: (n: number) => void;
    const p = departing(['b.txt'], () => new Promise<number>((r) => { answer = r; }));
    expect(document.activeElement).toBe(file('c.txt'));
    answer(0);
    await p;
    expect(document.activeElement).toBe(file('b.txt'));
  });
  it('hands the focus to the file before when the last one leaves', async () => {
    file('c.txt').focus();
    let answer!: (n: number) => void;
    const p = departing(['b.txt', 'c.txt'], () => new Promise<number>((r) => { answer = r; }));
    expect(document.activeElement).toBe(file('a.txt'));
    answer(2);
    await p;
  });
  it('passes the result through and shows the file again when nothing happened', async () => {
    const result = await departing(['a.txt'], async () => 0);
    expect(result).toBe(0);
    expect(hidden(file('a.txt'))).toBe(false);
    expect(copies()).toHaveLength(0);
  });

  it('shows the file again and rethrows when the action fails', async () => {
    const err = new Error('server said no');
    await expect(departing(['a.txt'], async () => { throw err; })).rejects.toBe(err);
    expect(hidden(file('a.txt'))).toBe(false);
  });

  it('keeps the file hidden while the list has not caught up yet', async () => {
    const result = await departing(['a.txt'], async () => 1);
    expect(result).toBe(1);
    expect(hidden(file('a.txt'))).toBe(true);
  });
});
