import { NextRequest, NextResponse } from 'next/server';
import { completePolicy, configManager, isPolicyConflict } from '@/lib/admin/config-manager';
import { cookies } from 'next/headers';
import { requireAdminAuth, getClientIP, verifyCurrentAdminSession } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { ADMIN_SESSION_COOKIE, POLICY_DOMAINS_HEADER, POLICY_SCOPE_HEADER, type SettingsPolicy } from '@/lib/admin/types';
import { canSeeInstanceDetails, signedInIdentity } from '@/lib/auth/instance-details';
import { bearerIdentity } from '@/lib/auth/bearer-identity';
import { isStoreUnavailable, storeUnavailableResponse } from '@/lib/auth/store-unavailable';
import { scopesVisibleTo } from '@/lib/admin/policy-scopes';
import { configReadOnlyResponse } from '@/lib/admin/config-read-only-response';
import { stripFeedUrls } from '@/lib/admin/company-feeds';

/** The policy version as an HTTP entity tag. */
function policyETag(version: string): string {
  return `"${version}"`;
}

/**
 * The version an If-Match header names, or undefined for none (or `*`).
 * The admin pages send the ETag of the policy they loaded.
 */
function ifMatchVersion(request: NextRequest): string | undefined {
  const raw = request.headers.get('if-match')?.trim();
  if (!raw || raw === '*') return undefined;
  return raw.split(',')[0].trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

/**
 * GET /api/admin/policy - Get settings policy (NOT admin-protected - users read this;
 * visitors who are not signed in get the subset the login page needs)
 *
 * Clients without a webmail session (the mobile app) sign in with
 * `Authorization: Bearer <JMAP access token>` for the configured mail server
 * and get what a signed-in user of that account gets here
 * (lib/auth/bearer-identity.ts). A token that doesn't check out gets the
 * public subset, as without one.
 */
export async function GET(request: NextRequest) {
  try {
    await configManager.ensureLoaded();
    // Together: the identity checks below wait on the store, and a change
    // applied meanwhile must not pair this policy with a newer version.
    const { policy, version } = configManager.getPolicyWithVersion();
    if (!(await canSeeInstanceDetails(request))) {
      const tokenIdentity = await bearerIdentity(request);
      if (tokenIdentity) return userPolicyResponse(policy, tokenIdentity.addresses);
      // The login page needs the theme policy and gates; the plugin lists,
      // push relays and sidebar app URLs map the deployment and are only
      // used after signing in, when the client fetches the policy again.
      return NextResponse.json(
        {
          ...policy,
          forceEnabledPlugins: [],
          approvedPlugins: [],
          pushRelays: [],
          pushRelayUrl: '',
          pushRelayUrlLocked: false,
          defaultSidebarApps: [],
          // Signatures, domain lists and scopes describe the organisation
          // and only apply once someone is signed in.
          organisation: undefined,
          scopes: [],
        },
        { headers: { 'Cache-Control': 'no-store', [POLICY_SCOPE_HEADER]: 'public' } },
      );
    }
    // Users get only the scopes for their own domains, so on an instance
    // shared by several organisations one doesn't see another's settings.
    // Without a session secret the server can't tell who is asking and
    // answers with all of them (documented).
    const identity = await signedInIdentity();
    if (identity !== null && !identity.admin) return userPolicyResponse(policy, identity.addresses);
    // Without a session secret only the admin dashboard's own session tells
    // the admin apart; everyone else gets the feeds without their addresses,
    // which may hold tokens.
    if (identity === null && !(await hasAdminSession())) {
      return NextResponse.json({ ...stripFeedUrls(policy), scopes: stripFeedUrls(policy).scopes ?? [] }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    // The whole policy, as the admin pages edit it: with its version, which
    // they send back as If-Match when they save.
    return NextResponse.json({ ...policy, scopes: policy.scopes ?? [] }, {
      headers: { 'Cache-Control': 'no-store', ETag: policyETag(version) },
    });
  } catch (error) {
    // A Bearer token can't be checked without the shared store (its budget).
    if (isStoreUnavailable(error)) return storeUnavailableResponse();
    logger.error('Policy read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function hasAdminSession(): Promise<boolean> {
  try {
    const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
    return !!token && (await verifyCurrentAdminSession(token)) !== null;
  } catch {
    return false;
  }
}

/**
 * The policy for a signed-in user who is not the admin, with the addresses
 * they sign in with. Company calendar addresses stay here: the browser
 * fetches a feed by id through /api/fetch-ical (lib/admin/company-feeds.ts).
 */
function userPolicyResponse(raw: SettingsPolicy, addresses: string[]): NextResponse {
  const policy = stripFeedUrls(raw);
  const scopes = scopesVisibleTo(policy.scopes ?? [], addresses);
  // Which domains the scopes were picked for, so a browser that signs in
  // to an account of another domain knows to fetch again.
  const domains = [...new Set(addresses.filter((a) => a.includes('@')).map((a) => a.slice(a.lastIndexOf('@') + 1)).filter(Boolean))].join(',');
  return NextResponse.json({ ...policy, scopes }, {
    headers: { 'Cache-Control': 'no-store', [POLICY_DOMAINS_HEADER]: domains },
  });
}

/**
 * PUT /api/admin/policy - Update settings policy (admin-protected)
 *
 * With `If-Match: <ETag from GET>` the save is refused with 409 when the
 * policy changed since it was read, so a page opened earlier can't undo
 * someone else's save. Without it the policy is replaced, as it always was.
 */
export async function PUT(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const policy = await request.json() as SettingsPolicy;

    if (!policy || typeof policy !== 'object') {
      return NextResponse.json({ error: 'Invalid policy object' }, { status: 400 });
    }

    // Basic validation
    if (policy.restrictions && typeof policy.restrictions !== 'object') {
      return NextResponse.json({ error: 'restrictions must be an object' }, { status: 400 });
    }
    if (policy.features && typeof policy.features !== 'object') {
      return NextResponse.json({ error: 'features must be an object' }, { status: 400 });
    }
    if (policy.defaults !== undefined && (typeof policy.defaults !== 'object' || policy.defaults === null || Array.isArray(policy.defaults))) {
      return NextResponse.json({ error: 'defaults must be an object' }, { status: 400 });
    }
    if (policy.themePolicy && typeof policy.themePolicy !== 'object') {
      return NextResponse.json({ error: 'themePolicy must be an object' }, { status: 400 });
    }
    if (policy.defaultSidebarApps !== undefined && !Array.isArray(policy.defaultSidebarApps)) {
      return NextResponse.json({ error: 'defaultSidebarApps must be an array' }, { status: 400 });
    }
    if (policy.scopes !== undefined && !Array.isArray(policy.scopes)) {
      return NextResponse.json({ error: 'scopes must be an array' }, { status: 400 });
    }
    if (policy.organisation !== undefined && (typeof policy.organisation !== 'object' || policy.organisation === null || Array.isArray(policy.organisation))) {
      return NextResponse.json({ error: 'organisation must be an object' }, { status: 400 });
    }

    let version: string;
    try {
      version = await configManager.setPolicy(policy, { ifVersion: ifMatchVersion(request) });
    } catch (error) {
      if (isPolicyConflict(error)) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
    await auditLog('policy.update', {
      restrictionCount: Object.keys(policy.restrictions || {}).length,
      // Entries the sanitizer dropped never reach users, so log what stuck.
      defaultSidebarAppCount: configManager.getPolicy().defaultSidebarApps?.length ?? 0,
    }, ip);

    // What was stored, with its version: the page continues from this
    // instead of reading it back from a replica that may not have it yet.
    const saved = completePolicy(policy);
    return NextResponse.json({ ok: true, policy: { ...saved, scopes: saved.scopes ?? [] } }, { headers: { ETag: policyETag(version) } });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    logger.error('Policy update error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
