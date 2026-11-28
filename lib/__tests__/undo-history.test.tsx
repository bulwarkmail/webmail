import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderHook } from '@testing-library/react';
import { toastWithUndo } from '../email-action-toast';
import { clearUndoHistory, MAX_UNDO_HISTORY, recordUndo, undoHistory, undoLatest } from '../undo-history';
import { useToastStore } from '@/stores/toast-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUndoShortcut, isUndoKey } from '@/hooks/use-undo-shortcut';

const toastTitles = () => useToastStore.getState().toasts.map((t) => t.title);

beforeEach(() => {
  clearUndoHistory();
  useToastStore.setState({ toasts: [] });
  useSettingsStore.setState({ singleKeyShortcuts: true });
});

describe('undo history', () => {
  it('undoes the newest action first, then the one before it, bringing that one forward', () => {
    const first = vi.fn();
    const second = vi.fn();
    toastWithUndo('Email archived', { label: 'Undo', onClick: first });
    toastWithUndo('Email deleted', { label: 'Undo', onClick: second });
    expect(toastTitles()).toEqual(['Email deleted']);

    undoLatest();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual(['Email archived']);

    undoLatest();
    expect(first).toHaveBeenCalledTimes(1);
    expect(toastTitles()).toEqual([]);
    expect(undoLatest()).toBeNull();
  });

  it('does not undo twice when the toast\'s Undo is used after Ctrl+Z', () => {
    const run = vi.fn();
    toastWithUndo('Email archived', { label: 'Undo', onClick: run });
    const action = useToastStore.getState().toasts[0].action!;
    undoLatest();
    action.onClick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('takes an action undone from its toast off the list', () => {
    const run = vi.fn();
    toastWithUndo('Email archived', { label: 'Undo', onClick: run });
    useToastStore.getState().toasts[0].action!.onClick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(undoHistory()).toHaveLength(0);
  });

  it(`keeps the last ${MAX_UNDO_HISTORY} actions`, () => {
    for (let i = 0; i < MAX_UNDO_HISTORY + 3; i++) recordUndo(`action ${i}`, () => {});
    const labels = undoHistory().map((e) => e.label);
    expect(labels).toHaveLength(MAX_UNDO_HISTORY);
    expect(labels[0]).toBe('action 3');
    expect(labels.at(-1)).toBe(`action ${MAX_UNDO_HISTORY + 2}`);
  });

  it('tells screen readers how to undo', () => {
    toastWithUndo('Email archived', { label: 'Undo', onClick: () => {}, hint: 'Press Ctrl+Z to undo.' });
    expect(useToastStore.getState().toasts[0].srHint).toBe('Press Ctrl+Z to undo.');
  });
});

describe('undo keys', () => {
  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(e, 'target', { value: target });
    return e;
  };
  const extra: HTMLElement[] = [];
  afterEach(() => { for (const el of extra.splice(0)) el.remove(); });

  it('takes Ctrl+Z and Cmd+Z, and z only with single-key shortcuts on', () => {
    expect(isUndoKey(key({ code: 'KeyZ', key: 'z', ctrlKey: true }), false)).toBe(true);
    expect(isUndoKey(key({ code: 'KeyZ', key: 'z', metaKey: true }), false)).toBe(true);
    expect(isUndoKey(key({ code: 'KeyZ', key: 'z' }), true)).toBe(true);
    expect(isUndoKey(key({ code: 'KeyZ', key: 'z' }), false)).toBe(false);
    expect(isUndoKey(key({ code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(isUndoKey(key({ code: 'KeyY', key: 'y', ctrlKey: true }), true)).toBe(false);
  });

  it('leaves Ctrl+Z to a text field', () => {
    const run = vi.fn();
    recordUndo('Email archived', run);
    const input = document.createElement('input');
    document.body.appendChild(input);
    extra.push(input);
    renderHook(() => useUndoShortcut({ enabled: true, signedIn: true }));
    fireEvent.keyDown(input, { code: 'KeyZ', key: 'z', ctrlKey: true });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { code: 'KeyZ', key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalled();
  });

  it('ignores the keys while a modal dialog is open', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    extra.push(dialog);
    expect(isUndoKey(key({ code: 'KeyZ', key: 'z', ctrlKey: true }), true)).toBe(false);
  });

  it('undoes from the keyboard in Mail, and says so when there is nothing left', () => {
    const run = vi.fn();
    toastWithUndo('Email archived', { label: 'Undo', onClick: run });
    renderHook(() => useUndoShortcut({ enabled: true, signedIn: true }));
    fireEvent.keyDown(document.body, { code: 'KeyZ', key: 'z', ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { code: 'KeyZ', key: 'z', ctrlKey: true });
    expect(toastTitles()).toContain('nothing_to_undo');
  });

  it('forgets the history when signed out', () => {
    recordUndo('Email archived', () => {});
    renderHook(() => useUndoShortcut({ enabled: true, signedIn: false }));
    expect(undoHistory()).toHaveLength(0);
  });
});
