/**
 * Company calendars on the server (organisation.calendars.feeds).
 *
 * A feed address may carry a token, so full Bulwark never hands it to the
 * browser: the policy users get has every feed's `url` emptied
 * (stripFeedUrls), and /api/fetch-ical fetches a feed by id from the
 * caller's own scoped policy (feedForSubject). Lite has no server: there the
 * address is in the public policy.json, which the admin docs say.
 */

import type { SettingsPolicy } from './types';
import type { CompanyFeed } from './organisation-policy';
import { resolvePolicy, type PolicySubject } from './policy-scopes';
import { isIntranetHostName } from '@/lib/security/url-guard';

function withoutUrls(organisation: unknown): unknown {
  if (!organisation || typeof organisation !== 'object') return organisation;
  const org = organisation as Record<string, unknown>;
  const calendars = org.calendars as Record<string, unknown> | undefined;
  if (!calendars || !Array.isArray(calendars.feeds)) return organisation;
  return {
    ...org,
    calendars: {
      ...calendars,
      feeds: calendars.feeds.map((feed) => (feed && typeof feed === 'object' ? { ...(feed as Record<string, unknown>), url: '', urlHeld: true } : feed)),
    },
  };
}

/** The policy as users get it: every company calendar's address emptied, in Everyone and in every scope. */
export function stripFeedUrls(policy: SettingsPolicy): SettingsPolicy {
  return {
    ...policy,
    ...(policy.organisation ? { organisation: withoutUrls(policy.organisation) as SettingsPolicy['organisation'] } : {}),
    ...(policy.scopes
      ? {
          scopes: policy.scopes.map((scope) => (scope.policy?.organisation
            ? { ...scope, policy: { ...scope.policy, organisation: withoutUrls(scope.policy.organisation) as typeof scope.policy.organisation } }
            : scope)),
        }
      : {}),
  };
}

/** The feed `feedId` as it applies to `subject` (their domain and group scopes), or null when it doesn't. */
export function feedForSubject(policy: SettingsPolicy, subject: PolicySubject, feedId: string): CompanyFeed | null {
  const feeds = resolvePolicy(policy, subject).policy.organisation?.calendars?.feeds ?? [];
  const feed = feeds.find((f) => f.id === feedId);
  return feed && feed.url ? feed : null;
}

/** Every feed of every scope, for the outgoing-hosts list. */
export function allFeeds(policy: Pick<SettingsPolicy, 'organisation' | 'scopes'>): CompanyFeed[] {
  const lists = [policy.organisation, ...(policy.scopes ?? []).map((scope) => scope.policy?.organisation)]
    .map((org) => (org as { calendars?: { feeds?: unknown } } | undefined)?.calendars?.feeds);
  return lists.flatMap((feeds) => (Array.isArray(feeds) ? feeds.filter((f): f is CompanyFeed => !!f && typeof f === 'object' && typeof (f as CompanyFeed).url === 'string') : []));
}

/**
 * The feed's host when it names the intranet (an intranet address, a
 * .local/.internal/.localdomain name or a single-label name): the only kind
 * of host a feed fetch may reach on a private address. Null for public
 * names, so a public host whose DNS is later pointed inside reaches nothing.
 */
export function intranetFeedHost(feed: Pick<CompanyFeed, 'url'>): string | null {
  try {
    const host = new URL(feed.url).hostname.toLowerCase();
    return isIntranetHostName(host) ? host : null;
  } catch {
    return null;
  }
}
