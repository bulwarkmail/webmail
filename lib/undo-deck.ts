import { toast, toastAnnouncement, useToastStore } from "@/stores/toast-store";
import type { ToastAction } from "@/components/ui/toast";
import { announce } from "@/lib/announce";
import { onUndoGone, recordUndo, runUndo, undoHistory } from "@/lib/undo-history";

export const UNDO_TOAST_DURATION = 8000;

export const UNDO_TOAST_GROUP = "undo";

interface Card {
  entryId: string;
  title: string;
  message?: string;
  label: string;
  hint?: string;
}

interface Deck {
  toastId: string;
  cards: Card[];
}

let deck: Deck | null = null;
let revision = 0;
let undoingFromCard = false;

function onScreen(d: Deck | null): d is Deck {
  return !!d?.toastId && useToastStore.getState().toasts.some((t) => t.id === d.toastId);
}

function frontAction(d: Deck, card: Card): ToastAction {
  return {
    label: card.label,
    keepOpen: d.cards.length > 1,
    onClick: () => {
      undoingFromCard = true;
      try {
        runUndo(card.entryId);
      } finally {
        undoingFromCard = false;
      }
    },
  };
}

function face(d: Deck) {
  const card = d.cards[d.cards.length - 1];
  return {
    title: card.title,
    message: card.message,
    srHint: card.hint,
    action: frontAction(d, card),
    cardId: card.entryId,
    behind: d.cards.slice(0, -1).reverse().map((c) => ({
      id: c.entryId,
      title: c.title,
      message: c.message,
      action: { label: c.label, onClick: () => { runUndo(c.entryId); } },
    })),
    revision: ++revision,
  };
}

function release(d: Deck, entryId: string) {
  if (d !== deck) return;
  d.cards = d.cards.filter((c) => c.entryId !== entryId);
  if (!onScreen(d)) {
    deck = null;
    return;
  }
  if (d.cards.length === 0) {
    deck = null;
    if (!undoingFromCard) toast.dismiss(d.toastId);
    return;
  }
  toast.update(d.toastId, face(d));
}

export function showUndoCard(
  title: string,
  undo: { label: string; onClick: () => void; hint?: string; keys?: string[] },
  message?: string,
): void {
  const entry = recordUndo(title, undo.onClick, undo.keys);
  const card: Card = { entryId: entry.id, title, message, label: undo.label, hint: undo.hint };
  if (onScreen(deck)) {
    const kept = new Set(undoHistory().map((e) => e.id));
    deck.cards = [...deck.cards.filter((c) => kept.has(c.entryId)), card];
    toast.update(deck.toastId, face(deck));
    announce(toastAnnouncement({ title, message, srHint: undo.hint }));
  } else {
    const fresh: Deck = { toastId: "", cards: [card] };
    const { title: t, ...rest } = face(fresh);
    fresh.toastId = toast.success(t, {
      ...rest,
      duration: UNDO_TOAST_DURATION,
      group: UNDO_TOAST_GROUP,
      onLeave: () => {
        if (deck === fresh) deck = null;
      },
    });
    deck = fresh;
  }
  const mine = deck;
  onUndoGone(entry.id, () => {
    if (mine) release(mine, entry.id);
  });
}

export function confirmUndone(text: string): void {
  if (onScreen(deck)) announce(text);
  else toast.success(text, { group: UNDO_TOAST_GROUP });
}

export function resetUndoDeck(): void {
  deck = null;
}
