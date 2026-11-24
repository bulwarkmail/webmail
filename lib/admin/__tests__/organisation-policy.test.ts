import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORGANISATION_POLICY,
  normalizeDomainList,
  parseDomainList,
  sanitizeOrganisationPolicy,
} from '@/lib/admin/organisation-policy';
import { applyLitePolicy } from '@/lib/lite-config';

describe('sanitizeOrganisationPolicy', () => {
  it('gives the defaults for nothing or nonsense', () => {
    expect(sanitizeOrganisationPolicy(undefined)).toEqual(DEFAULT_ORGANISATION_POLICY);
    expect(sanitizeOrganisationPolicy('x')).toEqual(DEFAULT_ORGANISATION_POLICY);
    expect(sanitizeOrganisationPolicy({ session: 'x', signature: [] })).toEqual(DEFAULT_ORGANISATION_POLICY);
  });

  it('keeps valid values, clamps numbers and drops wrong types and unknown keys', () => {
    const org = sanitizeOrganisationPolicy({
      externalMail: { senderLabel: true, recipientWarning: 'yes', domains: 'Example.org, @partner.io *.eu.example.org bad_domain' },
      signature: { html: '<p>{name}</p>', fields: ['phone', 'shoe size', 'title'] },
      session: { idleMinutes: 15.4, maxHours: -1, warnSeconds: 99999 },
      templates: { library: [{ id: 'a', name: 'A', body: 'x' }, { id: 'a', name: 'Dup' }, { name: 'No id' }] },
      madeUp: { x: 1 },
    });
    expect(org.externalMail).toEqual({ senderLabel: true, recipientWarning: false, domains: ['example.org', 'partner.io', 'eu.example.org'], trustContacts: true });
    expect(org.signature).toEqual({ html: '<p>{name}</p>', text: '', fields: ['title', 'phone'] });
    expect(org.session).toEqual({ idleMinutes: 15, maxHours: 0, warnSeconds: 600 });
    expect(org.templates.library).toEqual([{ id: 'a', name: 'A', subject: '', body: 'x', isHTML: false, category: '' }]);
    expect(org).not.toHaveProperty('madeUp');
  });

  it('normalises domain lists from text or arrays', () => {
    expect(normalizeDomainList(['A.org', 'a.org', 'x'])).toEqual(['a.org']);
    expect(normalizeDomainList(42)).toBeUndefined();
  });

  it('takes IDN domains in ASCII form and names what it left out', () => {
    expect(parseDomainList('Bücher.de, xn--bcher-kva.de, @partner.example, *.sub.example\nnot a domain, x')).toEqual({
      domains: ['xn--bcher-kva.de', 'partner.example', 'sub.example'],
      rejected: ['not', 'a', 'domain', 'x'],
    });
    expect(parseDomainList(['bad_domain.example', 'ok.example'])).toEqual({ domains: ['ok.example'], rejected: ['bad_domain.example'] });
  });
});

describe('applyLitePolicy', () => {
  it('keeps scopes and organisation settings, but no scope switches on what Lite lacks', () => {
    const policy = applyLitePolicy({
      organisation: { session: { idleMinutes: 10 } },
      scopes: [{ id: 'x', label: 'X', match: { domains: ['example.org'] }, policy: { features: { sidebarAppsEnabled: true, calendarEnabled: false } } }],
    });
    expect(policy.organisation?.session.idleMinutes).toBe(10);
    expect(policy.scopes?.[0].policy.features).toEqual({ calendarEnabled: false, ...{
      pluginsEnabled: false, pluginsUploadEnabled: false, sidebarAppsEnabled: false,
      accountArchiveEnabled: false, accountArchivePasswordsEnabled: false,
      remoteContentProxyEnabled: false,
    } });
  });
});
