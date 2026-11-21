import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import {
  DEFAULT_ORGANISATION_POLICY,
  mergeOrganisation,
  sanitizeOrganisationPartial,
  sanitizeOrganisationPolicy,
} from '@/lib/admin/organisation-policy';
import { teamMailboxesOn } from '@/lib/team-mailboxes/policy';

// organisation.teamMailboxes.enabled: off by default, one switch, scoped per
// domain or group like every other organisation section.

describe('organisation.teamMailboxes', () => {
  it('is off by default and for anything that is not a boolean', () => {
    expect(DEFAULT_ORGANISATION_POLICY.teamMailboxes).toEqual({ enabled: false });
    expect(sanitizeOrganisationPolicy({ teamMailboxes: { enabled: 'yes' } }).teamMailboxes.enabled).toBe(false);
    expect(sanitizeOrganisationPolicy({ teamMailboxes: { enabled: true, extra: 1 } }).teamMailboxes).toEqual({ enabled: true });
    expect(sanitizeOrganisationPartial({ teamMailboxes: {} })).toEqual({});
  });

  it('merges per leaf, so a scope can turn it off again', () => {
    const on = sanitizeOrganisationPolicy({ teamMailboxes: { enabled: true } });
    expect(mergeOrganisation(on, { teamMailboxes: { enabled: false } }).teamMailboxes.enabled).toBe(false);
    expect(mergeOrganisation(on, {}).teamMailboxes.enabled).toBe(true);
  });
});

describe('teamMailboxesOn', () => {
  const scoped = {
    ...DEFAULT_POLICY,
    scopes: [{ id: 'team', label: 'Team', match: { groups: ['tm-team@example.org'] }, policy: { organisation: { teamMailboxes: { enabled: true } } } }],
  };

  it('is on only in the group whose scope turns it on', () => {
    expect(teamMailboxesOn(scoped as never, 'alice@example.org', 'tm-team@example.org')).toBe(true);
    // Alice is in both groups; the other group has no scope of its own.
    expect(teamMailboxesOn(scoped as never, 'alice@example.org', 'tm-team2@example.org')).toBe(false);
  });

  it('follows a domain scope and the global switch', () => {
    const byDomain = {
      ...DEFAULT_POLICY,
      scopes: [{ id: 'dom', label: 'Example', match: { domains: ['example.org'] }, policy: { organisation: { teamMailboxes: { enabled: true } } } }],
    };
    expect(teamMailboxesOn(byDomain as never, 'Alice@Example.org', 'TM-Team2@example.org')).toBe(true);
    expect(teamMailboxesOn(byDomain as never, 'carol@other.test', 'tm-team2@example.org')).toBe(false);
    const global = { ...DEFAULT_POLICY, organisation: { teamMailboxes: { enabled: true } } };
    expect(teamMailboxesOn(global as never, 'carol@other.test', 'any@example.org')).toBe(true);
  });

  it('is off without a policy or a group address', () => {
    expect(teamMailboxesOn(null, 'alice@example.org', 'tm-team@example.org')).toBe(false);
    expect(teamMailboxesOn(scoped as never, 'alice@example.org', '')).toBe(false);
  });
});
