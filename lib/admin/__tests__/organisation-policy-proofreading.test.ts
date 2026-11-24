import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORGANISATION_POLICY,
  mergeOrganisation,
  sanitizeOrganisationPartial,
  sanitizeOrganisationPolicy,
} from '@/lib/admin/organisation-policy';
import { localeText } from '@/lib/org-announcement';

// organisation.proofreading.notice: the admin's wording of the proofreading
// notice per locale; a locale without text keeps the built-in one (#1836).

describe('organisation.proofreading', () => {
  it('defaults to no admin text', () => {
    expect(DEFAULT_ORGANISATION_POLICY.proofreading).toEqual({ notice: {} });
    expect(sanitizeOrganisationPolicy({}).proofreading).toEqual({ notice: {} });
  });

  it('keeps valid locales with text and drops the rest', () => {
    const policy = sanitizeOrganisationPolicy({ proofreading: { notice: {
      de: '  Bleibt hier.  ', en: '   ', 'pt-BR': 'Fica aqui.', 'not a locale': 'x', fr: 42,
    }, extra: true } });
    expect(policy.proofreading).toEqual({ notice: { de: 'Bleibt hier.', 'pt-BR': 'Fica aqui.' } });
    expect(sanitizeOrganisationPartial({ proofreading: { notice: 'text' } })).toEqual({});
  });

  it('caps a text at 4000 characters', () => {
    const policy = sanitizeOrganisationPolicy({ proofreading: { notice: { en: 'a'.repeat(5000) } } });
    expect(policy.proofreading.notice.en).toHaveLength(4000);
  });

  it('a scope text replaces Everyone\'s texts as a whole', () => {
    const everyone = sanitizeOrganisationPolicy({ proofreading: { notice: { en: 'Everyone', de: 'Alle' } } });
    const merged = mergeOrganisation(everyone, sanitizeOrganisationPartial({ proofreading: { notice: { en: 'Family' } } }));
    expect(merged.proofreading.notice).toEqual({ en: 'Family' });
  });
});

describe('localeText', () => {
  const notice = { de: 'Deutsch', 'pt-BR': 'Português', en: '  ' };
  it('finds the locale, its language, or another variant of the language', () => {
    expect(localeText(notice, 'de')).toBe('Deutsch');
    expect(localeText(notice, 'de-AT')).toBe('Deutsch');
    expect(localeText(notice, 'pt')).toBe('Português');
  });
  it('has nothing for a language without text, so the built-in notice shows', () => {
    expect(localeText(notice, 'en')).toBeUndefined();
    expect(localeText(notice, 'fr')).toBeUndefined();
    expect(localeText(undefined, 'de')).toBeUndefined();
  });
});
