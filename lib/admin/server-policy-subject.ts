/**
 * Who a request is for the domain and group scopes, worked out on the
 * server from the caller's own JMAP session: the account's address and the
 * group accounts in its session, as policySubjectForClient
 * (lib/admin/policy-subject.ts) does in the browser. Used where the server
 * must apply a group scope itself (company calendars by feed id), so a
 * browser can't claim a group it isn't in.
 */

import { createHash } from 'node:crypto';
import type { PolicySubject } from './policy-scopes';
import type { StalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapSession, postJmap, rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import { UPSTREAM_JSON_MAX_BYTES, readJsonCapped } from '@/lib/security/capped-body';

const TTL_MS = 5 * 60 * 1000;
const PRINCIPALS = 'urn:ietf:params:jmap:principals';
const MAIL = 'urn:ietf:params:jmap:mail';

type Creds = Pick<StalwartCredentials, 'serverUrl' | 'authHeader' | 'accountName' | 'username' | 'trusted'>;

interface SessionAccount {
  name?: string;
  isPersonal?: boolean;
}

// One cache per process, not per bundle copy.
const CACHE_KEY = Symbol.for('bulwark.serverPolicySubjects');
function cache(): Map<string, { at: number; subject: Promise<PolicySubject> }> {
  const g = globalThis as typeof globalThis & { [CACHE_KEY]?: Map<string, { at: number; subject: Promise<PolicySubject> }> };
  g[CACHE_KEY] ??= new Map();
  return g[CACHE_KEY];
}

async function resolve(creds: Creds): Promise<PolicySubject> {
  const email = (creds.accountName || creds.username).trim().toLowerCase();
  const session = await fetchJmapSession(creds.serverUrl, creds.authHeader, { trusted: creds.trusted });
  if (!session?.accounts) return { email, groups: [] };
  const primary = session.primaryAccounts?.[MAIL] ?? '';
  const shared = Object.entries(session.accounts as Record<string, SessionAccount>)
    .filter(([id, account]) => id !== primary && account?.isPersonal === false && typeof account.name === 'string' && account.name.includes('@'));
  if (shared.length === 0) return { email, groups: [] };

  // A mailbox another person shared is non-personal too: the principal type
  // tells groups apart. When the server won't say, every non-personal
  // account counts, as in the browser.
  let types: Record<string, string> | null = null;
  const apiUrl = rebaseApiUrl(session, creds.serverUrl);
  if (apiUrl && primary) {
    try {
      const response = await postJmap(apiUrl, creds.authHeader, JSON.stringify({
        using: ['urn:ietf:params:jmap:core', PRINCIPALS],
        methodCalls: [['Principal/get', { accountId: primary, ids: shared.map(([id]) => id), properties: ['id', 'type'] }, '0']],
      }), { trusted: creds.trusted });
      if (response.ok) {
        const body = await readJsonCapped<{ methodResponses?: [string, { list?: Array<{ id?: string; type?: string }> }, string][] }>(response, UPSTREAM_JSON_MAX_BYTES);
        const [method, result] = body?.methodResponses?.[0] ?? [];
        if (method === 'Principal/get') {
          types = {};
          for (const p of result?.list ?? []) if (p.id && p.type) types[p.id] = p.type;
        }
      }
    } catch {
      types = null;
    }
  }
  const groups = shared
    .filter(([id]) => !types || types[id] === 'group')
    .map(([, account]) => account.name!.trim().toLowerCase())
    .sort();
  return { email, groups };
}

/** The caller's subject, kept for a few minutes per credential. Never rejects. */
export function serverPolicySubject(creds: Creds): Promise<PolicySubject> {
  const key = createHash('sha256').update(`${creds.serverUrl}\n${creds.authHeader}`).digest('hex');
  const entries = cache();
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.subject;
  const email = (creds.accountName || creds.username).trim().toLowerCase();
  const subject = resolve(creds).catch((): PolicySubject => ({ email, groups: [] }));
  entries.set(key, { at: now, subject });
  if (entries.size > 1000) {
    for (const [k, v] of entries) if (now - v.at >= TTL_MS) entries.delete(k);
  }
  return subject;
}

/** For tests. */
export function clearServerPolicySubjects(): void {
  cache().clear();
}
