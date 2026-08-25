import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useRefreshGesture, PULL_THRESHOLD } from '@/hooks/use-refresh-gesture';

/**
 * Pull-to-refresh feedback (#826): the indicator has to follow the finger,
 * say what will happen, and keep spinning until the refresh resolves — and it
 * must not fire while the user is scrolling an inner pane.
 */

function Harness({ onRefresh, enabled = true }: { onRefresh: () => void | Promise<void>; enabled?: boolean }) {
  const { indicator } = useRefreshGesture({ onRefresh, enabled });
  return (
    <div>
      {/* A scrolling pane like the virtualised email list. */}
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <div data-testid="row">row</div>
      </div>
      {indicator}
    </div>
  );
}

/** jsdom has no layout, so fake the metrics that mark a node as scrollable. */
function makeScrollable(el: HTMLElement, { scrollTop }: { scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
  el.scrollTop = scrollTop;
}

function touch(type: 'touchstart' | 'touchmove' | 'touchend', target: HTMLElement, y: number, x = 50) {
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: type === 'touchmove',
    touches: type === 'touchend' ? [] : ([{ clientX: x, clientY: y }] as unknown as Touch[]),
  });
  // jsdom's TouchEvent ignores the touches init, so attach it directly.
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }],
    configurable: true,
  });
  Object.defineProperty(event, 'target', { value: target, configurable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

function pull(target: HTMLElement, to: number) {
  touch('touchstart', target, 0);
  return touch('touchmove', target, to);
}

const indicator = () => screen.queryByTestId('pull-to-refresh-indicator');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRefreshGesture pull-to-refresh indicator', () => {
  it('follows the finger and prompts to pull before the threshold', () => {
    render(<Harness onRefresh={vi.fn()} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 0 });

    expect(indicator()).toBeNull();

    pull(row, 40);

    const el = indicator();
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute('data-phase', 'pulling');
    expect(el).toHaveTextContent('pull_to_refresh');
    expect(el?.getAttribute('style')).toContain('30px'); // 40px drag - 10px activation slop
  });

  it('switches to "release to refresh" past the threshold', () => {
    render(<Harness onRefresh={vi.fn()} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 0 });

    pull(row, PULL_THRESHOLD + 40);

    expect(indicator()).toHaveAttribute('data-phase', 'ready');
    expect(indicator()).toHaveTextContent('release_to_refresh');
  });

  it('keeps spinning until the refresh resolves, then snaps back', async () => {
    let resolveRefresh: (() => void) | undefined;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve; }));
    render(<Harness onRefresh={onRefresh} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 0 });

    pull(row, PULL_THRESHOLD + 40);
    touch('touchend', row, PULL_THRESHOLD + 40);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(indicator()).toHaveAttribute('data-phase', 'refreshing');
    expect(indicator()).toHaveTextContent('refreshing');

    // Still spinning while the request is in flight.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(indicator()).toHaveAttribute('data-phase', 'refreshing');

    await act(async () => { resolveRefresh?.(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(indicator()).toBeNull();
  });

  it('holds the spinner briefly so an instant refresh does not flash', async () => {
    render(<Harness onRefresh={vi.fn()} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 0 });

    pull(row, PULL_THRESHOLD + 40);
    touch('touchend', row, PULL_THRESHOLD + 40);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(indicator()).toHaveAttribute('data-phase', 'refreshing');

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(indicator()).toBeNull();
  });

  it('does not refresh when the pull is released below the threshold', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 0 });

    pull(row, 40);
    touch('touchend', row, 40);

    expect(onRefresh).not.toHaveBeenCalled();
    expect(indicator()).toHaveAttribute('data-phase', 'cancelling');

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(indicator()).toBeNull();
  });

  it('ignores the gesture when the inner scroll pane is not at the top', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 300 });

    pull(row, PULL_THRESHOLD + 40);
    touch('touchend', row, PULL_THRESHOLD + 40);

    expect(indicator()).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('leaves horizontal swipes alone', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 0 });

    touch('touchstart', row, 0, 200);
    touch('touchmove', row, 30, 20); // 180px sideways, 30px down
    touch('touchend', row, 30, 20);

    expect(indicator()).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('leaves pulls that start inside a dialog to the dialog', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);
    const scroller = screen.getByTestId('scroller');
    scroller.setAttribute('role', 'dialog');
    makeScrollable(scroller, { scrollTop: 0 });

    pull(screen.getByTestId('row'), PULL_THRESHOLD + 40);
    touch('touchend', screen.getByTestId('row'), PULL_THRESHOLD + 40);

    expect(indicator()).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('claims the touchmove once the pull is owned so the page cannot rubber-band', () => {
    render(<Harness onRefresh={vi.fn()} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 0 });

    touch('touchstart', row, 0);
    const ignored = touch('touchmove', row, 5); // below the activation slop
    expect(ignored.defaultPrevented).toBe(false);

    const owned = touch('touchmove', row, 60);
    expect(owned.defaultPrevented).toBe(true);
  });

  it('shows the spinner for keyboard reload too', async () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} />);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', cancelable: true }));
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(indicator()).toHaveAttribute('data-phase', 'refreshing');

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(indicator()).toBeNull();
  });

  it('stays inert when disabled', () => {
    const onRefresh = vi.fn();
    render(<Harness onRefresh={onRefresh} enabled={false} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 0 });

    pull(row, PULL_THRESHOLD + 40);
    touch('touchend', row, PULL_THRESHOLD + 40);

    expect(indicator()).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does not start a second refresh while one is running', async () => {
    const onRefresh = vi.fn(() => new Promise<void>(() => {}));
    render(<Harness onRefresh={onRefresh} />);
    const row = screen.getByTestId('row');
    makeScrollable(screen.getByTestId('scroller'), { scrollTop: 0 });

    pull(row, PULL_THRESHOLD + 40);
    touch('touchend', row, PULL_THRESHOLD + 40);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    pull(row, PULL_THRESHOLD + 40);
    touch('touchend', row, PULL_THRESHOLD + 40);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
