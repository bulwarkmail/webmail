import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastContainer } from '../toast';
import { toast, useToastStore } from '@/stores/toast-store';

function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  return <ToastContainer toasts={toasts} onClose={removeToast} />;
}

describe('progress toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows progress on the bottom line and stays until removed', () => {
    render(<Toasts />);
    let id = '';
    act(() => { id = toast.progress('Uploading...', { message: 'a.stl', progress: 0.25 }); });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Uploading...')).toBeInTheDocument();

    act(() => { toast.update(id, { progress: 0.8, message: 'a.stl · 80%' }); });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
    expect(screen.getByText('a.stl · 80%')).toBeInTheDocument();

    act(() => { toast.dismiss(id); });
    expect(screen.queryByText('Uploading...')).toBeNull();
  });

  it('runs the action, e.g. Cancel, from the toast', () => {
    const onCancel = vi.fn();
    render(<Toasts />);
    act(() => { toast.progress('Uploading...', { progress: null, action: { label: 'Cancel', onClick: onCancel } }); });
    act(() => { screen.getByText('Cancel').click(); });
    expect(onCancel).toHaveBeenCalled();
  });

  it('pauses on hover unless told not to', () => {
    render(<Toasts />);
    act(() => {
      toast.info('Readable', { duration: 1000 });
      toast.info('Deadline', { duration: 1000, pauseOnHover: false });
    });
    act(() => {
      fireEvent.pointerOver(screen.getByText('Readable').closest('.toast-item')!, { pointerType: 'mouse' });
      fireEvent.pointerOver(screen.getByText('Deadline').closest('.toast-item')!, { pointerType: 'mouse' });
    });
    act(() => { vi.advanceTimersByTime(1500); });

    expect(screen.getByText('Readable')).toBeInTheDocument();
    expect(screen.queryByText('Deadline')).toBeNull();
  });

  it('counts down normally once turned into a regular toast', () => {
    render(<Toasts />);
    let id = '';
    act(() => { id = toast.progress('Uploading...', { progress: 0.5 }); });
    act(() => { toast.update(id, { title: 'Uploaded', progress: undefined, duration: 1000, type: 'success' }); });
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1500); });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
