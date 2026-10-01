"use client";

import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  Ban,
  Inbox,
  Play,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldFilled,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { cn } from "@/lib/utils";

const ROUND_MS = 30_000;
const LIVES = 3;
const CARD_MAX_WIDTH = 160;
const CARD_HEIGHT = 44;
const EDGE = 8;
const SPAWN_START_MS = 900;
const SPAWN_MIN_MS = 380;
const SPAWN_RAMP_PER_S = 20;
// Fall speed is a share of the field height per second, so a short phone
// screen leaves as much time to react as a tall desktop one.
const FALL_START = 0.15;
const FALL_RAMP_PER_S = 0.006;
// Animation frames stop while the tab is in the background. Clamping the step
// keeps the first frame back from dropping every card into the inbox at once.
const MAX_STEP_MS = 50;
const EXIT_MS = 400;
const POP_MS = 700;
const FLASH_MS = 280;
const COMBO_STEP = 5;
const COMBO_MAX = 3;
const BLOCKED_PENALTY = 15;
const BEST_KEY = "spam-siege-best";

type Kind = "spam" | "phishing" | "legit";
type Phase = "idle" | "playing" | "over";

interface Sender {
  name: string;
  address: string;
}

// Senders use reserved .example domains, like the demo fixtures, so no card
// imitates a real brand.
const SENDERS: Record<Kind, readonly Sender[]> = {
  spam: [
    { name: "Prize Center", address: "winner@totallylegit.example" },
    { name: "Promo Store", address: "deals@promostore.example" },
    { name: "Crypto Gains", address: "moon@crypto-gains.example" },
    { name: "Mega Lotto", address: "claim@mega-lotto.example" },
    { name: "SEO Wizard", address: "rank1@seo-wizard.example" },
    { name: "Miracle Diet", address: "slim@miracle-diet.example" },
  ],
  phishing: [
    { name: "Secure Banking", address: "security-alert@secur1ty-bank.example" },
    { name: "IT Helpdesk", address: "reset@c0mpany-it.example" },
    { name: "Payroll Update", address: "hr@payro11-portal.example" },
    { name: "Mailbox Quota", address: "admin@mail-quota.example" },
    { name: "Parcel Service", address: "redeliver@parce1-track.example" },
    { name: "Bulwark Support", address: "verify@bulvvark-mail.example" },
  ],
  legit: [
    { name: "Alice Johnson", address: "alice.johnson@example.com" },
    { name: "Bob Chen", address: "bob.chen@example.com" },
    { name: "Sofia Russo", address: "sofia.russo@example.com" },
    { name: "Sarah Kim", address: "sarah.kim@example.com" },
    { name: "Maria Lopez", address: "maria.lopez@company.example" },
    { name: "Michael Torres", address: "michael.torres@company.example" },
  ],
};

// Cool tones only, so a real sender's avatar never reads as a warning colour.
const LEGIT_TONES = ["#3b82f6", "#10b981", "#8b5cf6", "#0ea5e9", "#6366f1", "#14b8a6"];

const POINTS: Record<Kind, number> = { spam: 10, phishing: 15, legit: 5 };

interface Mail {
  id: number;
  kind: Kind;
  sender: Sender;
  tone: string;
  x: number;
  y: number;
  /** Field heights per millisecond. */
  speed: number;
  fate: "caught" | "blocked" | null;
  fateAt: number;
}

interface Pop {
  id: number;
  x: number;
  y: number;
  text: string;
  good: boolean;
}

interface Result {
  held: boolean;
  score: number;
  caught: number;
  delivered: number;
  mistakes: number;
  newBest: boolean;
}

function comboFor(streak: number): number {
  return Math.min(COMBO_MAX, 1 + Math.floor(streak / COMBO_STEP));
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();
}

function readBest(): number {
  try {
    const value = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeBest(score: number) {
  try {
    localStorage.setItem(BEST_KEY, String(score));
  } catch {
    /* private mode: the best score just isn't kept */
  }
}

function freshGame() {
  return {
    mails: [] as Mail[],
    nextId: 0,
    nextPopId: 0,
    flashToken: 0,
    elapsed: 0,
    spawnIn: 250,
    last: 0,
    second: ROUND_MS / 1000,
    score: 0,
    lives: LIVES,
    streak: 0,
    caught: 0,
    delivered: 0,
    mistakes: 0,
    running: false,
  };
}

export function SpamSiegeGame({ onClose }: { onClose: () => void }) {
  const t = useTranslations("settings.advanced.spam_siege");
  const tCommon = useTranslations("common");
  const tMailboxes = useTranslations("sidebar.mailboxes");
  const titleId = useId();

  const [phase, setPhase] = useState<Phase>("idle");
  const [mails, setMails] = useState<Mail[]>([]);
  const [pops, setPops] = useState<Pop[]>([]);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(LIVES);
  const [combo, setCombo] = useState(1);
  const [secondsLeft, setSecondsLeft] = useState(ROUND_MS / 1000);
  const [delivered, setDelivered] = useState(0);
  const [flash, setFlash] = useState<"good" | "bad" | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [best, setBest] = useState(readBest);
  const [cardWidth, setCardWidth] = useState(CARD_MAX_WIDTH);

  const game = useRef(freshGame());
  const size = useRef({ w: 400, h: 400 });
  const nodes = useRef(new Map<number, HTMLDivElement>());
  const rafRef = useRef(0);
  const timers = useRef(new Set<number>());
  const fieldRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const againRef = useRef<HTMLButtonElement>(null);

  // The parent passes a new closure on every render; the focus trap re-runs
  // (and steals focus back to the first button) whenever onEscape changes.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const close = useCallback(() => onCloseRef.current(), []);

  const dialogRef = useFocusTrap({ isActive: true, onEscape: close, restoreFocus: true });

  useEffect(() => {
    if (phase === "idle") startRef.current?.focus();
    else if (phase === "over") againRef.current?.focus();
    else dialogRef.current?.focus();
  }, [phase, dialogRef]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      cancelAnimationFrame(rafRef.current);
      for (const id of pending) window.clearTimeout(id);
    };
  }, []);

  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    const measure = () => {
      size.current = { w: el.clientWidth, h: el.clientHeight };
      setCardWidth(Math.min(CARD_MAX_WIDTH, el.clientWidth - EDGE * 2));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
  }, []);

  const pop = useCallback(
    (x: number, y: number, text: string, good: boolean) => {
      const id = game.current.nextPopId++;
      setPops((list) => [...list, { id, x, y, text, good }]);
      later(() => setPops((list) => list.filter((p) => p.id !== id)), POP_MS);
    },
    [later]
  );

  const flashInbox = useCallback(
    (kind: "good" | "bad") => {
      const token = ++game.current.flashToken;
      setFlash(kind);
      later(() => {
        if (game.current.flashToken === token) setFlash(null);
      }, FLASH_MS);
    },
    [later]
  );

  const finish = useCallback((held: boolean) => {
    const g = game.current;
    g.running = false;
    g.mails = [];
    cancelAnimationFrame(rafRef.current);
    const previous = readBest();
    const newBest = g.score > previous;
    if (newBest) writeBest(g.score);
    setBest(Math.max(previous, g.score));
    setMails([]);
    setResult({
      held,
      score: g.score,
      caught: g.caught,
      delivered: g.delivered,
      mistakes: g.mistakes,
      newBest,
    });
    setPhase("over");
  }, []);

  const loseLife = useCallback(() => {
    const g = game.current;
    g.lives -= 1;
    g.streak = 0;
    g.mistakes += 1;
    setLives(g.lives);
    setCombo(1);
    flashInbox("bad");
    if (g.lives <= 0) finish(false);
  }, [finish, flashInbox]);

  const cardWidthNow = () => Math.min(CARD_MAX_WIDTH, size.current.w - EDGE * 2);

  const spawn = useCallback((): boolean => {
    const g = game.current;
    const cardW = cardWidthNow();
    const span = Math.max(0, size.current.w - cardW - EDGE * 2);
    // Don't drop a card on top of one that has only just come in.
    let x = -1;
    for (let attempt = 0; attempt < 8 && x < 0; attempt++) {
      const candidate = EDGE + Math.random() * span;
      const clear = g.mails.every(
        (m) => m.fate !== null || m.y > CARD_HEIGHT * 1.5 || Math.abs(m.x - candidate) > cardW + 6
      );
      if (clear) x = candidate;
    }
    if (x < 0) return false;

    const roll = Math.random();
    const kind: Kind = roll < 0.25 ? "legit" : roll < 0.55 ? "phishing" : "spam";
    const index = Math.floor(Math.random() * SENDERS[kind].length);
    const base = FALL_START + (g.elapsed / 1000) * FALL_RAMP_PER_S;
    g.mails.push({
      id: g.nextId++,
      kind,
      sender: SENDERS[kind][index],
      tone: LEGIT_TONES[index % LEGIT_TONES.length],
      x,
      y: -CARD_HEIGHT,
      speed: (base * (0.9 + Math.random() * 0.2)) / 1000,
      fate: null,
      fateAt: 0,
    });
    return true;
  }, []);

  const arrive = useCallback(
    (mail: Mail) => {
      const g = game.current;
      if (mail.kind === "legit") {
        const gain = POINTS.legit * comboFor(g.streak);
        g.streak += 1;
        g.score += gain;
        g.delivered += 1;
        setScore(g.score);
        setDelivered(g.delivered);
        setCombo(comboFor(g.streak));
        pop(mail.x + cardWidthNow() / 2, size.current.h - CARD_HEIGHT, `+${gain}`, true);
        flashInbox("good");
      } else {
        loseLife();
      }
    },
    [flashInbox, loseLife, pop]
  );

  const hit = useCallback(
    (id: number) => {
      const g = game.current;
      if (!g.running) return;
      const mail = g.mails.find((m) => m.id === id);
      if (!mail || mail.fate) return;
      mail.fateAt = performance.now();
      const x = mail.x + cardWidthNow() / 2;
      if (mail.kind === "legit") {
        mail.fate = "blocked";
        g.score = Math.max(0, g.score - BLOCKED_PENALTY);
        setScore(g.score);
        pop(x, mail.y, `−${BLOCKED_PENALTY}`, false);
        setMails([...g.mails]);
        loseLife();
      } else {
        mail.fate = "caught";
        const gain = POINTS[mail.kind] * comboFor(g.streak);
        g.streak += 1;
        g.score += gain;
        g.caught += 1;
        setScore(g.score);
        setCombo(comboFor(g.streak));
        pop(x, mail.y, `+${gain}`, true);
        setMails([...g.mails]);
      }
    },
    [loseLife, pop]
  );

  const start = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const g = freshGame();
    g.nextPopId = game.current.nextPopId;
    g.running = true;
    game.current = g;
    setMails([]);
    setPops([]);
    setScore(0);
    setLives(LIVES);
    setCombo(1);
    setSecondsLeft(ROUND_MS / 1000);
    setDelivered(0);
    setFlash(null);
    setResult(null);
    if (progressRef.current) progressRef.current.style.transform = "scaleX(1)";
    setPhase("playing");
  }, []);

  useEffect(() => {
    if (phase !== "playing") return;
    const g = game.current;
    g.last = performance.now();

    const frame = (now: number) => {
      if (!g.running) return;
      const step = Math.min(MAX_STEP_MS, Math.max(0, now - g.last));
      g.last = now;
      g.elapsed += step;

      if (progressRef.current) {
        progressRef.current.style.transform = `scaleX(${Math.max(0, 1 - g.elapsed / ROUND_MS)})`;
      }
      const second = Math.max(0, Math.ceil((ROUND_MS - g.elapsed) / 1000));
      if (second !== g.second) {
        g.second = second;
        setSecondsLeft(second);
      }
      if (g.elapsed >= ROUND_MS) {
        finish(true);
        return;
      }

      let changed = false;
      g.spawnIn -= step;
      if (g.spawnIn <= 0) {
        if (spawn()) {
          changed = true;
          g.spawnIn = Math.max(SPAWN_MIN_MS, SPAWN_START_MS - (g.elapsed / 1000) * SPAWN_RAMP_PER_S);
        } else {
          g.spawnIn = 120;
        }
      }

      const { w, h } = size.current;
      const maxX = Math.max(EDGE, w - cardWidthNow() - EDGE);
      const kept: Mail[] = [];
      for (const mail of g.mails) {
        if (mail.fate) {
          if (now - mail.fateAt < EXIT_MS) kept.push(mail);
          else changed = true;
          continue;
        }
        mail.y += mail.speed * step * h;
        if (mail.x > maxX) mail.x = maxX;
        if (mail.y >= h - CARD_HEIGHT) {
          changed = true;
          arrive(mail);
          if (!g.running) return;
          continue;
        }
        kept.push(mail);
        const node = nodes.current.get(mail.id);
        if (node) node.style.transform = `translate3d(${mail.x}px, ${mail.y}px, 0)`;
      }
      g.mails = kept;
      if (changed) setMails([...kept]);
      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase, spawn, arrive, finish]);

  // Close only when the press both started and ended on the backdrop, so a
  // drag that begins on a card and slips off the panel doesn't end the round.
  const pressedBackdrop = useRef(false);

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-50 p-4 animate-in fade-in duration-150"
      onPointerDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "bg-background border border-border rounded-lg shadow-xl outline-none",
          "w-full max-w-md max-h-full flex flex-col overflow-hidden select-none",
          "animate-in zoom-in-95 duration-200"
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-muted-foreground" />
            <h2 id={titleId} className="text-lg font-semibold text-foreground">
              {t("title")}
            </h2>
          </div>
          <button
            type="button"
            onClick={close}
            className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground"
            aria-label={tCommon("close")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-3 px-6 py-2.5 text-sm">
          <span className="text-muted-foreground">
            {t("score")}{" "}
            <span className="font-semibold text-foreground tabular-nums">{score}</span>
          </span>
          {combo > 1 && (
            <span
              dir="ltr"
              className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary tabular-nums"
              title={t("combo")}
            >
              ×{combo}
            </span>
          )}
          <span
            className="ms-auto flex items-center gap-0.5"
            role="img"
            aria-label={t("shields_left", { count: lives, total: LIVES })}
          >
            {Array.from({ length: LIVES }, (_, i) =>
              i < lives ? (
                <ShieldFilled key={i} className="w-4 h-4 text-primary" />
              ) : (
                <Shield key={i} className="w-4 h-4 text-muted-foreground/40" />
              )
            )}
          </span>
          <span className="w-9 text-end font-medium text-foreground tabular-nums">
            {t("seconds", { seconds: secondsLeft })}
          </span>
        </div>
        <div className="h-0.5 bg-muted">
          <div
            ref={progressRef}
            className="h-full bg-primary origin-left rtl:origin-right"
            style={{ transform: "scaleX(1)" }}
          />
        </div>

        <div
          ref={fieldRef}
          className={cn("relative overflow-hidden bg-muted/30", phase === "playing" && "touch-none")}
          style={{ height: "min(440px, calc(100dvh - 15rem))", minHeight: 220 }}
        >
          {mails.map((mail) => (
            <div
              key={mail.id}
              ref={(el) => {
                if (el) nodes.current.set(mail.id, el);
                else nodes.current.delete(mail.id);
              }}
              data-kind={mail.kind}
              className="absolute left-0 top-0 will-change-transform"
              style={{ transform: `translate3d(${mail.x}px, ${mail.y}px, 0)` }}
            >
              <MailCard
                kind={mail.kind}
                sender={mail.sender}
                tone={mail.tone}
                width={cardWidth}
                onPointerDown={(e) => {
                  e.preventDefault();
                  hit(mail.id);
                }}
                className={cn(
                  "cursor-pointer hover:bg-muted transition-colors",
                  mail.fate === "caught" &&
                    "pointer-events-none animate-out fade-out zoom-out-75 duration-300 fill-mode-forwards",
                  mail.fate === "blocked" && "pointer-events-none animate-shake border-destructive"
                )}
              />
            </div>
          ))}

          {pops.map((p) => (
            <span
              key={p.id}
              dir="ltr"
              className={cn(
                "pointer-events-none absolute -translate-x-1/2 text-sm font-semibold tabular-nums",
                "animate-out fade-out slide-out-to-top-6 duration-700 fill-mode-forwards",
                p.good ? "text-success" : "text-destructive"
              )}
              style={{ left: p.x, top: p.y }}
            >
              {p.text}
            </span>
          ))}

          {phase === "idle" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 overflow-y-auto bg-background/95 px-6 py-6 text-center">
              <p className="max-w-xs text-sm text-muted-foreground">{t("intro")}</p>
              <div className="flex flex-col gap-2">
                {(["spam", "phishing", "legit"] as const).map((kind) => (
                  <div key={kind} className="flex items-center gap-3 text-start">
                    <MailCard
                      kind={kind}
                      sender={SENDERS[kind][0]}
                      tone={LEGIT_TONES[0]}
                      width={Math.min(cardWidth, 150)}
                    />
                    <span className="text-xs text-muted-foreground">
                      <span className="block font-medium text-foreground">{t(`kinds.${kind}`)}</span>
                      {kind === "legit" ? t("let_through") : t("click_to_block")}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col items-center gap-2">
                <Button ref={startRef} size="sm" onClick={start}>
                  <Play className="w-4 h-4 me-1.5" />
                  {t("start")}
                </Button>
                {best > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t("best", { score: best })}
                  </span>
                )}
              </div>
            </div>
          )}

          {phase === "over" && result && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 overflow-y-auto bg-background/95 px-6 py-6 text-center">
              <div className="flex flex-col items-center gap-3">
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full",
                    result.held ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
                  )}
                >
                  {result.held ? <ShieldCheck className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
                </div>
                <h3 className="text-lg font-semibold text-foreground">
                  {result.held ? t("held") : t("overrun")}
                </h3>
              </div>
              <div className="flex flex-col items-center gap-1">
                <span className="text-4xl font-semibold text-foreground tabular-nums">{result.score}</span>
                {result.newBest ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    {t("new_best")}
                  </span>
                ) : best > 0 ? (
                  <span className="text-xs text-muted-foreground tabular-nums">{t("best", { score: best })}</span>
                ) : null}
              </div>
              <dl className="grid w-full max-w-xs grid-cols-3 divide-x divide-border rtl:divide-x-reverse rounded-md border border-border">
                {(
                  [
                    ["caught", result.caught],
                    ["delivered", result.delivered],
                    ["mistakes", result.mistakes],
                  ] as const
                ).map(([key, value]) => (
                  <div key={key} className="flex flex-col-reverse gap-0.5 px-2 py-2">
                    <dt className="text-xs text-muted-foreground">{t(`stats.${key}`)}</dt>
                    <dd className="text-base font-semibold text-foreground tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={close}>
                  {tCommon("close")}
                </Button>
                <Button ref={againRef} size="sm" onClick={start}>
                  <RotateCcw className="w-4 h-4 me-1.5" />
                  {t("play_again")}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div
          className={cn(
            "flex items-center gap-2 px-6 h-11 border-t border-border text-sm transition-colors duration-200",
            flash === "bad" ? "bg-destructive/10" : flash === "good" ? "bg-primary/10" : "bg-background"
          )}
        >
          <Inbox className={cn("w-4 h-4", flash === "bad" ? "text-destructive" : "text-primary")} />
          <span className="font-medium text-foreground">{tMailboxes("inbox")}</span>
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">{delivered}</span>
        </div>
      </div>
    </div>
  );
}

function MailCard({
  kind,
  sender,
  tone,
  width,
  className,
  onPointerDown,
}: {
  kind: Kind;
  sender: Sender;
  tone: string;
  width: number;
  className?: string;
  onPointerDown?: (e: PointerEvent<HTMLDivElement>) => void;
}) {
  // Sender names and addresses are Latin text, so the card reads left to
  // right even in an RTL locale; otherwise addresses truncate from the front.
  return (
    <div
      dir="ltr"
      className={cn(
        "flex items-center gap-2 rounded-md border bg-background px-2",
        kind === "spam" ? "border-destructive/30" : kind === "phishing" ? "border-warning/40" : "border-border",
        className
      )}
      style={{ width, height: CARD_HEIGHT }}
      onPointerDown={onPointerDown}
    >
      {kind === "legit" ? (
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{ backgroundColor: tone }}
        >
          {initials(sender.name)}
        </span>
      ) : (
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            kind === "spam" ? "bg-destructive/10 text-destructive" : "bg-warning/15 text-warning"
          )}
        >
          {kind === "spam" ? <Ban className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
        </span>
      )}
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-xs font-semibold text-foreground">{sender.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">{sender.address}</p>
      </div>
    </div>
  );
}
