import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCloseOnBack } from '@/hooks/use-close-on-back';
import { confirmLeave, hasUnsavedChanges, interceptLeave, registerLeaveGuard } from '@/lib/leave-guard';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((off) => off()); });

function guard(dirty: { value: boolean }, answer: boolean) {
  const confirm = vi.fn(async () => {
    if (answer) dirty.value = false;
    return answer;
  });
  cleanups.push(registerLeaveGuard({ isDirty: () => dirty.value, confirm }));
  return confirm;
}

function link() {
  const a = document.createElement('a');
  const onClick = vi.fn((e: MouseEvent) => { interceptLeave(e as unknown as { preventDefault(): void; currentTarget: EventTarget | null }); });
  a.addEventListener('click', onClick);
  document.body.appendChild(a);
  cleanups.push(() => a.remove());
  return { a, onClick };
}

describe('leave guard', () => {
  it('lets a click through when nothing is unsaved', () => {
    guard({ value: false }, true);
    const e = { preventDefault: vi.fn(), currentTarget: null };
    expect(interceptLeave(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('stops the click, asks, and clicks again once the changes are let go', async () => {
    const confirm = guard({ value: true }, true);
    const { a, onClick } = link();
    const click = new MouseEvent('click', { cancelable: true });
    a.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(onClick).toHaveBeenCalledTimes(2));
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('stays put when the user keeps editing', async () => {
    const confirm = guard({ value: true }, false);
    const { a, onClick } = link();
    a.dispatchEvent(new MouseEvent('click', { cancelable: true }));
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('leaves only once the asking dialog has taken its history entry back off', async () => {
    // The confirm dialog holds a history entry while it is open (Back closes
    // it) and steps Back off it as it closes. Leaving before that Back lands
    // would be undone by it.
    const dialog = renderHook((props: { open: boolean }) => useCloseOnBack({ onBack: () => {}, active: props.open }), {
      initialProps: { open: true },
    });
    await vi.waitFor(() => expect((window.history.state as Record<string, unknown> | null)?.__closeOnBack).toBeTruthy());
    const order: string[] = [];
    window.addEventListener('popstate', () => order.push('back landed'), { once: true, capture: true });
    cleanups.push(registerLeaveGuard({
      isDirty: () => true,
      confirm: async () => { dialog.rerender({ open: false }); return true; },
    }));
    const a = document.createElement('a');
    a.addEventListener('click', (e) => { if (!interceptLeave(e)) order.push('left'); });
    document.body.appendChild(a);
    cleanups.push(() => { a.remove(); dialog.unmount(); });
    a.click();
    await vi.waitFor(() => expect(order).toContain('left'));
    expect(order).toEqual(['back landed', 'left']);
  });

  it('asks only the editors that have changes', async () => {
    const clean = guard({ value: false }, true);
    const dirty = guard({ value: true }, true);
    expect(await confirmLeave()).toBe(true);
    expect(clean).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenCalledOnce();
  });
});
