import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import {
  domainPatternMatches,
  resolvePolicy,
  sanitizeScopes,
  scopesVisibleTo,
  type PolicyScope,
} from '@/lib/admin/policy-scopes';
import { sanitizeOrganisationPolicy, DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';

const alice = { email: 'org-alice@example.org', groups: ['org-team@example.org'] };
const dave = { email: 'org-dave@org-two.test', groups: [] };
const carol = { email: 'org-carol@example.org', groups: [] };

function policyWith(scopes: unknown[], extra: Partial<SettingsPolicy> = {}): SettingsPolicy {
  return { ...DEFAULT_POLICY, ...extra, scopes: scopes as PolicyScope[] };
}

const twoDomain = {
  id: 'two', label: 'Org two', match: { domains: ['org-two.test'] },
  policy: { features: { calendarEnabled: false } },
};
const team = {
  id: 'team', label: 'Team', match: { groups: ['org-team@example.org'] },
  policy: { restrictions: { density: { locked: true, value: 'compact' } }, organisation: { session: { idleMinutes: 15 } } },
};

describe('resolvePolicy', () => {
  it('applies a domain scope only to addresses in that domain', () => {
    const policy = policyWith([twoDomain]);
    expect(resolvePolicy(policy, dave).policy.features.calendarEnabled).toBe(false);
    expect(resolvePolicy(policy, alice).policy.features.calendarEnabled).toBe(true);
    expect(resolvePolicy(policy, null).policy.features.calendarEnabled).toBe(true);
  });

  it('applies a group scope to members only, case-insensitively', () => {
    const policy = policyWith([team]);
    const forAlice = resolvePolicy(policy, { ...alice, groups: ['Org-Team@Example.org'] });
    expect(forAlice.policy.restrictions.density).toEqual({ locked: true, value: 'compact' });
    expect(forAlice.policy.organisation?.session.idleMinutes).toBe(15);
    expect(forAlice.matched).toEqual(['team']);
    const forCarol = resolvePolicy(policy, carol);
    expect(forCarol.policy.restrictions.density).toBeUndefined();
    expect(forCarol.policy.organisation?.session.idleMinutes).toBe(0);
  });

  it('applies domain scopes before group scopes, whatever the list order', () => {
    const groupFirst = { ...team, policy: { organisation: { session: { idleMinutes: 30 } } } };
    const domainScope = { id: 'main', label: 'Main', match: { domains: ['example.org'] }, policy: { organisation: { session: { idleMinutes: 60, maxHours: 8 } } } };
    const resolved = resolvePolicy(policyWith([groupFirst, domainScope]), alice);
    expect(resolved.matched).toEqual(['main', 'team']);
    expect(resolved.policy.organisation?.session).toEqual({ idleMinutes: 30, maxHours: 8, warnSeconds: 60 });
    expect(resolved.sources['organisation.session.idleMinutes']).toBe('team');
    expect(resolved.sources['organisation.session.maxHours']).toBe('main');
  });

  it('lets the later scope of the same kind win', () => {
    const a = { id: 'a', label: 'A', match: { domains: ['example.org'] }, policy: { features: { contactsEnabled: false } } };
    const b = { id: 'b', label: 'B', match: { domains: ['*.org', 'example.org'] }, policy: { features: { contactsEnabled: true } } };
    expect(resolvePolicy(policyWith([a, b]), alice).policy.features.contactsEnabled).toBe(true);
    expect(resolvePolicy(policyWith([b, a]), alice).policy.features.contactsEnabled).toBe(false);
  });

  it('adds a scope\'s templates to the inherited library and replaces the same id', () => {
    const policy = policyWith(
      [{ id: 'team', label: 'Team', match: { groups: ['org-team@example.org'] }, policy: { organisation: { templates: { library: [
        { id: 'welcome', name: 'Team welcome', subject: 'Hi team', body: 'b' },
        { id: 'faq', name: 'FAQ', subject: '', body: 'b' },
      ] } } } }],
      { organisation: sanitizeOrganisationPolicy({ templates: { library: [
        { id: 'welcome', name: 'Welcome', subject: 'Hi', body: 'a' },
        { id: 'legal', name: 'Legal', subject: '', body: 'a' },
      ] } }) },
    );
    const names = resolvePolicy(policy, alice).policy.organisation?.templates.library.map((t) => t.name);
    expect(names).toEqual(['Team welcome', 'Legal', 'FAQ']);
    expect(resolvePolicy(policy, carol).policy.organisation?.templates.library.map((t) => t.name)).toEqual(['Welcome', 'Legal']);
  });

  it('records what the global policy set, but not values equal to the defaults', () => {
    const policy = policyWith([], {
      features: { ...DEFAULT_POLICY.features, calendarEnabled: false, contactsEnabled: true },
      organisation: sanitizeOrganisationPolicy({ externalMail: { senderLabel: true, recipientWarning: false } }),
    });
    const { sources } = resolvePolicy(policy, alice);
    expect(sources['features.calendarEnabled']).toBe('global');
    expect(sources['features.contactsEnabled']).toBeUndefined();
    expect(sources['organisation.externalMail.senderLabel']).toBe('global');
    expect(sources['organisation.externalMail.recipientWarning']).toBeUndefined();
  });

  it('hands out the effective policy without scopes and with the organisation defaults filled in', () => {
    const resolved = resolvePolicy(policyWith([twoDomain]), dave).policy;
    expect(resolved.scopes).toBeUndefined();
    expect(resolved.organisation).toEqual(DEFAULT_ORGANISATION_POLICY);
  });
});

describe('domainPatternMatches', () => {
  it('matches exact domains and subdomains of a wildcard, not the bare wildcard domain', () => {
    expect(domainPatternMatches('example.org', 'example.org')).toBe(true);
    expect(domainPatternMatches('example.org', 'eu.example.org')).toBe(false);
    expect(domainPatternMatches('*.example.org', 'eu.example.org')).toBe(true);
    expect(domainPatternMatches('*.example.org', 'example.org')).toBe(false);
    expect(domainPatternMatches('*.example.org', 'badexample.org')).toBe(false);
  });
});

describe('sanitizeScopes', () => {
  it('drops bad ids, duplicates, invalid matches and unknown or server-checked feature gates', () => {
    const scopes = sanitizeScopes([
      { id: 'Sales', label: ' Sales ', match: { domains: ['Example.ORG.', 'not a domain', 'http://x.org'], groups: ['Sales@Example.org', 'nope'] },
        policy: { features: { calendarEnabled: false, pluginsEnabled: true, madeUp: true, contactsEnabled: 'no' },
          restrictions: { density: { locked: true, value: 'compact', junk: 1 }, __proto__: { locked: true } },
          defaults: { density: 'compact', list: [NaN] },
          organisation: { session: { idleMinutes: -5, extra: 1 }, unknown: {} } } },
      { id: 'sales', label: 'Duplicate', match: {}, policy: {} },
      { id: '../x', label: 'Bad', match: {}, policy: {} },
      'nonsense',
    ]);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toEqual({
      id: 'sales',
      label: 'Sales',
      match: { domains: ['example.org'], groups: ['sales@example.org'] },
      policy: {
        features: { calendarEnabled: false },
        restrictions: { density: { locked: true, value: 'compact' } },
        defaults: { density: 'compact' },
        organisation: { session: { idleMinutes: 0 } },
      },
    });
  });
});

describe('scopesVisibleTo', () => {
  const scopes = sanitizeScopes([
    twoDomain,
    team,
    { id: 'wild', label: 'Wild', match: { domains: ['*.example.org'] }, policy: {} },
  ]);

  it('gives a user only the scopes of their own domains', () => {
    expect(scopesVisibleTo(scopes, ['org-alice@example.org']).map((s) => s.id)).toEqual(['team']);
    expect(scopesVisibleTo(scopes, ['org-dave@org-two.test']).map((s) => s.id)).toEqual(['two']);
    expect(scopesVisibleTo(scopes, ['x@eu.example.org']).map((s) => s.id)).toEqual(['wild']);
    expect(scopesVisibleTo(scopes, ['org-alice@example.org', 'org-dave@org-two.test']).map((s) => s.id)).toEqual(['two', 'team']);
  });

  it('gives a browser without a known address none', () => {
    expect(scopesVisibleTo(scopes, [])).toEqual([]);
    expect(scopesVisibleTo(scopes, ['admin'])).toEqual([]);
  });
});
