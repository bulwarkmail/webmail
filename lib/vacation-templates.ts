/**
 * Out-of-office templates from the admin library (policy.json
 * `organisation.vacationTemplates.library`, enterprise pack item 11). A
 * template is filled in when the user picks it, with the same placeholder
 * style and empty-line rule as the organisation signature
 * (lib/org-signature.ts): `{name}`, `{email}`, `{company}`, `{start}`,
 * `{end}`, `{deputy}`, `{deputy_name}`. The deputy is typed by the user
 * before anything is filled, so a half-filled reply is never saved.
 */

import type { VacationTemplate } from '@/lib/admin/organisation-policy';
import { fillHtmlTemplate, fillTextTemplate, placeholderPattern, placeholdersIn, type PlaceholderValues } from '@/lib/org-signature';
import { getWallClock } from '@/lib/timezone';

export const VACATION_PLACEHOLDERS = ['name', 'email', 'company', 'start', 'end', 'deputy', 'deputy_name'] as const;
export type VacationPlaceholder = (typeof VACATION_PLACEHOLDERS)[number];
export type VacationValues = Partial<Record<VacationPlaceholder, string>>;

const RE = placeholderPattern(VACATION_PLACEHOLDERS);

/** The placeholders a template uses anywhere (subject, text or HTML). */
export function vacationPlaceholdersIn(template: Pick<VacationTemplate, 'subject' | 'text' | 'html'>): VacationPlaceholder[] {
  const found = new Set<string>([
    ...placeholdersIn(template.subject, RE),
    ...placeholdersIn(template.text, RE),
    ...placeholdersIn(template.html, RE),
  ]);
  return VACATION_PLACEHOLDERS.filter((key) => found.has(key));
}

/** What the user has to type before the template can be filled: the deputy's address, and name if the text uses it. */
export function deputyFieldsNeeded(template: Pick<VacationTemplate, 'subject' | 'text' | 'html'>): { address: boolean; name: boolean } {
  const used = vacationPlaceholdersIn(template);
  const name = used.includes('deputy_name');
  return { address: used.includes('deputy') || name, name };
}

/**
 * A date of the absence for the reply, in the user's language and time
 * zone: the day alone when it is midnight there ("back on Monday 9
 * November"), else day and time.
 */
export function formatAbsenceDate(iso: string | null | undefined, locale: string, timeZone: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const wall = getWallClock(date, timeZone);
  const midnight = wall.hour === 0 && wall.minute === 0;
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      ...(midnight ? {} : { hour: 'numeric', minute: '2-digit' }),
      timeZone,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export interface VacationFillInput {
  name: string;
  email: string;
  company: string;
  fromDate: string | null;
  toDate: string | null;
  deputy: string;
  deputyName: string;
  locale: string;
  timeZone: string;
}

export function vacationValues(input: VacationFillInput): VacationValues {
  return {
    name: input.name.trim(),
    email: input.email.trim(),
    company: input.company.trim(),
    start: formatAbsenceDate(input.fromDate, input.locale, input.timeZone),
    end: formatAbsenceDate(input.toDate, input.locale, input.timeZone),
    deputy: input.deputy.trim(),
    deputy_name: input.deputyName.trim(),
  };
}

export interface FilledVacationTemplate {
  subject: string;
  text: string;
  /** '' when the template has no HTML version. */
  html: string;
}

/**
 * The template filled in. The subject is one line: its empty placeholders
 * go and the spaces around them close up; in the text and HTML a line
 * whose placeholders are all empty is dropped ("I'm back on {end}" with no
 * end date).
 */
export function fillVacationTemplate(template: VacationTemplate, values: VacationValues): FilledVacationTemplate {
  const v = values as PlaceholderValues;
  const subject = template.subject
    .replace(RE, (_, key: string) => (v[key] ?? '').trim())
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .trim();
  return {
    subject,
    text: template.text.trim() ? fillTextTemplate(template.text, v, VACATION_PLACEHOLDERS) : '',
    html: template.html.trim() ? fillHtmlTemplate(template.html, v, VACATION_PLACEHOLDERS) : '',
  };
}

/** The library sorted for the picker: by category, then name. */
export function sortedVacationTemplates(library: readonly VacationTemplate[]): VacationTemplate[] {
  return [...library].sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
}
