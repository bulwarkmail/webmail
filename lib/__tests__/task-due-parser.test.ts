import { describe, it, expect } from 'vitest';
import { parseTaskDue } from '../task-due-parser';

// Wednesday, 4 November 2026.
const today = new Date(2026, 10, 4, 9, 30);

describe('parseTaskDue (pim-24)', () => {
  it('takes "tomorrow" off the end of the title as the due date', () => {
    expect(parseTaskDue('Call the plumber tomorrow', 'en', today)).toEqual({
      title: 'Call the plumber',
      due: '2026-11-05',
      matched: 'tomorrow',
    });
  });

  it('takes today and a weekday, with its "on"', () => {
    expect(parseTaskDue('Pay rent today', 'en', today)?.due).toBe('2026-11-04');
    expect(parseTaskDue('Send the report on Friday', 'en', today)).toEqual({
      title: 'Send the report',
      due: '2026-11-06',
      matched: 'on Friday',
    });
    // A weekday already past this week is next week's.
    expect(parseTaskDue('Team lunch Monday', 'en', today)?.due).toBe('2026-11-09');
  });

  it('reads the words of the app language from Intl', () => {
    expect(parseTaskDue('Klempner anrufen morgen', 'de', today)).toMatchObject({ title: 'Klempner anrufen', due: '2026-11-05' });
    expect(parseTaskDue('Bericht schicken am Freitag', 'de', today)).toMatchObject({ title: 'Bericht schicken', due: '2026-11-06' });
    expect(parseTaskDue('Steuer übermorgen', 'de', today)?.due).toBe('2026-11-06');
    expect(parseTaskDue('Appeler le plombier demain', 'fr', today)).toMatchObject({ title: 'Appeler le plombier', due: '2026-11-05' });
    expect(parseTaskDue('Llamar al fontanero mañana', 'es', today)?.due).toBe('2026-11-05');
    expect(parseTaskDue('Позвонить сантехнику завтра', 'ru', today)?.due).toBe('2026-11-05');
    expect(parseTaskDue('配管工に電話 明日', 'ja', today)).toMatchObject({ title: '配管工に電話', due: '2026-11-05' });
    expect(parseTaskDue('给水管工打电话明天', 'zh', today)).toMatchObject({ title: '给水管工打电话', due: '2026-11-05' });
    // English works in every language.
    expect(parseTaskDue('Klempner anrufen tomorrow', 'de', today)?.due).toBe('2026-11-05');
  });

  it('reads numeric dates in the order the locale writes them', () => {
    expect(parseTaskDue('Dentist 12.11.', 'de', today)).toMatchObject({ title: 'Dentist', due: '2026-11-12' });
    expect(parseTaskDue('Dentist 12.11.2027', 'de', today)?.due).toBe('2027-11-12');
    expect(parseTaskDue('Dentist 11/12', 'en-US', today)?.due).toBe('2026-11-12');
    expect(parseTaskDue('Dentist 11/12', 'fr', today)?.due).toBe('2026-12-11');
    expect(parseTaskDue('Dentist 2026-12-01', 'en', today)?.due).toBe('2026-12-01');
    // A day already past without a year is next year's.
    expect(parseTaskDue('Dentist 1.11.', 'de', today)?.due).toBe('2027-11-01');
  });

  it('leaves titles without a date at the end alone', () => {
    expect(parseTaskDue('Tomorrow call the plumber', 'en', today)).toBeNull();
    expect(parseTaskDue('Fix the today page', 'en', today)).toBeNull();
    expect(parseTaskDue('tomorrow', 'en', today)).toBeNull();
    expect(parseTaskDue('Version 31.13', 'de', today)).toBeNull();
    expect(parseTaskDue('Buy 2 apples', 'en', today)).toBeNull();
  });
});
