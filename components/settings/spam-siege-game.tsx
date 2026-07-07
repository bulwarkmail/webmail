"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Shield, Mail, X, AlertTriangle, MailCheck, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const GAME_WIDTH = 400;
const GAME_HEIGHT = 520;
const INBOX_Y = GAME_HEIGHT - 40;
const SPAWN_INTERVAL_START = 900;
const SPAWN_INTERVAL_MIN = 340;
const GAME_DURATION = 30;
const ENEMY_SPEED_START = 1.2;
const ENEMY_SPEED_INCREASE = 0.04;
const MAX_MISSES = 3;

interface Enemy {
  id: number;
  x: number;
  y: number;
  speed: number;
  type: "spam" | "phishing" | "legit";
}

type GameState = "idle" | "playing" | "over";

export function SpamSiegeGame({ onClose }: { onClose: () => void }) {
  const [gameState, setGameState] = useState<GameState>("idle");
  const [enemies, setEnemies] = useState<Enemy[]>([]);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const [misses, setMisses] = useState(0);
  const [survived, setSurvived] = useState(false);
  const nextId = useRef(0);
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const spawnTimerRef = useRef<number>(0);
  const gameStateRef = useRef<GameState>("idle");
  const elapsedRef = useRef(0);
  const clickedRef = useRef(new Set<number>());
  const enemiesRef = useRef<Enemy[]>([]);
  const missesRef = useRef(0);
  const scoreRef = useRef(0);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  const endGame = useCallback((didSurvive: boolean) => {
    setSurvived(didSurvive);
    setGameState("over");
  }, []);

  const startGame = useCallback(() => {
    setGameState("playing");
    setEnemies([]);
    setScore(0);
    setTimeLeft(GAME_DURATION);
    setMisses(0);
    setSurvived(false);
    nextId.current = 0;
    spawnTimerRef.current = 0;
    elapsedRef.current = 0;
    clickedRef.current = new Set();
    enemiesRef.current = [];
    missesRef.current = 0;
    scoreRef.current = 0;
    lastTimeRef.current = performance.now();
  }, []);

  const spawnEnemy = useCallback(() => {
    const id = nextId.current++;
    const rand = Math.random();
    const type = rand > 0.75 ? "legit" : rand > 0.45 ? "phishing" : "spam";
    const x = 20 + Math.random() * (GAME_WIDTH - 60);
    const speed = ENEMY_SPEED_START + (elapsedRef.current / 1000) * ENEMY_SPEED_INCREASE;
    enemiesRef.current = [...enemiesRef.current, { id, x, y: -32, speed, type }];
    setEnemies(enemiesRef.current);
  }, []);

  const handleClick = useCallback(
    (ev: React.MouseEvent, enemy: Enemy) => {
      ev.stopPropagation();
      if (clickedRef.current.has(enemy.id)) return;
      clickedRef.current.add(enemy.id);

      enemiesRef.current = enemiesRef.current.filter((e) => e.id !== enemy.id);
      setEnemies(enemiesRef.current);

      if (enemy.type === "legit") {
        missesRef.current += 1;
        setMisses(missesRef.current);
        scoreRef.current = Math.max(0, scoreRef.current - 15);
        setScore(scoreRef.current);
        if (missesRef.current >= MAX_MISSES) endGame(false);
      } else {
        scoreRef.current += enemy.type === "phishing" ? 15 : 10;
        setScore(scoreRef.current);
      }
    },
    [endGame]
  );

  useEffect(() => {
    if (gameState !== "playing") return;

    const tick = (now: number) => {
      if (gameStateRef.current !== "playing") return;

      const dt = now - lastTimeRef.current;
      lastTimeRef.current = now;
      elapsedRef.current += dt;

      const newTimeLeft = GAME_DURATION - Math.floor(elapsedRef.current / 1000);
      setTimeLeft(Math.max(0, newTimeLeft));
      if (newTimeLeft <= 0) {
        endGame(true);
        return;
      }

      spawnTimerRef.current += dt;
      const spawnInterval = Math.max(
        SPAWN_INTERVAL_MIN,
        SPAWN_INTERVAL_START - (elapsedRef.current / 1000) * 35
      );
      if (spawnTimerRef.current >= spawnInterval) {
        spawnTimerRef.current = 0;
        spawnEnemy();
      }

      const nextEnemies: Enemy[] = [];
      let missed = 0;
      let scoreDelta = 0;
      for (const e of enemiesRef.current) {
        const ny = e.y + e.speed * (dt / 16);
        if (ny >= INBOX_Y) {
          if (e.type === "legit") scoreDelta += 5;
          else missed++;
        } else {
          nextEnemies.push({ ...e, y: ny });
        }
      }
      enemiesRef.current = nextEnemies;
      setEnemies(nextEnemies);

      if (scoreDelta > 0) {
        scoreRef.current += scoreDelta;
        setScore(scoreRef.current);
      }
      if (missed > 0) {
        missesRef.current += missed;
        setMisses(missesRef.current);
        if (missesRef.current >= MAX_MISSES) {
          endGame(false);
          return;
        }
      }

      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [gameState, spawnEnemy, endGame]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative rounded-lg border border-border bg-card shadow-xl overflow-hidden select-none"
        style={{ width: GAME_WIDTH, maxWidth: "95vw" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-foreground">Spam Siege</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-2 bg-muted/40 border-b border-border text-xs text-muted-foreground">
          <div className="flex items-center gap-4">
            <span>
              Score <span className="font-medium text-foreground tabular-nums">{score}</span>
            </span>
            <span>
              Time <span className="font-medium text-foreground tabular-nums">{timeLeft}s</span>
            </span>
          </div>
          <span>
            Misses{" "}
            <span
              className={cn(
                "font-medium tabular-nums",
                misses >= MAX_MISSES - 1 ? "text-destructive" : "text-foreground"
              )}
            >
              {misses}/{MAX_MISSES}
            </span>
          </span>
        </div>

        <div
          className="relative bg-background overflow-hidden"
          style={{ height: GAME_HEIGHT }}
        >
          <div
            className="absolute left-0 right-0 flex items-center gap-2 px-4"
            style={{ top: INBOX_Y }}
          >
            <div className="h-px flex-1 bg-border" />
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Inbox
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {enemies.map((e) => {
            const variant =
              e.type === "phishing"
                ? "text-warning border-warning/40 bg-warning/10 hover:bg-warning/20"
                : e.type === "legit"
                  ? "text-success border-success/40 bg-success/10 hover:bg-success/20"
                  : "text-destructive border-destructive/40 bg-destructive/10 hover:bg-destructive/20";
            const Icon =
              e.type === "phishing" ? AlertTriangle : e.type === "legit" ? MailCheck : Mail;
            return (
              <button
                key={e.id}
                type="button"
                className={cn(
                  "absolute flex items-center justify-center w-8 h-8 rounded-md border cursor-pointer",
                  "active:scale-95 transition-transform",
                  variant
                )}
                style={{ left: e.x, top: e.y }}
                onMouseEnter={(ev) => handleClick(ev, e)}
                onClick={(ev) => handleClick(ev, e)}
              >
                <Icon className="w-4 h-4" />
              </button>
            );
          })}

          {gameState === "idle" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/95 px-8 text-center">
              <Shield className="w-10 h-10 text-primary" />
              <div className="space-y-1.5">
                <p className="text-base font-medium text-foreground">Spam Siege</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Click spam and phishing before they hit your inbox. Don&apos;t block legitimate
                  mail. Three misses and it&apos;s over.
                </p>
              </div>
              <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="w-3 h-3 text-destructive" />
                  Spam
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 text-warning" />
                  Phishing
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <MailCheck className="w-3 h-3 text-success" />
                  Legit
                </span>
              </div>
              <Button size="sm" onClick={startGame}>
                Start
              </Button>
            </div>
          )}

          {gameState === "over" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background/95 px-8 text-center">
              <Shield
                className={cn(
                  "w-10 h-10",
                  survived ? "text-success" : "text-muted-foreground/40"
                )}
              />
              <div className="space-y-1">
                <p className="text-base font-medium text-foreground">
                  {survived ? "Inbox held" : "Inbox overrun"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Final score{" "}
                  <span className="font-medium text-foreground tabular-nums">{score}</span>
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={onClose}>
                  Close
                </Button>
                <Button size="sm" onClick={startGame}>
                  <RotateCcw className="w-3.5 h-3.5 me-1.5" />
                  Again
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
