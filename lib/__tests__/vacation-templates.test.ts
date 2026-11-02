import { describe, expect, it } from 'vitest';
import type { VacationTemplate } from '@/lib/admin/organisation-policy';
import { fillTextTemplate } from '@/lib/org-signature';
import {
  deputyFieldsNeeded,
  fillVacationTemplate,
  formatAbsenceDate,
  vacationValues,
} from '@/lib/vacation-templates';

const template = (patch: Partial<VacationTemplate>): VacationTemplate => ({
  id: 't', name: 'Holiday', category: '', subject: '', text: '', html: '', ...patch,
});

const values = (patch: Partial<Parameters<typeof vacationValues>[0]> = {}) => vacationValues({
  name: 'Alice Example',
  email: 'alice@example.org',
  company: 'Example GmbH',
  fromDate: '2026-12-21T08:00:00Z',
  toDate: '2027-01-03T23:00:00Z',
  deputy: 'bob@example.org',
  deputyName: 'Bob',
  locale: 'en-GB',
  timeZone: 'Europe/Berlin',
  ...patch,
});

describe('fillVacationTemplate', () => {
  it('fills every placeholder in subject, text and HTML', () => {
    const filled = fillVacationTemplate(template({
      subject: 'Out of office until {end}',
      text: 'Hello,\n\nI am away from {start} to {end}.\nPlease write to {deputy_name} at {deputy}.\n\n{name}\n{company}',
      html: '<p>Write to <a href="mailto:{deputy}">{deputy_name}</a>.</p><p>{name}, {email}</p>',
    }), values());
    // ICU versions differ in commas and leading zeros, not in the day.
    expect(filled.subject).toMatch(/^Out of office until Monday,? 4 January 2027$/);
    expect(filled.text).toMatch(new RegExp(
      '^Hello,\\n\\nI am away from Monday,? 21 December 2026 at 0?9:00 to Monday,? 4 January 2027\\.\\n' +
      'Please write to Bob at bob@example\\.org\\.\\n\\nAlice Example\\nExample GmbH$',
    ));
    expect(filled.html).toBe('<p>Write to <a href="mailto:bob@example.org">Bob</a>.</p><p>Alice Example, alice@example.org</p>');
  });

  it('drops a line whose placeholders are all empty, and closes up the subject', () => {
    const filled = fillVacationTemplate(template({
      subject: 'Away until {end}',
      text: 'I am away.\nI am back on {end}.\nRegards',
    }), values({ toDate: null }));
    expect(filled.subject).toBe('Away until');
    expect(filled.text).toBe('I am away.\nRegards');
  });

  it('escapes typed values in HTML', () => {
    const filled = fillVacationTemplate(template({ html: '<p>{deputy_name}</p>' }), values({ deputyName: '<img src=x onerror=alert(1)>' }));
    expect(filled.html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('leaves other braces alone', () => {
    expect(fillVacationTemplate(template({ text: 'Ticket {id} for {name}' }), values()).text).toBe('Ticket {id} for Alice Example');
  });
});

describe('deputyFieldsNeeded', () => {
  it('asks for the address when the template names a deputy, and for the name only when it uses it', () => {
    expect(deputyFieldsNeeded(template({ text: 'Write to {deputy}.' }))).toEqual({ address: true, name: false });
    expect(deputyFieldsNeeded(template({ html: '<p>{deputy_name}</p>' }))).toEqual({ address: true, name: true });
    expect(deputyFieldsNeeded(template({ subject: 'Away', text: 'Back on {end}' }))).toEqual({ address: false, name: false });
  });
});

describe('formatAbsenceDate', () => {
  it('formats in the given time zone and language, the day alone at midnight', () => {
    expect(formatAbsenceDate('2027-01-03T23:00:00Z', 'en-GB', 'Europe/Berlin')).toMatch(/^Monday,? 4 January 2027$/);
    expect(formatAbsenceDate('2027-01-03T23:00:00Z', 'en-GB', 'America/New_York')).toMatch(/^Sunday,? 3 January 2027 at 18:00$/);
    expect(formatAbsenceDate('2027-01-03T23:00:00Z', 'de', 'Europe/Berlin')).toBe('Montag, 4. Januar 2027');
    expect(formatAbsenceDate(null, 'en', 'UTC')).toBe('');
  });
});

describe('the signature filler with its own keys', () => {
  it('still fills only the signature placeholders by default', () => {
    expect(fillTextTemplate('{name} {deputy}', { name: 'A', deputy: 'b@x' } as never)).toBe('A {deputy}');
  });
});
