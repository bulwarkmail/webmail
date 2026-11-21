import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer } from '../toast';
import { toast, useToastStore } from '@/stores/toast-store';
import { resetKeyboardLayout } from '@/lib/keyboard';

function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  return <ToastContainer toasts={toasts} onClose={removeToast} />;
}

// The toasts themselves, not the live region that reads them out.
const toasts = () => within(document.querySelector('[data-toast-container]') as HTMLElement);
const pressFocusShortcut = () =>
  fireEvent.keyDown(window, { key: 'N', code: 'KeyN', altKey: true, shiftKey: true });

describe('toasts and the keyboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  const extra: HTMLElement[] = [];
  const add = <T extends HTMLElement>(el: T): T => {
    document.body.appendChild(el);
    extra.push(el);
    return el;
  };
  afterEach(() => {
    vi.useRealTimers();
    for (const el of extra.splice(0)) el.remove();
  });

  it('holds the countdown while the focus is inside the toast', () => {
    render(<Toasts />);
    const onClick = vi.fn();
    act(() => { toast.success('Email archived', { action: { label: 'Undo', onClick }, duration: 5000 }); });
    const undo = screen.getByRole('button', { name: 'Undo' });
    act(() => { undo.focus(); });
    act(() => { vi.advanceTimersByTime(20000); });
    expect(toasts().getByText('Email archived')).toBeInTheDocument();

    // Focus leaves: the rest of the time runs out.
    act(() => { undo.blur(); });
    act(() => { vi.advanceTimersByTime(6000); });
    expect(toasts().queryByText('Email archived')).not.toBeInTheDocument();
  });

  it('does not hold a toast whose action ends at a fixed time', () => {
    render(<Toasts />);
    act(() => {
      toast.info('Sending', { action: { label: 'Undo', onClick: vi.fn() }, duration: 5000, pauseOnHover: false });
    });
    act(() => { screen.getByRole('button', { name: 'Undo' }).focus(); });
    act(() => { vi.advanceTimersByTime(6000); });
    expect(toasts().queryByText('Sending')).not.toBeInTheDocument();
  });

  it('moves the focus to the newest toast\'s action with Alt+Shift+N, and back when it closes', () => {
    const before = document.createElement('button');
    before.textContent = 'Message';
    add(before);
    before.focus();
    render(<Toasts />);
    const onClick = vi.fn();
    act(() => { toast.info('Older'); });
    act(() => { toast.success('Email deleted', { action: { label: 'Undo', onClick } }); });

    pressFocusShortcut();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalled();
    expect(document.activeElement).toBe(before);
  });

  it('takes Option+Shift+N from the key that types N on Colemak (#1719)', () => {
    render(<Toasts />);
    act(() => { toast.success('Email deleted', { action: { label: 'Undo', onClick: vi.fn() } }); });
    // Typed n on the key a US keyboard has J on; with Option it types no letter.
    fireEvent.keyDown(window, { key: 'n', code: 'KeyJ' });
    fireEvent.keyDown(window, { key: 'Dead', code: 'KeyJ', altKey: true, shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));
    resetKeyboardLayout();
  });

  it('closes the focused toast with Escape without the page hearing it', () => {
    const pageEscape = vi.fn();
    window.addEventListener('keydown', pageEscape);
    render(<Toasts />);
    act(() => { toast.success('Saved'); });
    pressFocusShortcut();
    pageEscape.mockClear();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(400); });
    expect(toasts().queryByText('Saved')).not.toBeInTheDocument();
    expect(pageEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', pageEscape);
  });

  it('leaves the focus alone while a modal dialog is open', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const inside = document.createElement('button');
    dialog.appendChild(inside);
    add(dialog);
    inside.focus();
    render(<Toasts />);
    act(() => { toast.success('Saved', { action: { label: 'Undo', onClick: vi.fn() } }); });
    pressFocusShortcut();
    expect(document.activeElement).toBe(inside);
  });
});
