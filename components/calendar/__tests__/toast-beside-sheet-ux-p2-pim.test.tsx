import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// pim-p2-19: toasts at the top right covered the event sheet's title and
// close button; at the bottom right they covered its Save. They stand beside
// a sheet docked at the window's end, or above its buttons when the window
// has no room beside it. lib/toast-placement does that for whatever is marked
// (components/ui/__tests__/toast-placement.test.tsx); here: the marks.

const read = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), 'utf8');

describe('toasts beside an end sheet', () => {
  it('leaves the place to lib/toast-placement, with no fixed width in the stylesheet', () => {
    expect(read('app', 'globals.css')).not.toMatch(/\[data-end-sheet\][^{]*\[data-toast-container\]/);
  });

  it('marks the calendar event and task panels as end sheets', () => {
    const app = read('components', 'calendar', 'calendar-app.tsx');
    expect(app).toMatch(/data-testid="event-panel" data-end-sheet=""/);
    expect(app).toMatch(/data-end-sheet="" className="w-\[400px\][^"]*"[\s\S]{0,40}<TaskModal/);
  });

  it('marks the button rows of the panels, which toasts keep clear of when there is no room beside', () => {
    expect(read('components', 'calendar', 'event-modal.tsx').match(/data-toast-avoid="bottom"/g)).toHaveLength(2);
    expect(read('components', 'calendar', 'task-modal.tsx')).toContain('data-toast-avoid="bottom"');
  });
});
