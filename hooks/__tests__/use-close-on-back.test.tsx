import { StrictMode, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { historySettled, useCloseOnBack } from '../use-close-on-back';

const entry = () => (window.history.state as Record<string, unknown> | null)?.__closeOnBack;

async function openOverlay(options: Partial<Parameters<typeof useCloseOnBack>[0]> = {}, strict = false) {
  const before = entry();
  const onBack = vi.fn();
  const view = renderHook((props: { active: boolean }) => useCloseOnBack({ onBack, ...options, active: props.active }), {
    initialProps: { active: true },
    wrapper: strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined,
  });
  await waitFor(() => expect(entry()).toBeTruthy());
  await waitFor(() => expect(entry()).not.toBe(before));
  return { ...view, onBack };
}

describe('useCloseOnBack (R5)', () => {
  it('calls onBack when Back leaves the overlay entry', async () => {
    const { onBack, unmount } = await openOverlay();
    window.history.back();
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(entry()).toBeUndefined();
    unmount();
  });

  it('puts the entry back while the overlay holds', async () => {
    const { onBack, unmount } = await openOverlay({ shouldHold: () => true });
    window.history.back();
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(entry()).toBeTruthy();
    unmount();
    await waitFor(() => expect(entry()).toBeUndefined());
  });

  it('removes its entry when the overlay closes another way, keeping the latest URL', async () => {
    const { rerender } = await openOverlay();
    // The page rewrites the URL while the overlay is open
    window.history.replaceState(window.history.state, '', '/calendar/week/2026-09-14');
    rerender({ active: false });
    await waitFor(() => expect(entry()).toBeUndefined());
    await waitFor(() => expect(window.location.pathname).toBe('/calendar/week/2026-09-14'));
  });

  it('keeps its clean-up Back from the router, and passes a real Back on', async () => {
    const heard = vi.fn();
    window.addEventListener('popstate', heard);
    const { rerender } = await openOverlay();
    rerender({ active: false });
    await waitFor(() => expect(entry()).toBeUndefined());
    await historySettled();
    expect(heard).not.toHaveBeenCalled();

    const second = await openOverlay();
    window.history.back();
    await waitFor(() => expect(second.onBack).toHaveBeenCalledTimes(1));
    expect(heard).toHaveBeenCalledTimes(1);
    second.unmount();
    window.removeEventListener('popstate', heard);
  });

  it('does not undo a navigation that pushed its own entry', async () => {
    const { unmount } = await openOverlay();
    // The router pushes in the same commit that unmounts the overlay
    unmount();
    window.history.pushState({ other: true }, '', '/mail');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.history.state).toEqual({ other: true });
    expect(window.location.pathname).toBe('/mail');
  });

  it('holds a new entry on rearm after onBack chose to stay open, and says whether it is armed', async () => {
    const { result, onBack, unmount } = await openOverlay();
    expect(result.current.armed()).toBe(true);
    window.history.back();
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
    expect(result.current.armed()).toBe(false);
    expect(entry()).toBeUndefined();
    result.current.rearm();
    expect(result.current.armed()).toBe(true);
    expect(entry()).toBeTruthy();
    // ...and the next Back reaches onBack again
    window.history.back();
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(2));
    unmount();
  });

  it('pushes one entry and no Back under Strict Mode', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back');
    const { unmount } = await openOverlay({}, true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(entry()).toBeUndefined());
    push.mockRestore();
    back.mockRestore();
  });
});
