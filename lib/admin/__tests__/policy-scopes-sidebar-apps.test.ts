import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type AdminSidebarApp, type SettingsPolicy } from '@/lib/admin/types';
import { defaultSidebarAppLists, resolvePolicy, sanitizeScopes, type PolicyScope } from '@/lib/admin/policy-scopes';
import { EVERYONE_SCOPE, sidebarAppsAt, withSidebarAppsAt } from '@/lib/admin/policy-settings';

// #1806: a domain or group scope can have its own default sidebar apps. Its
// list replaces Everyone's, as a scope's tag list does; without one the
// scope gets Everyone's.

const app = (id: string, url: string, extra: Partial<AdminSidebarApp> = {}): AdminSidebarApp =>
  ({ id: `admin-app-${id}`, name: id, url, icon: 'Globe', openMode: 'tab', showOnMobile: false, ...extra });

const intranet = app('intranet', 'https://intranet.example.com/');
const crmA = app('crm-a', 'https://crm.org-a.test/', { openMode: 'inline' });
const crmB = app('crm-b', 'https://crm.org-b.test/');

function policyWith(scopes: unknown[], extra: Partial<SettingsPolicy> = {}): SettingsPolicy {
  return { ...DEFAULT_POLICY, defaultSidebarApps: [intranet], ...extra, scopes: scopes as PolicyScope[] };
}

const orgA = { id: 'org-a', label: 'Org A', match: { domains: ['org-a.test'] }, policy: { defaultSidebarApps: [intranet, crmA] } };
const orgB = { id: 'org-b', label: 'Org B', match: { domains: ['org-b.test'] }, policy: { defaultSidebarApps: [crmB] } };
const orgC = { id: 'org-c', label: 'Org C', match: { domains: ['org-c.test'] }, policy: {} };
const orgD = { id: 'org-d', label: 'Org D', match: { domains: ['org-d.test'] }, policy: { defaultSidebarApps: [] } };

const apps = (email: string, scopes: unknown[] = [orgA, orgB, orgC, orgD]) =>
  resolvePolicy(policyWith(sanitizeScopes(scopes)), { email, groups: [] }).policy.defaultSidebarApps?.map((a) => a.id);

describe('default sidebar apps per scope', () => {
  it("gives a scope's users the scope's list in place of Everyone's", () => {
    expect(apps('ann@org-a.test')).toEqual(['admin-app-intranet', 'admin-app-crm-a']);
    expect(apps('bob@org-b.test')).toEqual(['admin-app-crm-b']);
  });

  it("gives Everyone's list to a scope without its own and to users of no scope", () => {
    expect(apps('cat@org-c.test')).toEqual(['admin-app-intranet']);
    expect(apps('eve@elsewhere.test')).toEqual(['admin-app-intranet']);
    expect(resolvePolicy(policyWith(sanitizeScopes([orgA])), null).policy.defaultSidebarApps).toEqual([intranet]);
  });

  it('gives no apps to a scope whose own list is empty', () => {
    expect(apps('dan@org-d.test')).toEqual([]);
  });

  it('says which scope set the list', () => {
    const resolved = resolvePolicy(policyWith(sanitizeScopes([orgB])), { email: 'bob@org-b.test', groups: [] });
    expect(resolved.sources.defaultSidebarApps).toBe('org-b');
  });

  it('checks a scope\'s apps like Everyone\'s and leaves the list out when there is none', () => {
    const [scope, plain] = sanitizeScopes([
      { ...orgA, policy: { defaultSidebarApps: [{ name: 'Bad', url: 'javascript:alert(1)' }, { ...crmA, id: 'crm-a' }] } },
      orgC,
    ]);
    expect(scope.policy.defaultSidebarApps).toEqual([{ ...crmA, id: 'admin-app-crm-a' }]);
    expect('defaultSidebarApps' in plain.policy).toBe(false);
  });

  it("lists Everyone's apps and every scope's for the server's headers", () => {
    expect(defaultSidebarAppLists(policyWith(sanitizeScopes([orgA, orgC, orgB])))).toEqual([[intranet], [intranet, crmA], [crmB]]);
  });
});

describe('editing default sidebar apps at a scope', () => {
  const policy = policyWith([{ ...orgC }]);

  it("shows Everyone's apps in a scope until it has its own", () => {
    expect(sidebarAppsAt(policy, 'org-c')).toEqual({ value: [intranet], own: false, everyone: [intranet] });
    const own = withSidebarAppsAt(policy, 'org-c', [crmB]);
    expect(sidebarAppsAt(own, 'org-c')).toEqual({ value: [crmB], own: true, everyone: [intranet] });
    expect(own.defaultSidebarApps).toEqual([intranet]);
    expect(policy.scopes![0].policy.defaultSidebarApps).toBeUndefined();
  });

  it("goes back to Everyone's apps, and edits Everyone's list at Everyone", () => {
    const back = withSidebarAppsAt(withSidebarAppsAt(policy, 'org-c', [crmB]), 'org-c', undefined);
    expect('defaultSidebarApps' in back.scopes![0].policy).toBe(false);
    expect(withSidebarAppsAt(policy, EVERYONE_SCOPE, [crmA]).defaultSidebarApps).toEqual([crmA]);
  });
});
