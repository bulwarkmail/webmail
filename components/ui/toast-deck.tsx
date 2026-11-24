"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { CheckCircle } from "@/components/icons";
import { cn } from "@/lib/utils";
import { TOUCH_HIT_AREA } from "@/components/ui/button";
import type { DeckCard, Toast } from "@/components/ui/toast";
import { TOAST_EASE as EASE, TOAST_FADE_MS, TOAST_LEAVE_MS, TOAST_MOVE_MS, TOAST_STAGGER_MS } from "@/lib/toast-motion";

const GAP = 8;
const EDGE_ROOM = 12;
const MIN_STEP = 36;

export function deckPeeks(depth: number | undefined): { offset: number; scale: number }[] {
  const n = Math.max(0, depth ?? 0);
  const step = n <= 3 ? 7 : Math.max(3, 24 / n);
  const shrink = Math.min(0.04, 0.2 / Math.max(n, 1));
  return Array.from({ length: n }, (_, i) => ({ offset: Number(((i + 1) * step).toFixed(2)), scale: Number((1 - (i + 1) * shrink).toFixed(4)) }));
}

const FRONT = "translateY(0px) scale(1)";
const move = (delay = 0) => `transform ${TOAST_MOVE_MS}ms ${EASE} ${delay}ms, box-shadow ${TOAST_MOVE_MS}ms ${EASE} ${delay}ms`;
const fade = (delay = 0) => `opacity ${TOAST_FADE_MS}ms ${EASE} ${delay}ms`;
const GAP_WAIT = TOAST_STAGGER_MS * 3;
const FOLD_WAIT = TOAST_STAGGER_MS * 2;

function motionAllowed(el: Element | null): el is HTMLElement {
  if (!el || typeof (el as HTMLElement).animate !== "function") return false;
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function slideOut(el: HTMLElement): string {
  const dir = getComputedStyle(el).direction === "rtl" ? -1 : 1;
  return `translateX(calc((100% + 1.25rem) * ${dir}))`;
}

const cardFace = cn(
  "rounded-md bg-popover text-popover-foreground border border-border",
  "shadow-[0_6px_16px_rgb(0,0,0,0.1)] dark:shadow-[0_6px_16px_rgb(0,0,0,0.4)]",
);

function Face({ card, onUndo }: { card: Pick<DeckCard, "title" | "message"> & { action?: DeckCard["action"] }; onUndo?: () => void }) {
  return (
    <div data-deck-face="" className="flex items-start gap-2.5 overflow-hidden pt-3 pe-2.5 pb-3.5 ps-3.5">
      <CheckCircle className="w-[18px] h-[18px] flex-shrink-0 mt-px text-muted-foreground" />
      <div className="flex-1 min-w-0 pt-px">
        <p className="text-[0.84375rem] font-medium text-foreground leading-snug truncate">{card.title}</p>
        {card.message && <p className="text-[0.78125rem] mt-0.5 text-muted-foreground leading-snug truncate">{card.message}</p>}
      </div>
      {card.action && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onUndo?.();
          }}
          className={cn(
            "flex-shrink-0 text-[0.8125rem] font-semibold text-foreground px-1.5 py-0.5 me-8 rounded-md transition-colors",
            TOUCH_HIT_AREA,
            "underline underline-offset-[3px] hover:bg-foreground/5",
          )}
        >
          {card.action.label}
        </button>
      )}
    </div>
  );
}

interface Leaving {
  key: string;
  title: string;
  message?: string;
  transform: string;
  z: number;
  index?: number;
}

function LeavingCard({ card, height, onGone }: { card: Leaving; height: number; onGone: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!motionAllowed(el)) {
      onGone(card.key);
      return;
    }
    const motion = el.animate(
      [
        { transform: card.transform, opacity: 1 },
        { opacity: 1, offset: 0.4 },
        { transform: `${card.transform} ${slideOut(el)}`, opacity: 0 },
      ],
      { duration: TOAST_LEAVE_MS, easing: EASE, fill: "forwards" },
    );
    motion.finished?.then(() => onGone(card.key), () => onGone(card.key));
  }, [card, onGone]);
  return (
    <div
      ref={ref}
      data-deck-leaving=""
      aria-hidden="true"
      className={cn("absolute inset-x-0 bottom-0 origin-top", cardFace)}
      style={{ transform: card.transform, zIndex: card.z, height: height || "100%" }}
    >
      <Face card={card} />
    </div>
  );
}

function BehindCard({
  card, index, transform, open, folding, delay, height, laid, leaving, keyboard,
}: {
  card: DeckCard; index: number; transform: string; open: boolean; folding: boolean; delay: number; height: number; laid: boolean; leaving: boolean; keyboard: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const placeRef = useRef({ transform, laid });
  placeRef.current = { transform, laid };
  useLayoutEffect(() => {
    const { transform: to, laid: fromFront } = placeRef.current;
    if (!fromFront || !motionAllowed(ref.current)) return;
    ref.current.animate([{ transform: FRONT }, { transform: to }], { duration: TOAST_MOVE_MS, easing: EASE });
    contentRef.current?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: TOAST_FADE_MS, easing: EASE });
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!leaving || !motionAllowed(el)) return;
    const { transform: from } = placeRef.current;
    el.animate(
      [{ transform: from, opacity: 1 }, { transform: `${from} ${slideOut(el)}`, opacity: 0 }],
      { duration: TOAST_LEAVE_MS, easing: EASE, fill: "forwards" },
    );
  }, [leaving]);
  return (
    <div
      ref={ref}
      data-deck-card=""
      data-expanded={open ? "true" : undefined}
      aria-hidden={open ? undefined : "true"}
      inert={!open}
      className={cn(
        "absolute inset-x-0 bottom-0 origin-top",
        cardFace,
        "after:absolute after:inset-x-0 after:top-full after:h-2 after:content-['']",
        !open && "shadow-[0_-2px_6px_rgb(0,0,0,0.08)] dark:shadow-[0_-2px_6px_rgb(0,0,0,0.35)]",
      )}
      style={{ transform, zIndex: -(index + 1), height: height || "100%", transition: move(open ? delay : folding ? FOLD_WAIT : 0) }}
    >
      <div ref={contentRef} className={cn("h-full", open ? "opacity-100" : "opacity-0")} style={{ transition: fade(open ? FOLD_WAIT : 0) }}>
        <Face
          card={card}
          onUndo={() => {
            const handOff = keyboard && ref.current?.contains(document.activeElement);
            card.action.onClick();
            if (handOff) ref.current?.parentElement?.querySelector<HTMLElement>("[data-deck-front] button:not([data-toast-close])")?.focus();
          }}
        />
      </div>
    </div>
  );
}

export function UndoDeck({
  toast, expanded, children,
}: {
  toast: Toast;
  expanded: boolean;
  children: (onExit: () => void, holding: boolean) => React.ReactNode;
}) {
  const behind = toast.behind ?? [];
  const frontRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [frontTop, setFrontTop] = useState(Infinity);
  const [keyboardIn, setKeyboardIn] = useState(false);
  const pointerDownRef = useRef(false);
  const [exiting, setExiting] = useState(false);
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  const open = (expanded || keyboardIn) && !exiting && behind.length > 0;
  const [folding, setFolding] = useState(false);
  const wasOpenRef = useRef(open);
  useLayoutEffect(() => {
    const was = wasOpenRef.current;
    wasOpenRef.current = open;
    if (open) {
      setFolding(false);
      return;
    }
    if (!was) return;
    setFolding(true);
    const done = setTimeout(() => setFolding(false), FOLD_WAIT + TOAST_MOVE_MS);
    return () => clearTimeout(done);
  }, [open]);

  useLayoutEffect(() => {
    const el = frontRef.current;
    if (!el) return;
    const measure = () => {
      setHeight(el.offsetHeight);
      setFrontTop(el.getBoundingClientRect().top);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const sizes = new ResizeObserver(measure);
    sizes.observe(el);
    return () => sizes.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (open && frontRef.current) setFrontTop(frontRef.current.getBoundingClientRect().top);
  }, [open]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState(0);
  useLayoutEffect(() => {
    let tallest = 0;
    for (const face of wrapRef.current?.querySelectorAll<HTMLElement>("[data-deck-card] [data-deck-face]") ?? []) {
      tallest = Math.max(tallest, face.offsetHeight + 2);
    }
    if (tallest !== natural) setNatural(tallest);
  });

  const peeks = deckPeeks(behind.length);
  const row = Math.max(height, natural);
  const cardHeight = open ? row : height;
  const room = height > 0 && Number.isFinite(frontTop) ? frontTop - EDGE_ROOM : Infinity;
  const fit = behind.length > 1 ? (room - GAP - row) / (behind.length - 1) : Infinity;
  const step = Math.min(row + GAP, Math.max(MIN_STEP, fit));
  const transformAt = (i: number) => {
    if (!open) return `translateY(${-peeks[i].offset}px) scale(${peeks[i].scale})`;
    return `translateY(${-(height + GAP + i * step)}px) scale(1)`;
  };

  const prevRef = useRef<{ cardId?: string; title: string; message?: string; behind: Map<string, Leaving> } | null>(null);
  const prev = prevRef.current;
  const popped = !!prev && open && !!toast.cardId && prev.cardId !== toast.cardId && prev.behind.has(toast.cardId);
  const layout = `${open}|${toast.cardId}|${behind.map((c) => c.id).join(",")}`;
  const cascadeRef = useRef<{ layout: string; delays: number[] }>({ layout: "", delays: [] });
  if (cascadeRef.current.layout !== layout) {
    let shifted = popped ? 1 : 0;
    const delays = behind.map((c, i) => {
      const was = prev?.behind.get(c.id)?.index;
      if (!open || was === undefined || was <= i) return 0;
      return GAP_WAIT + shifted++ * TOAST_STAGGER_MS;
    });
    cascadeRef.current = { layout, delays };
  }
  const delays = cascadeRef.current.delays;

  useLayoutEffect(() => {
    const before = prevRef.current;
    const ids = new Set([toast.cardId, ...behind.map((c) => c.id)]);
    if (before) {
      const gone: Leaving[] = [];
      if (before.cardId && !ids.has(before.cardId)) {
        gone.push({ key: before.cardId, title: before.title, message: before.message, transform: FRONT, z: 1 });
      }
      for (const [id, card] of before.behind) if (!ids.has(id)) gone.push(open ? { ...card, z: 1 } : card);
      if (gone.length > 0) setLeaving((list) => [...list, ...gone]);

      const front = frontRef.current;
      if (before.cardId && before.cardId !== toast.cardId && motionAllowed(front)) {
        if (behind.some((c) => c.id === before.cardId)) {
          front.animate(
            [{ transform: slideOut(front), opacity: 0 }, { transform: "none", opacity: 1 }],
            { duration: TOAST_MOVE_MS, easing: EASE },
          );
        } else {
          const from = toast.cardId ? before.behind.get(toast.cardId) : undefined;
          if (from && open) {
            front.animate(
              [{ transform: from.transform, opacity: 0.85 }, { transform: FRONT, opacity: 1 }],
              { duration: TOAST_MOVE_MS, delay: GAP_WAIT, easing: EASE, fill: "backwards" },
            );
          } else if (from) {
            front.animate(
              [{ transform: from.transform, opacity: 0.85 }, { transform: FRONT, opacity: 1 }],
              { duration: TOAST_MOVE_MS, easing: EASE },
            );
          }
        }
      }
    }
    const wrap = wrapRef.current;
    if (keyboardIn && wrap && (!document.activeElement || document.activeElement === document.body)) {
      wrap.querySelector<HTMLElement>("[data-deck-front] button:not([data-toast-close])")?.focus();
    }
    prevRef.current = {
      cardId: toast.cardId,
      title: toast.title,
      message: toast.message,
      behind: new Map(behind.map((c, i) => [c.id, { key: c.id, title: c.title, message: c.message, transform: transformAt(i), z: -(i + 1), index: i }])),
    };
  });

  const gone = useCallback((key: string) => setLeaving((list) => list.filter((c) => c.key !== key)), []);

  return (
    <div
      ref={wrapRef}
      className="relative isolate"
      style={{ pointerEvents: "auto", marginTop: peeks.at(-1)?.offset ?? 0, transition: `margin ${TOAST_MOVE_MS}ms ${EASE}` }}
      onPointerDown={() => { pointerDownRef.current = true; }}
      onPointerUp={() => { pointerDownRef.current = false; }}
      onFocus={() => { if (!pointerDownRef.current) setKeyboardIn(true); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyboardIn(false); }}
    >
      {behind.map((card, i) => (
        <BehindCard
          key={card.id}
          card={card}
          index={i}
          transform={transformAt(i)}
          open={open}
          folding={folding}
          delay={delays[i]}
          height={cardHeight}
          laid={!!prev && card.id === prev.cardId}
          leaving={exiting}
          keyboard={keyboardIn}
        />
      ))}
      {leaving.map((card) => (
        <LeavingCard key={`leaving-${card.key}`} card={card} height={cardHeight} onGone={gone} />
      ))}
      <div ref={frontRef} data-deck-front="">
        {children(() => setExiting(true), keyboardIn)}
      </div>
    </div>
  );
}
