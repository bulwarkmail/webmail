import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOSE_MOVES_ATTRIBUTE, PANE_HEAD_ATTRIBUTE, ROW_ATTRIBUTE, ROW_RIGHT_ATTRIBUTE, markWindowRows } from '@/lib/window-controls-overlay';

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

describe("a close at the end of a row beside the window's", () => {
  it('is marked on a top row whose end has the controls', () => {
    const toolbar = row();
    box(toolbar, 0, 56);
    markWindowRows(AREA);
    expect(toolbar.hasAttribute(CLOSE_MOVES_ATTRIBUTE)).toBe(true);
  });

  it("isn't, right to left, where the row ends at the left and the controls are at the right", () => {
    document.documentElement.dir = 'rtl';
    try {
      const toolbar = row();
      box(toolbar, 0, 56);
      markWindowRows(AREA);
      expect(toolbar.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
      expect(toolbar.hasAttribute(CLOSE_MOVES_ATTRIBUTE)).toBe(false);
    } finally {
      document.documentElement.dir = '';
    }
  });

  it("is marked on a side panel's head right under the controls, and not further down", () => {
    const head = document.createElement('div');
    head.setAttribute(PANE_HEAD_ATTRIBUTE, '');
    document.body.appendChild(head);
    box(head, 60, 40, 700, 1000);
    markWindowRows(AREA);
    expect(head.hasAttribute(CLOSE_MOVES_ATTRIBUTE)).toBe(true);
    // No room is made in it: it's below the controls.
    expect(head.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
    box(head, 200, 40, 700, 1000);
    markWindowRows(AREA);
    expect(head.hasAttribute(CLOSE_MOVES_ATTRIBUTE)).toBe(false);
  });

  it("is asked by every pane that can end up at the window's top right", () => {
    for (const file of [
      'components/email/email-composer.tsx',
      'components/layout/inline-app-view.tsx',
      'components/calendar/event-modal.tsx',
      'components/files/preview-shell.tsx',
      'components/calendar/task-modal.tsx',
      'components/contacts/contact-form.tsx',
      'components/offline/offline-banner.tsx',
      'components/org/org-announcement.tsx',
      'components/plugins/plugin-side-panels.tsx',
      'components/layout/mv-side-panel.tsx',
    ]) {
      expect(read(file), file).toContain('useCloseBesideControls(');
    }
  });
});

describe('notices at the top', () => {
  it('toasts that step out of the way stay below the controls', () => {
    expect(read('app/globals.css')).toMatch(/html\[data-window-controls\] \[data-toast-container\]\[data-dodging\]\s*\{[^}]*--titlebar-row-height/);
  });

  it("the offline bar and the organisation's notice are rows that make room for the controls", () => {
    for (const file of ['components/offline/offline-banner.tsx', 'components/org/org-announcement.tsx']) {
      expect(read(file), file).toContain('data-window-top-row=""');
    }
  });
});
