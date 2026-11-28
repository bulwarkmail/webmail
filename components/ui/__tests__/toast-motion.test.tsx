import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { ToastContainer, ToastItem, type DeckCard, type Toast } from '../toast';
import { TOAST_EASE, TOAST_FADE_MS, TOAST_LEAVE_MS, TOAST_MOVE_MS, TOAST_STAGGER_MS } from '@/lib/toast-motion';

const card = (n: number): DeckCard => ({ id: `c${n}`, title: 'Archived', message: `Subject ${n}`, action: { label: 'Undo', onClick: () => {} } });
const deck = (front: number, behind: number[]): Toast => ({
  id: 'd', type: 'success', title: 'Archived', message: `Subject ${front}`, duration: 8000, group: 'undo',
  cardId: `c${front}`, revision: front, action: { label: 'Undo', onClick: () => {}, keepOpen: behind.length > 0 },
  behind: behind.map(card),
});
const show = (t: Toast) => <ToastContainer toasts={[t]} onClose={vi.fn()} />;
const front = () => document.querySelector<HTMLElement>('[data-deck-front]')!;

type Played = { duration?: number; delay?: number; easing?: string };
let played: Played[] = [];
const transitions = new Set<string>();

function seenTransitions() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-deck-card], [data-deck-card] > *, [data-deck-front] ~ *, [data-toast-container] *')) {
    for (const part of el.style.transition.split(/,(?![^()]*\))/).map((t) => t.trim()).filter(Boolean)) transitions.add(part);
  }
}

beforeEach(() => {
  played = [];
  transitions.clear();
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = vi.fn(function (_k: Keyframe[], options?: KeyframeAnimationOptions) {
    played.push({ duration: options?.duration as number, delay: options?.delay, easing: options?.easing });
    return { cancel: vi.fn(), finished: new Promise(() => {}) } as unknown as Animation;
  });
});
afterEach(() => {
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  vi.useRealTimers();
});

describe('one timing scale for every toast motion', () => {
  it('moves, slides off and fades the deck on the same few beats, on one curve', async () => {
    const { rerender } = render(show(deck(1, [])));
    await act(async () => {});
    for (const next of [deck(2, [1]), deck(3, [2, 1]), deck(4, [3, 2, 1]), deck(5, [4, 3, 2, 1])]) {
      rerender(show(next));
      await act(async () => {});
      seenTransitions();
    }
    fireEvent.pointerOver(front(), { pointerType: 'mouse' });
    seenTransitions();
    rerender(show(deck(5, [4, 2, 1])));
    seenTransitions();
    await act(async () => {});
    rerender(show(deck(4, [2, 1])));
    seenTransitions();
    await act(async () => {});
    fireEvent.pointerLeave(document.querySelector('[data-toast-container]')!, { pointerType: 'mouse', clientX: -999, clientY: -999 });
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    seenTransitions();
    fireEvent.keyDown(document.querySelector('.toast-item')!, { key: 'Escape' });
    await act(async () => {});

    expect(played.length).toBeGreaterThan(5);
    for (const p of played) {
      expect([TOAST_MOVE_MS, TOAST_LEAVE_MS, TOAST_FADE_MS]).toContain(p.duration);
      expect(p.easing).toBe(TOAST_EASE);
      expect((p.delay ?? 0) % TOAST_STAGGER_MS).toBe(0);
    }
    expect(transitions.size).toBeGreaterThan(2);
    for (const t of transitions) {
      const [duration, delay = 0] = (t.match(/[\d.]+ms/g) ?? []).map(parseFloat);
      if (t.startsWith('transform') || t.startsWith('box-shadow') || t.startsWith('margin')) expect(duration).toBe(TOAST_MOVE_MS);
      else if (t.startsWith('opacity')) expect(duration).toBe(TOAST_FADE_MS);
      expect(t).toContain(TOAST_EASE);
      expect(delay % TOAST_STAGGER_MS).toBe(0);
    }
  });

  it('slides a toast in and out on the same scale', () => {
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    expect(css).toMatch(/\.toast-enter\s*{\s*animation:\s*toast-enter var\(--toast-move\) var\(--toast-ease\) forwards;/);
    expect(css).toMatch(/\.toast-exit\s*{\s*animation:\s*toast-exit var\(--toast-leave\) var\(--toast-ease\) forwards;/);

    vi.useFakeTimers();
    const onClose = vi.fn();
    const { container } = render(<ToastItem onClose={onClose} toast={{ id: 't', type: 'success', title: 'Sent', duration: 1000 }} />);
    const item = container.querySelector<HTMLElement>('.toast-item')!;
    expect(item.style.getPropertyValue('--toast-move')).toBe(`${TOAST_MOVE_MS}ms`);
    expect(item.style.getPropertyValue('--toast-leave')).toBe(`${TOAST_LEAVE_MS}ms`);
    expect(item.style.getPropertyValue('--toast-ease')).toBe(TOAST_EASE);
    act(() => { vi.advanceTimersByTime(1000 + TOAST_LEAVE_MS - 1); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onClose).toHaveBeenCalled();
  });

  it('flings a swiped toast away as fast as one that slides off', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { container } = render(<ToastItem onClose={onClose} toast={{ id: 't', type: 'info', title: 'Moved', duration: 0 }} />);
    const el = container.querySelector<HTMLElement>('.toast-item')!;
    fireEvent.pointerDown(el, { pointerType: 'touch', pointerId: 1, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(el, { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 12 });
    fireEvent.pointerUp(el, { pointerType: 'touch', pointerId: 1, clientX: 200, clientY: 12 });
    expect(el.style.transition).toContain(`${TOAST_LEAVE_MS}ms`);
    expect(el.style.transition).toContain(TOAST_EASE);
    act(() => { vi.advanceTimersByTime(TOAST_LEAVE_MS); });
    expect(onClose).toHaveBeenCalled();
  });
});
