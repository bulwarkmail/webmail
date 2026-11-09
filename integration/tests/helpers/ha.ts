/**
 * Helpers for the multi-instance specs (21-ha-*.spec.ts, #1066). They run
 * against the three-replica rig on VM 106 (/opt/stw-test/bulwark-ha) through
 * an SSH tunnel: the load balancer on localhost:3130 and the replicas on
 * 3131-3133, so "write on one replica, read on another" is deterministic.
 * Only the throwaway ha-* accounts are used, and no account is ever reset.
 *
 * Env (set by the rig's run-ha-spec.sh):
 *   IT_HA_LB, IT_HA_REPLICAS   load balancer and replica origins
 *   IT_HA_SINGLE, IT_HA_MIGRATE   the one-instance and import containers
 *   IT_HA_PASSWORD             password of the ha-* accounts
 *   IT_ADMIN_PASSWORD          the rig's admin password
 *   IT_HA_JWT_SECRET           the rig's BULWARK_JWT_AUTH_SECRET (impersonation replay)
 *   IT_JMAP_URL                the Stalwart the rig points at
 *   IT_HA_SSH                  ssh host of the rig (default stw-test)
 *   IT_HA_IMAGE                image the lifecycle specs start (default bulwark-local:ha)
 */
import { request as pwRequest, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { JMAP_URL } from './config';

export const HA = {
  lb: process.env.IT_HA_LB ?? 'http://localhost:3130',
  replicas: (process.env.IT_HA_REPLICAS ?? 'http://localhost:3131,http://localhost:3132,http://localhost:3133').split(','),
  single: process.env.IT_HA_SINGLE ?? 'http://localhost:3134',
  migrate: process.env.IT_HA_MIGRATE ?? 'http://localhost:3135',
  password: process.env.IT_HA_PASSWORD ?? '',
  adminPassword: process.env.IT_ADMIN_PASSWORD ?? '',
  jwtSecret: process.env.IT_HA_JWT_SECRET ?? '',
  jmap: JMAP_URL.replace(/\/+$/, ''),
  ssh: process.env.IT_HA_SSH ?? 'stw-test',
  image: process.env.IT_HA_IMAGE ?? 'bulwark-local:ha',
  server: process.env.IT_HA_SERVER ?? '1.0',
};

export const [A, B, C] = HA.replicas;

export const HA_USERS = {
  alice: 'ha-alice@example.org',
  bob: 'ha-bob@example.org',
  carol: 'ha-carol@example.org',
  dave: 'ha-dave@example.org',
} as const;

/** How long the plan promises an admin change takes to reach every replica. */
export const SPREAD_MS = 5000;

export function requireHaEnv(): void {
  if (!HA.password || !HA.adminPassword) {
    throw new Error('Set IT_HA_PASSWORD and IT_ADMIN_PASSWORD (run-ha-spec.sh does) to run the ha specs');
  }
}

/** A client address of its own (X-Forwarded-For, honoured by a replica reached directly), so limits don't collide between runs. */
export function testIp(): string {
  const b = randomBytes(3);
  return `10.${b[0]}.${b[1]}.${(b[2] % 250) + 2}`;
}

export function uniq(prefix = 'ha'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

// ─── the VM ────────────────────────────────────────────────────────────────

/** Run a command on the rig's VM. Never echo secrets through this. */
export function vm(command: string, timeoutMs = 180_000): string {
  return execFileSync('ssh', [HA.ssh, command], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** docker compose in the rig's folder, with the image under test. */
export function compose(args: string, opts: { image?: string; env?: Record<string, string> } = {}): string {
  // The server the rig points at follows IT_JMAP_URL, so a restart keeps it.
  const server = { HA_JMAP_URL: HA.jmap, HA_STALWART_VERSION: HA.server === '0.16' ? '0.16' : '1.0' };
  const env = Object.entries({ HA_IMAGE: opts.image ?? HA.image, ...server, ...(opts.env ?? {}) })
    .map(([k, v]) => `${k}=${v}`).join(' ');
  return vm(`cd /opt/stw-test/bulwark-ha && ${env} docker compose ${args} 2>&1`);
}

/** A Valkey command inside the rig's store container (its password stays in the container's env). */
export function valkey(args: string): string {
  return vm(`docker exec ha-valkey sh -c 'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli --no-auth-warning ${args}'`).trim();
}

// ─── waiting ───────────────────────────────────────────────────────────────

/**
 * Poll `fn` until it returns a truthy value (exceptions count as "not yet").
 * Resolves with the value and how long it took.
 */
export async function eventually<T>(fn: () => Promise<T>, timeoutMs: number, intervalMs = 200): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return { value, ms: Date.now() - start };
      last = value;
    } catch (error) {
      last = error;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Not within ${timeoutMs} ms; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Wait until every origin answers ready (or, for a build without /api/ready, healthy). */
export async function waitReady(origins: string[], timeoutMs = 180_000): Promise<void> {
  await Promise.all(origins.map((origin) => eventually(async () => {
    const res = await fetch(`${origin}/api/ready`).catch(() => null);
    if (res?.status === 404) return (await fetch(`${origin}/api/health`)).ok;
    return res?.status === 200;
  }, timeoutMs, 1000)));
}

// ─── HTTP clients ──────────────────────────────────────────────────────────

/**
 * An API client. Cookies are per host, not per port, so one client signed in
 * on one replica sends the same cookies to the others: that is the browser
 * behind a load balancer.
 */
export async function client(baseURL = A, ip?: string): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL,
    extraHTTPHeaders: ip ? { 'X-Forwarded-For': ip } : {},
  });
}

/** Sign a user in (the "remember me" session plus the Stalwart context cookie) through one replica. */
export async function signIn(ctx: APIRequestContext, email: string, origin = A): Promise<void> {
  const res = await ctx.post(`${origin}/api/auth/session`, {
    data: { serverUrl: HA.jmap, username: email, password: HA.password },
  });
  expect(res.status(), `sign-in ${email} via ${origin}: ${await res.text()}`).toBe(200);
}

const stateDir = path.join(tmpdir(), 'bulwark-ha-it');

/**
 * An admin client. The admin login is limited to 5 attempts (successes too)
 * per address per 15 minutes, now across every replica, so one session is
 * stored and reused; a fresh login uses an address of its own.
 */
export async function adminClient(origin = A): Promise<APIRequestContext> {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, `admin-${HA.server}.json`);
  if (existsSync(statePath)) {
    const ctx = await pwRequest.newContext({ baseURL: origin, storageState: statePath });
    const res = await ctx.get('/api/admin/auth').catch(() => null);
    if (res?.ok() && (await res.json().catch(() => ({})))?.authenticated === true) return ctx;
    await ctx.dispose();
  }
  const ctx = await pwRequest.newContext({ baseURL: origin, extraHTTPHeaders: { 'X-Forwarded-For': testIp() } });
  const res = await ctx.post('/api/admin/auth', { data: { password: HA.adminPassword } });
  expect(res.status(), `admin sign-in via ${origin}: ${await res.text()}`).toBe(200);
  await ctx.storageState({ path: statePath });
  await ctx.dispose();
  return pwRequest.newContext({ baseURL: origin, storageState: statePath });
}

/** Forget the stored admin session (after the store was wiped, its revocation list is gone too). */
export function forgetAdminSession(): void {
  const statePath = path.join(stateDir, `admin-${HA.server}.json`);
  if (existsSync(statePath)) execFileSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'del', statePath] : ['-f', statePath]);
}

export async function json<T = Record<string, unknown>>(res: APIResponse): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Not JSON (${res.status()}): ${text.slice(0, 200)}`);
  }
}

// ─── fixtures ──────────────────────────────────────────────────────────────

/** The smallest plugin the upload accepts, with an optional user credential. */
export async function pluginZip(id: string, opts: { credentials?: string[]; code?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  const manifest: Record<string, unknown> = {
    id,
    name: `HA test ${id}`,
    version: '1.0.0',
    author: 'ha rig',
    type: 'hook',
    description: 'Throwaway plugin of the multi-instance rig',
  };
  if (opts.credentials?.length) {
    manifest.credentials = Object.fromEntries(opts.credentials.map((c) => [c, { label: `Rig service ${c}`, scope: 'user', inject: { type: 'bearer' } }]));
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('index.js', opts.code ?? `export function activate() { return ${JSON.stringify(id)}; }\n`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A 1x1 PNG with random bytes after IEND, so two uploads differ (decoders ignore trailing bytes). */
export function tinyPng(): Buffer {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  return Buffer.concat([png, randomBytes(8)]);
}

/** An HS256 impersonation token as the platform API would mint it. */
export function impersonationToken(mailbox: string, jti = randomUUID()): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({ iss: 'platform-api/webmail', iat: now, exp: now + 120, jti, mailbox });
  const sig = createHmac('sha256', HA.jwtSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** PKCE pair for the mobile hand-off. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function template(name: string): Record<string, unknown> {
  return {
    id: uniq('tpl'),
    name,
    subject: `${name} subject`,
    body: `${name} body`,
    category: 'general',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
