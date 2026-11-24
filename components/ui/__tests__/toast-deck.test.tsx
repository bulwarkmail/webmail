import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastContainer, ToastItem, type DeckCard, type Toast } from '../toast';

const card = (n: number, onClick: () => void = () => {}): DeckCard => ({
  id: `c${n}`, title: 'Archived', message: `Subject ${n}`, action: { label: 'Undo', onClick },
});

const deck = (front: number, behind: number[], over: Partial<Toast> = {}): Toast => ({
  id: 'd', type: 'success', title: 'Archived', message: `Subject ${front}`, duration: 8000, group: 'undo',
  cardId: `c${front}`, revision: front,
  action: { label: 'Undo', onClick: () => {}, keepOpen: behind.length > 0 },
  behind: behind.map((n) => card(n)), ...over,
});

const cardsBehind = () => Array.from(document.querySelectorAll<HTMLElement>('[data-deck-card]'));
const front = () => document.querySelector<HTMLElement>('[data-deck-front]')!;

type Motion = { el: Element; keyframes: Keyframe[] };
let motions: Motion[] = [];

beforeEach(() => {
  motions = [];
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = vi.fn(function (this: Element, keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
    motions.push({ el: this, keyframes, options } as Motion);
    return { cancel: vi.fn(), finished: new Promise(() => {}), onfinish: null } as unknown as Animation;
  });
});
afterEach(() => {
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

describe('the undo deck', () => {
  it('shows the edge of every card behind the front one', async () => {
    const { rerender } = render(<ToastContainer toasts={[deck(1, [])]} onClose={vi.fn()} />);
    await act(async () => {});
    expect(cardsBehind()).toHaveLength(0);

    rerender(<ToastContainer toasts={[deck(10, [9, 8, 7, 6, 5, 4, 3, 2, 1])]} onClose={vi.fn()} />);
    expect(cardsBehind()).toHaveLength(9);
  });

  it('keeps a tall deck low: ten cards take less room than two toasts', async () => {
    render(<ToastContainer toasts={[deck(10, [9, 8, 7, 6, 5, 4, 3, 2, 1])]} onClose={vi.fn()} />);
    await act(async () => {});
    const wrapper = cardsBehind()[0].parentElement as HTMLElement;
    expect(parseFloat(wrapper.style.marginTop)).toBeLessThanOrEqual(40);
    const offsets = cardsBehind().map((el) => Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)![1]));
    expect(offsets).toEqual([...offsets].sort((x, y) => y - x));
    expect(new Set(offsets).size).toBe(9);
  });

  it('keeps the cards behind out of reach while the deck is folded', async () => {
    render(<ToastContainer toasts={[deck(3, [2, 1])]} onClose={vi.fn()} />);
    await act(async () => {});
    for (const el of cardsBehind()) {
      expect(el).toHaveAttribute('aria-hidden', 'true');
      expect(el.hasAttribute('inert')).toBe(true);
    }
  });

  it('fans out while the pointer is on it, each card with its message and its own Undo', async () => {
    const undoSecond = vi.fn();
    const toast = deck(3, [2, 1], { behind: [card(2, undoSecond), card(1)] });
    render(<ToastContainer toasts={[toast]} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.pointerOver(front(), { pointerType: 'mouse' });

    expect(cardsBehind().every((el) => el.dataset.expanded === 'true')).toBe(true);
    expect(cardsBehind()[0]).not.toHaveAttribute('aria-hidden');
    expect(screen.getByText('Subject 2')).toBeInTheDocument();
    expect(screen.getByText('Subject 1')).toBeInTheDocument();

    fireEvent.click(cardsBehind()[0].querySelector('button')!);
    expect(undoSecond).toHaveBeenCalledTimes(1);
  });

  it('stays fanned out while a card undone from it slides off under the pointer', async () => {
    const { rerender } = render(<ToastContainer toasts={[deck(3, [2, 1])]} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.pointerOver(front(), { pointerType: 'mouse' });
    rerender(<ToastContainer toasts={[deck(3, [1])]} onClose={vi.fn()} />);
    await act(async () => {});
    const leaving = document.querySelector<HTMLElement>('[data-deck-leaving]')!;
    fireEvent.pointerLeave(document.querySelector('[data-toast-container]')!, { pointerType: 'mouse' });
    fireEvent.pointerOver(leaving, { pointerType: 'mouse' });
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(cardsBehind()[0].dataset.expanded).toBe('true');
  });

  it('moves the whole deck out at once, so no card shows from behind the front one', async () => {
    render(<ToastContainer toasts={[deck(3, [2, 1])]} onClose={vi.fn()} />);
    await act(async () => {});
    motions = [];
    fireEvent.keyDown(document.querySelector('.toast-item')!, { key: 'Escape' });
    await act(async () => {});
    const delays = motions.filter((m) => cardsBehind().includes(m.el as HTMLElement)).map((m) => (m as unknown as { options?: KeyframeAnimationOptions }).options?.delay ?? 0);
    expect(delays.every((d) => d === 0)).toBe(true);
  });

  describe('folding back up', () => {
    const container = () => document.querySelector('[data-toast-container]')!;
    const expanded = () => cardsBehind().every((el) => el.dataset.expanded === 'true');
    const folded = () => cardsBehind().every((el) => el.dataset.expanded !== 'true');
    const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
    const moveTo = (x: number, y: number) => fireEvent.pointerMove(document, { pointerType: 'mouse', clientX: x, clientY: y });
    const leaveTo = (x: number, y: number) => {
      fireEvent.pointerLeave(container(), { pointerType: 'mouse', clientX: x, clientY: y });
      moveTo(x, y);
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const on = this.matches('[data-deck-front], [data-deck-card]');
        const r = on ? { left: 900, top: 600, right: 1260, bottom: 780 } : { left: 0, top: 0, right: 0, bottom: 0 };
        return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON() {} } as DOMRect;
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const fanOut = () => {
      render(<ToastContainer toasts={[deck(3, [2, 1])]} onClose={vi.fn()} />);
      fireEvent.pointerOver(front(), { pointerType: 'mouse' });
      expect(expanded()).toBe(true);
    };

    it('waits a moment after the pointer goes before folding', () => {
      fanOut();
      leaveTo(300, 200);
      wait(300);
      expect(expanded()).toBe(true);
      wait(400);
      expect(folded()).toBe(true);
    });

    it('stays fanned out while the pointer lingers just off its edge', () => {
      fanOut();
      leaveTo(1250, 570);
      wait(3000);
      expect(expanded()).toBe(true);
      moveTo(300, 200);
      wait(700);
      expect(folded()).toBe(true);
    });

    it('stays fanned out when the pointer comes back before it folds', () => {
      fanOut();
      leaveTo(300, 200);
      wait(300);
      fireEvent.pointerOver(front(), { pointerType: 'mouse' });
      wait(2000);
      expect(expanded()).toBe(true);
    });

    it('folds when the pointer leaves the window', () => {
      fanOut();
      fireEvent.pointerLeave(container(), { pointerType: 'mouse', clientX: 1250, clientY: 570 });
      fireEvent.pointerOut(document.body, { pointerType: 'mouse', relatedTarget: null });
      wait(700);
      expect(folded()).toBe(true);
    });

    it('fades the text out before the cards close in, and the cards first when they open', () => {
      fanOut();
      const card = cardsBehind()[0];
      const content = card.firstElementChild as HTMLElement;
      const timing = (el: HTMLElement, prop: string) => {
        const part = el.style.transition.split(/,(?![^()]*\))/).map((t) => t.trim()).find((t) => t.startsWith(prop))!;
        const [duration = 0, delay = 0] = (part.match(/[\d.]+ms/g) ?? []).map(parseFloat);
        return { duration, delay };
      };
      expect(timing(content, 'opacity').delay).toBeGreaterThan(0);
      leaveTo(300, 200);
      wait(700);
      const fade = timing(content, 'opacity');
      const close = timing(card, 'transform');
      expect(fade.delay + fade.duration).toBeLessThanOrEqual(close.delay + close.duration / 3);
    });
  });

  it('slides a new card in on top and lays the one before onto the deck', async () => {
    const { rerender } = render(<ToastContainer toasts={[deck(1, [])]} onClose={vi.fn()} />);
    await act(async () => {});
    motions = [];
    rerender(<ToastContainer toasts={[deck(2, [1])]} onClose={vi.fn()} />);
    await act(async () => {});

    const arrival = motions.find((m) => m.el === front());
    expect(arrival?.keyframes[0].transform).toMatch(/translateX/);
    const laid = motions.find((m) => m.el === cardsBehind()[0]);
    expect(laid?.keyframes[0].transform).toBe('translateY(0px) scale(1)');
    const fading = motions.find((m) => cardsBehind()[0].contains(m.el) && m.el !== cardsBehind()[0]);
    expect(fading?.keyframes.map((k) => k.opacity)).toEqual([1, 0]);
  });

  it('slides an undone card off and brings the next one forward', async () => {
    const { rerender } = render(<ToastContainer toasts={[deck(3, [2, 1])]} onClose={vi.fn()} />);
    await act(async () => {});
    motions = [];
    rerender(<ToastContainer toasts={[deck(2, [1])]} onClose={vi.fn()} />);
    await act(async () => {});

    const leaving = document.querySelector<HTMLElement>('[data-deck-leaving]');
    expect(leaving).toHaveTextContent('Subject 3');
    const off = motions.find((m) => m.el === leaving)!;
    expect(off.keyframes.at(-1)?.transform).toMatch(/translateX/);
    expect(off.keyframes.slice(0, -1).every((k) => k.opacity === undefined || k.opacity === 1)).toBe(true);
    expect(motions.find((m) => m.el === front())?.keyframes[0].transform).toMatch(/translateY\(-/);
  });

  it('slides a card undone from inside the fanned-out deck off from where it was', async () => {
    const { rerender } = render(<ToastContainer toasts={[deck(3, [2, 1])]} onClose={vi.fn()} />);
    await act(async () => {});
    fireEvent.pointerOver(front(), { pointerType: 'mouse' });
    rerender(<ToastContainer toasts={[deck(3, [1])]} onClose={vi.fn()} />);
    await act(async () => {});

    const leaving = document.querySelector<HTMLElement>('[data-deck-leaving]');
    expect(leaving).toHaveTextContent('Subject 2');
    expect(cardsBehind()).toHaveLength(1);
  });

  describe('undoing from the fanned-out deck', () => {
    const timing = (el: HTMLElement, prop: string) => {
      const part = el.style.transition.split(/,(?![^()]*\))/).map((t) => t.trim()).find((t) => t.startsWith(prop))!;
      const [duration = 0, delay = 0] = (part.match(/[\d.]+ms/g) ?? []).map(parseFloat);
      return { duration, delay };
    };
    const byId = (id: string) => cardsBehind().find((el) => el.textContent?.includes(`Subject ${id.slice(1)}`))!;
    const fanned = (toast: Toast) => {
      const view = render(<ToastContainer toasts={[toast]} onClose={vi.fn()} />);
      fireEvent.pointerOver(front(), { pointerType: 'mouse' });
      return view;
    };

    it('lets the undone card go before the cards above close the gap, nearest first', async () => {
      const { rerender } = fanned(deck(5, [4, 3, 2, 1]));
      await act(async () => {});
      rerender(<ToastContainer toasts={[deck(5, [4, 2, 1])]} onClose={vi.fn()} />);

      expect(timing(byId('c4'), 'transform').delay).toBe(0);
      const nearer = timing(byId('c2'), 'transform').delay;
      const farther = timing(byId('c1'), 'transform').delay;
      expect(nearer).toBeGreaterThan(0);
      expect(farther).toBeGreaterThan(nearer);
    });

    it('keeps the undone card above its neighbours while it slides off', async () => {
      const { rerender } = fanned(deck(4, [3, 2, 1]));
      await act(async () => {});
      rerender(<ToastContainer toasts={[deck(4, [3, 1])]} onClose={vi.fn()} />);
      await act(async () => {});

      const leaving = document.querySelector<HTMLElement>('[data-deck-leaving]')!;
      expect(leaving).toHaveTextContent('Subject 2');
      for (const el of cardsBehind()) expect(Number(leaving.style.zIndex)).toBeGreaterThan(Number(el.style.zIndex));
    });

    it('brings the next card forward once the undone front card is on its way out', async () => {
      const { rerender } = fanned(deck(3, [2, 1]));
      await act(async () => {});
      motions = [];
      rerender(<ToastContainer toasts={[deck(2, [1])]} onClose={vi.fn()} />);
      await act(async () => {});

      const rise = motions.find((m) => m.el === front()) as Motion & { options?: KeyframeAnimationOptions };
      expect(rise.options?.delay).toBeGreaterThan(0);
      expect(['backwards', 'both']).toContain(rise.options?.fill);
      expect(timing(byId('c1'), 'transform').delay).toBeGreaterThan(rise.options!.delay as number);
    });
  });

  it('waits while the keyboard is on an older card, and hands the focus to the front Undo once that card is undone', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const undoSecond = vi.fn();
    render(<ToastContainer toasts={[deck(3, [2, 1], { behind: [card(2, undoSecond), card(1)] })]} onClose={onClose} />);
    act(() => { front().querySelector('button')!.focus(); });
    const older = cardsBehind()[0].querySelector('button')!;
    act(() => { older.focus(); });
    act(() => { vi.advanceTimersByTime(20000); });
    expect(onClose).not.toHaveBeenCalled();

    act(() => { fireEvent.click(older); });
    expect(undoSecond).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(front().querySelector('button'));
    vi.useRealTimers();
  });

  it('keeps the keyboard in the deck when Ctrl+Z brings the focused card to the front', () => {
    const { rerender } = render(<ToastContainer toasts={[deck(3, [2, 1])]} onClose={vi.fn()} />);
    act(() => { front().querySelector('button')!.focus(); });
    act(() => { cardsBehind()[0].querySelector('button')!.focus(); });
    rerender(<ToastContainer toasts={[deck(2, [1])]} onClose={vi.fn()} />);

    expect(document.activeElement).toBe(front().querySelector('button'));
  });

  describe('room for every card', () => {
    const sizes = { front: 50, face: 64, frontTop: 700 };
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        if (this.matches('[data-deck-front]')) return sizes.front;
        if (this.matches('[data-deck-face]')) return sizes.face;
        return 0;
      });
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const top = this.matches('[data-deck-front]') ? sizes.frontTop : 0;
        return { top, bottom: top + sizes.front, left: 0, right: 360, x: 0, y: top, width: 360, height: sizes.front, toJSON() {} } as DOMRect;
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      Object.assign(sizes, { front: 50, face: 64, frontTop: 700 });
    });
    const offsets = () => cardsBehind().map((el) => -Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)![1]));

    it('gives an older card the height its message needs when the front card is shorter', async () => {
      render(<ToastContainer toasts={[deck(3, [2, 1])]} onClose={vi.fn()} />);
      await act(async () => {});
      fireEvent.pointerOver(front(), { pointerType: 'mouse' });
      await act(async () => {});

      for (const el of cardsBehind()) expect(parseFloat(el.style.height)).toBeGreaterThanOrEqual(sizes.face + 2);
      const [first, second] = offsets();
      expect(first).toBeGreaterThanOrEqual(sizes.front + 8);
      expect(second - first).toBeGreaterThanOrEqual(sizes.face + 2);
    });

    it('keeps each card\'s message and Undo in view in a short window', async () => {
      sizes.frontTop = 520;
      render(<ToastContainer toasts={[deck(10, [9, 8, 7, 6, 5, 4, 3, 2, 1])]} onClose={vi.fn()} />);
      await act(async () => {});
      fireEvent.pointerOver(front(), { pointerType: 'mouse' });
      await act(async () => {});

      const tops = offsets().map((o) => sizes.frontTop + sizes.front - o - parseFloat(cardsBehind()[0].style.height));
      expect(Math.min(...tops)).toBeGreaterThanOrEqual(0);
      const steps = offsets().slice(1).map((o, i) => o - offsets()[i]);
      expect(Math.min(...steps)).toBeGreaterThanOrEqual(48);
    });

    it('squeezes the cards in a very short window, keeping each one\'s title and Undo in reach', async () => {
      sizes.frontTop = 400;
      render(<ToastContainer toasts={[deck(10, [9, 8, 7, 6, 5, 4, 3, 2, 1])]} onClose={vi.fn()} />);
      await act(async () => {});
      fireEvent.pointerOver(front(), { pointerType: 'mouse' });
      await act(async () => {});

      const tops = offsets().map((o) => sizes.frontTop + sizes.front - o - parseFloat(cardsBehind()[0].style.height));
      expect(Math.min(...tops)).toBeGreaterThanOrEqual(0);
      const steps = offsets().slice(1).map((o, i) => o - offsets()[i]);
      expect(Math.min(...steps)).toBeGreaterThanOrEqual(34);
    });
  });

  it('takes the whole deck away together when it closes', async () => {
    render(<ToastContainer toasts={[deck(3, [2, 1])]} onClose={vi.fn()} />);
    await act(async () => {});
    motions = [];
    fireEvent.keyDown(document.querySelector('.toast-item')!, { key: 'Escape' });
    await act(async () => {});

    expect(cardsBehind()).toHaveLength(2);
    for (const el of cardsBehind()) {
      expect(motions.find((m) => m.el === el)?.keyframes.at(-1)?.transform).toMatch(/translateX/);
    }
  });
});

describe('the front card of the deck', () => {
  it('stays up after an action that keeps it open, with the focus still on that button', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onClick = vi.fn();
    const { getByRole, rerender } = render(<ToastItem onClose={onClose} toast={deck(2, [1], { action: { label: 'Undo', onClick, keepOpen: true } })} />);
    const undo = getByRole('button', { name: 'Undo' });
    undo.focus();
    fireEvent.click(undo);
    rerender(<ToastItem onClose={onClose} toast={deck(1, [], { action: { label: 'Undo', onClick, keepOpen: false } })} />);
    act(() => { vi.advanceTimersByTime(1000); });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(getByRole('button', { name: 'Undo' }));
    vi.useRealTimers();
  });

  it('gives the card that came forward its full time', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { rerender } = render(<ToastItem onClose={onClose} toast={deck(1, [])} />);
    act(() => { vi.advanceTimersByTime(6000); });
    rerender(<ToastItem onClose={onClose} toast={deck(2, [1])} />);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2400); });
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps counting down after Undo is clicked with the mouse', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { getByRole } = render(<ToastItem onClose={onClose} toast={deck(2, [1])} />);
    const undo = getByRole('button', { name: 'Undo' });
    act(() => {
      fireEvent.pointerDown(undo, { pointerType: 'mouse' });
      undo.focus();
      fireEvent.pointerUp(undo, { pointerType: 'mouse' });
      fireEvent.click(undo);
    });
    expect(document.activeElement).toBe(undo);
    act(() => { vi.advanceTimersByTime(8400); });
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('waits while the keyboard focus is on it', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { getByRole } = render(<ToastItem onClose={onClose} toast={deck(2, [1])} />);
    act(() => { getByRole('button', { name: 'Undo' }).focus(); });
    act(() => { vi.advanceTimersByTime(20000); });
    expect(onClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
