import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { logger } from '@/lib/logger';

const JMAP_TIMEOUT_MS = 10_000;

async function postJmap<T>(serverUrl: string, authHeader: string, body: unknown): Promise<T | null> {
  const response = await fetchWithTimeout(`${serverUrl}/jmap/`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) return null;
  return await response.json() as T;
}

async function fetchWithTimeout(url: string, init: Parameters<typeof fetch>[1]): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JMAP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/admin/system-admin
 *
 * Returns whether the currently authenticated Stalwart-backed admin session
 * belongs to a system admin (not tenant/domain-scoped admin).
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;

    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json({ isSystemAdmin: false }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const sessionRes = await fetchWithTimeout(`${creds.serverUrl}/.well-known/jmap`, {
      method: 'GET',
      headers: { Authorization: creds.authHeader },
    });
    if (!sessionRes.ok) {
      return NextResponse.json({ isSystemAdmin: false }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const session = await sessionRes.json() as {
      primaryAccounts?: Record<string, string>;
    };
    const accountId = session.primaryAccounts?.['urn:stalwart:jmap']
      ?? session.primaryAccounts?.['urn:ietf:params:jmap:mail']
      ?? (session.primaryAccounts ? Object.values(session.primaryAccounts)[0] : undefined);

    if (!accountId) {
      return NextResponse.json({ isSystemAdmin: false }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const data = await postJmap<{
      methodResponses?: Array<[string, {
        list?: Array<{
          domainId?: string | null;
          roles?: {
            ['@type']?: string;
            roleIds?: Record<string, boolean>;
          } | null;
        }>;
      }, string]>;
    }>(creds.serverUrl, creds.authHeader, {
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
      methodCalls: [['x:Account/get', { accountId, ids: [accountId] }, '0']],
    });

    if (!data) {
      return NextResponse.json({ isSystemAdmin: false }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const first = data.methodResponses?.[0];
    const account = first && first[0] === 'x:Account/get' ? first[1]?.list?.[0] : undefined;
    const roleType = String(account?.roles?.['@type'] ?? '').toLowerCase();
    const hasDomainScope = typeof account?.domainId === 'string' && account.domainId.length > 0;

    // In this deployment, true system admins return `roles.@type = Admin`
    // even though `domainId` can still be populated.
    const isSystemRole = roleType === 'admin';
    const isTenantRole = roleType.includes('tenant');

    let customRoleIsSystemAdmin = false;
    if (roleType === 'custom') {
      const roleIds = Object.keys(account?.roles?.roleIds ?? {});
      if (roleIds.length > 0) {
        const roleData = await postJmap<{
          methodResponses?: Array<[string, {
            list?: Array<{
              name?: string | null;
              description?: string | null;
            }>;
          }, string]>;
        }>(creds.serverUrl, creds.authHeader, {
          using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
          methodCalls: [['x:Role/get', { accountId, ids: roleIds }, '0']],
        });

        const roleList = roleData?.methodResponses?.[0]?.[0] === 'x:Role/get'
          ? roleData.methodResponses[0][1]?.list ?? []
          : [];

        customRoleIsSystemAdmin = roleList.some((role) => {
          const roleName = String(role.name ?? '').toLowerCase();
          const roleDescription = String(role.description ?? '').toLowerCase();
          return roleName.includes('system administrator') || roleDescription.includes('system administrator');
        });
      }
    }

    const isSystemAdmin = isSystemRole || customRoleIsSystemAdmin || (!hasDomainScope && !isTenantRole);

    return NextResponse.json({ isSystemAdmin }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    logger.error('System admin check failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ isSystemAdmin: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
}
