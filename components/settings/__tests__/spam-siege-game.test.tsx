import { render, screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpamSiegeGame } from '../spam-siege-game';

// Echo interpolation values so the shield count is visible in the label.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

const FIELD = 400;
let frames: FrameRequestCallback[] = [];
let now = 0;

/** Advance the clock by `ms` and run one animation frame. */
function frame(ms: number) {
  now += ms;
  const run = frames;
  frames = [];
  act(() => {
    for (const cb of run) cb(now);
  });
}

function frames16(count: number) {
  for (let i = 0; i < count; i++) frame(16);
}

function shieldsLeft(): number {
  const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
  return JSON.parse(label.slice(label.indexOf(':') + 1)).count;
}

function score(): string {
  return screen.getByText('score').querySelector('span')?.textContent ?? '';
}

function card(kind: 'spam' | 'phishing' | 'legit') {
  return document.querySelector<HTMLElement>(`[data-kind="${kind}"] > div`);
}

function startWith(roll: number) {
  vi.spyOn(Math, 'random').mockReturnValue(roll);
  const onClose = vi.fn();
  render(<SpamSiegeGame onClose={onClose} />);
  fireEvent.click(screen.getByText('start'));
  // The first card drops in 250 ms after the start.
  frames16(20);
  return onClose;
}

describe('SpamSiegeGame', () => {
  beforeEach(() => {
    frames = [];
    now = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => FIELD });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => FIELD });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });

  it('does not block mail the pointer only passes over', () => {
    startWith(0.1); // real mail
    const legit = card('legit');
    expect(legit).not.toBeNull();

    fireEvent.mouseEnter(legit!);
    fireEvent.mouseOver(legit!);
    fireEvent.pointerOver(legit!);
    fireEvent.mouseMove(legit!);
    frames16(2);

    expect(card('legit')).not.toBeNull();
    expect(shieldsLeft()).toBe(3);
  });

  it('costs a shield to block real mail', () => {
    startWith(0.1);
    fireEvent.pointerDown(card('legit')!);

    expect(shieldsLeft()).toBe(2);
    expect(score()).toBe('0');
  });

  it('scores a blocked spam', () => {
    startWith(0.9); // spam
    fireEvent.pointerDown(card('spam')!);

    expect(score()).toBe('10');
    expect(shieldsLeft()).toBe(3);
  });

  it('costs a shield when spam reaches the inbox', () => {
    startWith(0.9);
    for (let i = 0; i < 400 && shieldsLeft() === 3; i++) frame(50);

    expect(shieldsLeft()).toBe(2);
  });

  it('does not drop the whole field into the inbox after the tab was in the background', () => {
    startWith(0.9);
    // One frame after ten seconds without any, as when the tab comes back.
    frame(10_000);

    expect(card('spam')).not.toBeNull();
    expect(shieldsLeft()).toBe(3);
  });

  it('closes on Escape', () => {
    const onClose = startWith(0.9);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the round open when a press starts inside and ends on the backdrop', () => {
    const onClose = startWith(0.9);
    const backdrop = screen.getByRole('dialog').parentElement!;

    fireEvent.pointerDown(card('spam')!);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
