/**
 * Per-domain and per-group policies (policy.json `scopes`).
 *
 * A scope matches a signed-in account by the domain of its address or by a
 * group account in its JMAP session (the groups the user is a member of;
 * groups without a mailbox don't show up there). The effective policy is
 * the global one with every matching scope applied on top: domain scopes
 * first, then group scopes, each in list order, the later value winning per
 * key. Features, restrictions and defaults merge per key; the organisation
 * settings per leaf (see mergeOrganisation). A scope's own list of default
 * sidebar apps replaces Everyone's, as its tag list does.
 *
 * Pure functions: the policy store resolves for the active account, the
 * admin panel's effective-policy view and the tests use the same code.
 */

import type { AdminSidebarApp, FeatureGates, SettingRestriction, SettingsPolicy } from './types';
import { DEFAULT_FEATURE_GATES } from './types';
import {
  DEFAULT_ORGANISATION_POLICY,
  mergeOrganisation,
  sanitizeOrganisationPartial,
  sanitizeOrganisationPolicy,
  type DeepPartial,
  type OrganisationPolicy,
} from './organisation-policy';
import { sanitizePolicyDefaults } from './policy-defaults';
import { sanitizeDefaultSidebarApps } from '@/lib/sidebar-apps';

export interface PolicyScopeOverrides {
  features?: Partial<FeatureGates>;
  restrictions?: Record<string, SettingRestriction>;
  defaults?: Record<string, unknown>;
  organisation?: DeepPartial<OrganisationPolicy>;
  /**
   * The scope's default sidebar apps (#1806), in place of Everyone's; an
   * empty list means none. Without it the scope gets Everyone's.
   */
  defaultSidebarApps?: AdminSidebarApp[];
}

export interface PolicyScope {
  /** Issued by the admin panel; lowercase letters, digits and dashes. */
  id: string;
  label: string;
  match: {
    /** Address domains: "example.com" exactly, or "*.example.com" for its subdomains. */
    domains?: string[];
    /** Group account addresses, such as sales@example.com. */
    groups?: string[];
  };
  policy: PolicyScopeOverrides;
}

/** Who a policy is resolved for. */
export interface PolicySubject {
  /** The account's login address. */
  email: string;
  /** Addresses of the group accounts in the account's session. */
  groups: string[];
}

export type PolicySource = 'default' | 'global' | string;

export interface ResolvedPolicy {
  /** The policy with every matching scope applied, without `scopes`. */
  policy: SettingsPolicy;
  /** Ids of the matching scopes, in the order they were applied. */
  matched: string[];
  /**
   * What set each value that differs from the built-in default, by dotted
   * key (`features.calendarEnabled`, `restrictions.density`,
   * `defaults.density`, `organisation.session.idleMinutes`): `global` or a
   * scope id.
   */
  sources: Record<string, PolicySource>;
}

export const MAX_SCOPES = 200;
const SCOPE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DOMAIN_PATTERN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const GROUP_RE = /^[^\s@]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/**
 * Gates the server checks itself, for requests it can't tie to a scope
 * (plugin bundles, plugin secrets and approvals, the account list backup).
 * They stay global: a scope that turned one on would show users a feature
 * the server then refuses.
 */
export const GLOBAL_ONLY_FEATURES: ReadonlySet<string> = new Set([
  'pluginsEnabled',
  'pluginsUploadEnabled',
  'requirePluginApproval',
  'accountArchiveEnabled',
  'accountArchivePasswordsEnabled',
  'remoteContentProxyEnabled',
]);
const FEATURE_KEYS = new Set(Object.keys(DEFAULT_FEATURE_GATES).filter((key) => !GLOBAL_ONLY_FEATURES.has(key)));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSafeKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

function cleanList(value: unknown, re: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const v = item.trim().toLowerCase().replace(/\.+$/, '');
    if (re.test(v)) out.add(v);
  }
  return [...out];
}

function sanitizeRestriction(raw: unknown): SettingRestriction | null {
  if (!isRecord(raw)) return null;
  const out: SettingRestriction = {};
  if (typeof raw.locked === 'boolean') out.locked = raw.locked;
  if (typeof raw.hidden === 'boolean') out.hidden = raw.hidden;
  if ('value' in raw) out.value = raw.value;
  if (Array.isArray(raw.allowedValues)) out.allowedValues = raw.allowedValues.slice(0, 100);
  if (typeof raw.min === 'number' && Number.isFinite(raw.min)) out.min = raw.min;
  if (typeof raw.max === 'number' && Number.isFinite(raw.max)) out.max = raw.max;
  return out;
}

export function sanitizeRestrictions(raw: unknown): Record<string, SettingRestriction> {
  if (!isRecord(raw)) return {};
  const out: Record<string, SettingRestriction> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isSafeKey(key)) continue;
    const restriction = sanitizeRestriction(value);
    if (restriction) out[key] = restriction;
  }
  return out;
}

function sanitizeFeatures(raw: unknown): Partial<FeatureGates> {
  if (!isRecord(raw)) return {};
  const out: Partial<FeatureGates> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FEATURE_KEYS.has(key) && typeof value === 'boolean') (out as Record<string, boolean>)[key] = value;
  }
  return out;
}

/** Valid scopes from anything: bad entries are dropped, ids deduplicated, at most MAX_SCOPES. */
export function sanitizeScopes(raw: unknown): PolicyScope[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PolicyScope[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
    if (!SCOPE_ID_RE.test(id) || seen.has(id)) continue;
    const match = isRecord(item.match) ? item.match : {};
    const domains = cleanList(match.domains, DOMAIN_PATTERN_RE);
    const groups = cleanList(match.groups, GROUP_RE);
    seen.add(id);
    const policy = isRecord(item.policy) ? item.policy : {};
    out.push({
      id,
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 100) : id,
      match: { ...(domains.length ? { domains } : {}), ...(groups.length ? { groups } : {}) },
      policy: {
        features: sanitizeFeatures(policy.features),
        restrictions: sanitizeRestrictions(policy.restrictions),
        defaults: sanitizePolicyDefaults(policy.defaults),
        organisation: sanitizeOrganisationPartial(policy.organisation),
        ...(Array.isArray(policy.defaultSidebarApps)
          ? { defaultSidebarApps: sanitizeDefaultSidebarApps(policy.defaultSidebarApps) }
          : {}),
      },
    });
    if (out.length >= MAX_SCOPES) break;
  }
  return out;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '') : '';
}

/** Whether a domain pattern ("example.com" or "*.example.com") covers `domain`. */
export function domainPatternMatches(pattern: string, domain: string): boolean {
  if (!domain) return false;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return domain.endsWith(suffix) && domain.length > suffix.length;
  }
  return pattern === domain;
}

export function scopeMatchesDomain(scope: PolicyScope, domain: string): boolean {
  return (scope.match.domains ?? []).some((pattern) => domainPatternMatches(pattern, domain));
}

export function scopeMatchesGroups(scope: PolicyScope, groups: string[]): boolean {
  const lower = new Set(groups.map((g) => g.trim().toLowerCase()));
  return (scope.match.groups ?? []).some((group) => lower.has(group));
}

/** Matching scope ids in the order they apply: domain matches first, then group matches. */
export function matchingScopes(scopes: PolicyScope[], subject: PolicySubject): PolicyScope[] {
  const domain = domainOf(subject.email);
  const byDomain = scopes.filter((scope) => scopeMatchesDomain(scope, domain));
  const byGroup = scopes.filter((scope) => !byDomain.includes(scope) && scopeMatchesGroups(scope, subject.groups));
  return [...byDomain, ...byGroup];
}

function recordSources(
  sources: Record<string, PolicySource>,
  prefix: string,
  values: Record<string, unknown>,
  source: PolicySource,
  isDefault: (key: string, value: unknown) => boolean,
) {
  for (const [key, value] of Object.entries(values)) {
    const path = `${prefix}.${key}`;
    if (isDefault(key, value) && source === 'global') continue;
    sources[path] = source;
  }
}

function organisationLeaves(value: DeepPartial<OrganisationPolicy>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [section, values] of Object.entries(value)) {
    if (!isRecord(values)) continue;
    for (const [key, leaf] of Object.entries(values)) out[`${section}.${key}`] = leaf;
  }
  return out;
}

function organisationDefaultLeaf(path: string): unknown {
  const [section, key] = path.split('.');
  return (DEFAULT_ORGANISATION_POLICY as unknown as Record<string, Record<string, unknown>>)[section]?.[key];
}

/**
 * The effective policy for `subject`. With no subject (not signed in, or no
 * address known yet) only the global policy applies.
 */
export function resolvePolicy(policy: SettingsPolicy, subject: PolicySubject | null): ResolvedPolicy {
  const scopes = sanitizeScopes(policy.scopes);
  const organisation = sanitizeOrganisationPolicy(policy.organisation);
  const sources: Record<string, PolicySource> = {};
  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  recordSources(sources, 'features', { ...(policy.features ?? {}) }, 'global',
    (key, value) => (DEFAULT_FEATURE_GATES as unknown as Record<string, unknown>)[key] === value);
  recordSources(sources, 'restrictions', policy.restrictions ?? {}, 'global', () => false);
  recordSources(sources, 'defaults', policy.defaults ?? {}, 'global', () => false);
  recordSources(sources, 'organisation', organisationLeaves(organisation), 'global',
    (key, value) => sameJson(organisationDefaultLeaf(key), value));

  const matched = subject ? matchingScopes(scopes, subject) : [];
  let features = { ...DEFAULT_FEATURE_GATES, ...(policy.features ?? {}) };
  let restrictions = { ...(policy.restrictions ?? {}) };
  let defaults = { ...(policy.defaults ?? {}) };
  let org = organisation;
  let sidebarApps = policy.defaultSidebarApps;
  if (sidebarApps?.length) sources.defaultSidebarApps = 'global';
  for (const scope of matched) {
    const o = scope.policy;
    features = { ...features, ...(o.features ?? {}) };
    restrictions = { ...restrictions, ...(o.restrictions ?? {}) };
    defaults = { ...defaults, ...(o.defaults ?? {}) };
    org = mergeOrganisation(org, o.organisation ?? {});
    recordSources(sources, 'features', o.features ?? {}, scope.id, () => false);
    recordSources(sources, 'restrictions', o.restrictions ?? {}, scope.id, () => false);
    recordSources(sources, 'defaults', o.defaults ?? {}, scope.id, () => false);
    recordSources(sources, 'organisation', organisationLeaves(o.organisation ?? {}), scope.id, () => false);
    if (o.defaultSidebarApps) {
      sidebarApps = o.defaultSidebarApps;
      sources.defaultSidebarApps = scope.id;
    }
  }

  const effective: SettingsPolicy = {
    ...policy, features, restrictions, defaults, organisation: org,
    ...(sidebarApps !== undefined ? { defaultSidebarApps: sidebarApps } : {}),
  };
  delete effective.scopes;
  return { policy: effective, matched: matched.map((scope) => scope.id), sources };
}

/**
 * Everyone's default sidebar apps and each scope's own list. The server
 * can't tell whose page it is answering, so the CSP and Permissions-Policy
 * allow the inline apps of all of them.
 */
export function defaultSidebarAppLists(policy: Pick<SettingsPolicy, 'defaultSidebarApps' | 'scopes'>): AdminSidebarApp[][] {
  const lists = [policy.defaultSidebarApps ?? []];
  for (const scope of policy.scopes ?? []) {
    if (Array.isArray(scope?.policy?.defaultSidebarApps)) lists.push(scope.policy.defaultSidebarApps);
  }
  return lists;
}

/**
 * The scopes a browser signed in with these addresses may see: the ones
 * whose domain patterns cover one of their domains, and group scopes with a
 * group address in one of those domains. Keeps one customer's scopes from
 * reaching another customer's users on a shared instance.
 */
export function scopesVisibleTo(scopes: PolicyScope[], emails: string[]): PolicyScope[] {
  const domains = new Set(emails.map(domainOf).filter(Boolean));
  if (domains.size === 0) return [];
  return scopes.filter((scope) =>
    [...domains].some((domain) => scopeMatchesDomain(scope, domain))
    || (scope.match.groups ?? []).some((group) => domains.has(domainOf(group))),
  );
}
