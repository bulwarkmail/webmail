import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clearAllHooks, toastHooks } from '@/lib/plugin-hooks';
import { toast, useToastStore } from '../toast-store';

beforeEach(() => {
  clearAllHooks();
  useToastStore.setState({ toasts: [] });
});

const titles = () => useToastStore.getState().toasts.map((t) => t.title);

describe('toasts that replace each other', () => {
  it('shows one toast for a group: the newest takes the place of the one before', () => {
    useToastStore.getState().addToast({ type: 'success', title: 'Archived', group: 'undo' });
    useToastStore.getState().addToast({ type: 'success', title: 'Archived', group: 'undo' });
    useToastStore.getState().addToast({ type: 'success', title: 'Deleted', group: 'undo' });

    expect(titles()).toEqual(['Deleted']);
  });

  it('leaves toasts of other groups and without a group where they are', () => {
    toast.error('Could not send');
    useToastStore.getState().addToast({ type: 'success', title: 'Archived', group: 'undo' });
    useToastStore.getState().addToast({ type: 'success', title: 'Deleted', group: 'undo' });

    expect(titles()).toEqual(['Could not send', 'Deleted']);
  });

  it('shows the same notice once, however often it comes', () => {
    toast.success('Link copied');
    toast.success('Link copied');
    toast.error('Offline', 'Changes are kept');
    toast.error('Offline', 'Changes are kept');

    expect(titles()).toEqual(['Link copied', 'Offline']);
  });

  it('keeps notices that say different things', () => {
    toast.success('Moved', '1 message');
    toast.success('Moved', '2 messages');

    expect(useToastStore.getState().toasts).toHaveLength(2);
  });

  it('keeps each progress toast: they track different work', () => {
    toast.progress('Uploading', { progress: 0.2 });
    toast.progress('Uploading', { progress: 0.5 });

    expect(useToastStore.getState().toasts).toHaveLength(2);
  });

  it('tells plugins the replaced toast went away, without calling its onDismiss', () => {
    const dismissed = vi.fn();
    const onDismiss = vi.fn();
    toastHooks.onToastDismiss.register('t', dismissed);

    const first = useToastStore.getState().addToast({ type: 'success', title: 'Archived', group: 'undo', onDismiss });
    useToastStore.getState().addToast({ type: 'success', title: 'Archived', group: 'undo' });

    expect(dismissed).toHaveBeenCalledWith({ id: first });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
