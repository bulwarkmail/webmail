import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StateChange } from './types';
import type { SubscriptionRecord } from './types';

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

let cachedAccount: ServiceAccount | null = null;
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

async function loadServiceAccount(): Promise<ServiceAccount> {
  if (cachedAccount) return cachedAccount;

  const inline = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (inline && inline.trim().startsWith('{')) {
    cachedAccount = JSON.parse(inline) as ServiceAccount;
    return cachedAccount;
  }

  const filePath = inline && inline.trim().length > 0
    ? inline
    : path.join(process.env.PUSH_DATA_DIR ?? './data/push', 'fcm-service-account.json');
  const raw = await fs.readFile(filePath, 'utf8');
  cachedAccount = JSON.parse(raw) as ServiceAccount;
  return cachedAccount;
}

function base64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt - 60_000 > now) {
    return cachedAccessToken.token;
  }

  const account = await loadServiceAccount();
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT', kid: account.private_key_id };
  const claim = {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: account.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat,
    exp,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(account.private_key);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(account.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`FCM oauth2 token failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = {
    token: body.access_token,
    expiresAt: now + body.expires_in * 1000,
  };
  return body.access_token;
}

export interface FcmSendResult {
  ok: boolean;
  status: number;
  unregistered: boolean;
  body?: unknown;
}

/**
 * Send a data message via FCM HTTP v1. Returns `unregistered: true` if the
 * token was rejected with UNREGISTERED / NOT_FOUND — callers should delete
 * the subscription in that case.
 */
export async function sendFcmPush(
  record: SubscriptionRecord,
  change: StateChange,
): Promise<FcmSendResult> {
  const account = await loadServiceAccount();
  const accessToken = await mintAccessToken();
  const hasEmail = Boolean(change.changed && Object.values(change.changed).some((types) => 'Email' in types));

  const title = hasEmail ? 'New mail' : 'Mailbox updated';
  const body = record.accountLabel ?? 'Tap to open Bulwark';

  const message = {
    message: {
      token: record.fcmToken,
      android: {
        priority: 'HIGH',
        notification: {
          title,
          body,
          channel_id: 'bulwark_mail',
          default_sound: true,
        },
      },
      data: {
        kind: 'jmap-state-change',
        changed: JSON.stringify(change.changed ?? {}),
      },
    },
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
    },
  );

  const rawBody = await res.text();
  let parsed: unknown = rawBody;
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    // keep raw text
  }

  const errStatus =
    typeof parsed === 'object' && parsed && 'error' in parsed
      ? ((parsed as { error?: { status?: string } }).error?.status ?? '')
      : '';
  const unregistered = res.status === 404 || errStatus === 'UNREGISTERED' || errStatus === 'NOT_FOUND';

  return {
    ok: res.ok,
    status: res.status,
    unregistered,
    body: parsed,
  };
}
