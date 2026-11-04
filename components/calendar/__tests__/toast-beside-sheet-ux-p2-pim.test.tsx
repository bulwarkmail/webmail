import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// pim-p2-19: toasts at the top right covered the event sheet's title and
// close button; at the bottom right they covered its Save. They stand beside
// a sheet docked at the window's end now. jsdom has no layout, so the rule is
// checked through the cascade: the stylesheet's own rule, applied in jsdom.

const css = readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');

function endSheetRule(): string {
  const match = /body:has\(\[data-end-sheet\]\) \[data-toast-container\] \{[^}]*\}/.exec(css);
  expect(match, 'no end-sheet rule for toasts in globals.css').not.toBeNull();
  return match![0];
}

describe('toasts beside an end sheet', () => {
  it('move the stack past the sheet while one is open', () => {
    const style = document.createElement('style');
    style.textContent = endSheetRule();
    document.head.appendChild(style);
    const container = document.createElement('div');
    container.setAttribute('data-toast-container', '');
    document.body.appendChild(container);
    expect(getComputedStyle(container).getPropertyValue('inset-inline-end')).not.toContain('400px');

    const sheet = document.createElement('div');
    sheet.setAttribute('data-end-sheet', '');
    document.body.appendChild(sheet);
    expect(getComputedStyle(container).getPropertyValue('inset-inline-end')).toBe('calc(var(--end-sheet-width, 400px) + 1.25rem)');
    style.remove();
    container.remove();
    sheet.remove();
  });

  it('marks the calendar event and task panels as end sheets', () => {
    const app = readFileSync(path.join(process.cwd(), 'components', 'calendar', 'calendar-app.tsx'), 'utf8');
    expect(app).toMatch(/data-testid="event-panel" data-end-sheet=""/);
    expect(app).toMatch(/data-end-sheet="" className="w-\[400px\][^"]*"[\s\S]{0,40}<TaskModal/);
  });
});
