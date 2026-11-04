import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROW_ATTRIBUTE, ROW_RIGHT_ATTRIBUTE, markWindowRows } from '@/lib/window-controls-overlay';

/** The controls take the right 138px of the window, 56px high. */
const AREA = { x: 0, y: 0, width: 1024 - 138, height: 56 };

function box(el: HTMLElement, top: number, height: number, left = 0, right = 1024) {
  el.getBoundingClientRect = () => ({ top, bottom: top + height, left, right, width: right - left, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

function row(parent: HTMLElement = document.body): HTMLElement {
  const el = document.createElement('div');
  el.className = 'h-14';
  parent.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('rows under the window\'s controls', () => {
  it('a toolbar pushed down by a line above it still makes room for the controls', () => {
    // "This message was moved", an offline note, an update banner: the toolbar starts at 37px.
    const toolbar = row();
    box(toolbar, 37, 56);
    markWindowRows(AREA);
    expect(toolbar.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
    // It isn't the window's top, so it isn't what the window is dragged by.
    expect(toolbar.hasAttribute(ROW_ATTRIBUTE)).toBe(false);
  });

  it('a row at the top is still a row to drag by, with room at its end', () => {
    const toolbar = row();
    box(toolbar, 0, 56);
    markWindowRows(AREA);
    expect(toolbar.hasAttribute(ROW_ATTRIBUTE)).toBe(true);
    expect(toolbar.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
  });

  it('a row that starts below the controls is left alone', () => {
    const below = row();
    box(below, 56, 56);
    markWindowRows(AREA);
    expect(below.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
  });

  it('a row of a list scrolled up under the header is left alone', () => {
    const list = document.createElement('div');
    document.body.appendChild(list);
    Object.defineProperty(list, 'scrollTop', { value: 120, configurable: true });
    const item = row(list);
    box(item, 20, 56);
    markWindowRows(AREA);
    expect(item.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
  });

  it('a row that ends before the controls gets no room for them', () => {
    const left = row();
    box(left, 30, 56, 0, 500);
    markWindowRows(AREA);
    expect(left.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
  });
});

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('a pane\'s close next to the window\'s', () => {
  it('moves to the other end of the row, on the side away from the controls', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/html\[data-window-controls\]:not\(\[dir="rtl"\]\) \[data-window-row-right\] > \[data-pane-close\]/);
    expect(css).toMatch(/html\[data-window-controls\]\[dir="rtl"\] \[data-window-row-left\] > \[data-pane-close\]/);
  });

  it('is marked on every pane that can end up at the window\'s top right', () => {
    for (const file of [
      'components/email/email-composer.tsx',
      'components/layout/inline-app-view.tsx',
      'components/calendar/event-modal.tsx',
      'components/files/preview-shell.tsx',
      'components/calendar/task-modal.tsx',
      'components/contacts/contact-form.tsx',
    ]) {
      expect(read(file), file).toContain('data-pane-close');
    }
  });

  it('toasts that step out of the way stay below the controls', () => {
    expect(read('app/globals.css')).toMatch(/html\[data-window-controls\] \[data-toast-container\]\[data-dodging\]\s*\{[^}]*--titlebar-row-height/);
  });
});
