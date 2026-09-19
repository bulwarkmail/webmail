import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BuildRefresh } from '../build-refresh';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: mocks.apiFetch }));

const respond = (stamp: string) => mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ stamp }) });
let hidden = false;
const reload = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  process.env.NEXT_PUBLIC_BUILD_STAMP = 'abc-1';
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
  reload.mockClear(); mocks.apiFetch.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe('BuildRefresh', () => {
  it('stays silent while the server runs the same build', async () => {
    respond('abc-1');
    render(<BuildRefresh />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 + 10); });
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/system/build', expect.anything());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it('offers a reload to a visible tab after a deploy and reloads once it is hidden', async () => {
    respond('def-2');
    render(<BuildRefresh />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 + 10); });
    expect(screen.getByRole('status')).toHaveTextContent('title');
    expect(reload).not.toHaveBeenCalled();
    hidden = true;
    await act(async () => { fireEvent(document, new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads a hidden tab silently and re-checks when the tab becomes visible', async () => {
    respond('abc-1');
    render(<BuildRefresh />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 + 10); });
    expect(reload).not.toHaveBeenCalled();
    // Deploy happens while the tab is in the background; the next check is
    // triggered by coming back, at least a minute after the previous one.
    respond('def-2');
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    hidden = true;
    await act(async () => { fireEvent(document, new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(reload).not.toHaveBeenCalled(); // becoming hidden does not check
    hidden = false;
    await act(async () => { fireEvent(document, new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the build stamp is unknown', async () => {
    process.env.NEXT_PUBLIC_BUILD_STAMP = '';
    render(<BuildRefresh />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60_000); });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
