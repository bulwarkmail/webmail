import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';

/**
 * Remembers which app password an impersonation handoff minted, so signing
 * out can revoke it instead of leaving it valid until it expires.
 * Impersonation always lands in slot 0, so one cookie is enough.
 */
export const IMPERSONATION_GRANT_COOKIE = 'jmap_impersonation';

export interface ImpersonationGrant {
  serverUrl: string;
  mailbox: string;
  credentialId: string;
}

export function sealImpersonationGrant(grant: ImpersonationGrant): string {
  return encryptPayload({ ...grant }, 'impersonation-grant');
}

export function openImpersonationGrant(token: string | undefined): ImpersonationGrant | null {
  if (!token) return null;
  const payload = decryptPayload(token, 'impersonation-grant');
  if (!payload) return null;
  const { serverUrl, mailbox, credentialId } = payload;
  if (typeof serverUrl !== 'string' || typeof mailbox !== 'string' || typeof credentialId !== 'string') {
    return null;
  }
  return { serverUrl, mailbox, credentialId };
}
