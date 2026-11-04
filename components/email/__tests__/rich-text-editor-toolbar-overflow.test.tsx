import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import { RichTextEditor, formattingFoldCount } from '../rich-text-editor';

// The formatting toolbar keeps one row: in a narrow composer (585 px at
// 1280x720) it wrapped to two and took the body's room. What doesn't fit goes
// behind "More formatting", the least used first.

let toolbarWidth = 1200;
const observers = new Set<ResizeObserverCallback>();
class ReportingResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() { observers.add(this.cb); }
  unobserve() {}
  disconnect() { observers.delete(this.cb); }
}
vi.stubGlobal('ResizeObserver', ReportingResizeObserver);

const realClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return this.getAttribute('role') === 'toolbar' ? toolbarWidth : realClientWidth.get!.call(this);
  },
});

afterEach(() => {
  toolbarWidth = 1200;
});

async function setup() {
  let ready = false;
  render(<RichTextEditor content="<p>Hello</p>" onChange={() => {}} onEditorReady={() => { ready = true; }} />);
  await waitFor(() => expect(ready).toBe(true));
}

async function resize(width: number) {
  toolbarWidth = width;
  await act(async () => {
    for (const cb of observers) cb([], {} as ResizeObserver);
  });
}

const toolbar = () => screen.getByRole('toolbar', { name: 'formatting' });
const rowItem = (name: string) => toolbar().querySelector(`[data-toolbar-item="${name}"]`);

describe('formatting toolbar in a narrow composer', () => {
  it('shows every button in one row when there is room, without a More button', async () => {
    await setup();
    for (const name of ['heading-1', 'quote', 'align-left', 'table', 'undo']) expect(rowItem(name)).not.toBeNull();
    expect(rowItem('more-formatting')).toBeNull();
  });

  it('moves what does not fit behind "More formatting", and shows it there', async () => {
    await setup();
    await resize(561);

    // The least used go first: undo, redo, clear formatting, then alignment.
    for (const name of ['undo', 'redo', 'clear-formatting', 'align-left', 'align-right']) expect(rowItem(name)).toBeNull();
    for (const name of ['bold', 'bullet-list', 'link', 'heading-1', 'table']) expect(rowItem(name)).not.toBeNull();

    const more = rowItem('more-formatting') as HTMLButtonElement;
    expect(more).toHaveAccessibleName('more_formatting');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    const panel = screen.getByRole('dialog', { name: 'more_formatting' });
    expect(more).toHaveAttribute('aria-expanded', 'true');
    for (const name of ['align-left', 'align-center', 'align-right', 'clear-formatting', 'undo', 'redo']) {
      expect(within(panel).getByRole('button', { name: new RegExp(`^${name.replace('-', '_')}`) })).toBeInTheDocument();
    }
  });

  it('keeps the arrows in the row: the panel buttons are no Tab stops of the toolbar', async () => {
    await setup();
    await resize(561);
    fireEvent.click(rowItem('more-formatting')!);
    const panel = screen.getByRole('dialog', { name: 'more_formatting' });
    const rowStops = Array.from(toolbar().querySelectorAll<HTMLElement>('[data-toolbar-item]'))
      .filter((el) => !panel.contains(el) && el.tabIndex === 0);
    expect(rowStops).toHaveLength(1);
  });

  it('brings everything back into the row when the composer gets wider', async () => {
    await setup();
    await resize(400);
    expect(rowItem('heading-1')).toBeNull();
    await resize(1000);
    expect(rowItem('heading-1')).not.toBeNull();
    expect(rowItem('undo')).not.toBeNull();
    expect(rowItem('more-formatting')).toBeNull();
  });
});

describe('formattingFoldCount', () => {
  const sizes = { button: 28, gap: 2, separator: 5 };

  it('folds nothing for a toolbar that is not laid out', () => {
    expect(formattingFoldCount(0, sizes)).toBe(0);
  });

  it('folds more groups the narrower the row', () => {
    const counts = [900, 700, 561, 480, 400, 300].map((width) => formattingFoldCount(width, sizes));
    expect(counts[0]).toBe(0);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts[counts.length - 1]).toBe(5);
  });

  it('makes room for the text direction button', () => {
    const width = 700;
    expect(formattingFoldCount(width, { ...sizes, directionButton: true })).toBeGreaterThanOrEqual(formattingFoldCount(width, sizes));
  });
});
