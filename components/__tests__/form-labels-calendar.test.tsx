import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { unnamedFields } from '@/lib/__tests__/helpers/form-labels';
import { EventModal } from '@/components/calendar/event-modal';
import type { Calendar } from '@/lib/jmap/types';

// The event editor names every field (see form-labels.test.tsx). The live
// audit found the title, the date and time fields and two selects unnamed.

const calendars = [
  { id: 'cal-1', name: 'Work', isDefault: true, myRights: { mayWriteAll: true, mayWriteOwn: true } },
  { id: 'cal-2', name: 'Home', myRights: { mayWriteAll: true, mayWriteOwn: true } },
] as unknown as Calendar[];

describe('event editor fields have labels', () => {
  it('names the title, dates, times, calendar and repeat fields', () => {
    render(<EventModal calendars={calendars} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'form.title' })).toBeInTheDocument();
    expect(screen.getByLabelText('form.start_date')).toHaveAttribute('type', 'date');
    expect(screen.getByRole('textbox', { name: 'form.end_time' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'form.calendar_select' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'recurrence.title' })).toBeInTheDocument();
    expect(unnamedFields()).toEqual([]);
  });
});
