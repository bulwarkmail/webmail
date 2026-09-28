import type { cookies } from 'next/headers';
import { encryptPayload, decryptPayload } from '@/lib/auth/crypto';
import { getCookieOptions } from '@/lib/oauth/cookie-config';
import { discardGrant } from '@/lib/auth/pairing-store';

// Step-up proof for device pairing. Linking a phone provisions a new
// long-lived login, so the desktop must prove who it is again first: the
// current password (and TOTP) or a fresh IdP login. The step-up mints the
// phone's own grant (see pairing-store); this short-lived, encrypted,
// httpOnly cookie remembers which grant, and for which signed-in account, so
// the desktop can show a new QR within the window without asking again.

type CookieStore = Awaited<ReturnType<typeof cookies>>;

const PAIR_REAUTH_COOKIE = 'pair_reauth';
const PAIR_REAUTH_TTL_MS = 5 * 60 * 1000; // matches the grant's lifetime

export interface PairReauthProof {
  grantId: string;
  owner: string;
}

/** The account a step-up is valid for: the cookie slot and its verified user. */
export function pairingOwner(slot: number, username: string): string {
  return `${slot}:${username.trim().toLowerCase()}`;
}

export function setPairReauthInStore(cookieStore: CookieStore, proof: PairReauthProof): void {
  // A new step-up replaces the previous grant; its QR must stop working.
  const previous = readPairReauthFromStore(cookieStore);
  if (previous && previous.grantId !== proof.grantId) discardGrant(previous.grantId);
  const value = encryptPayload(
    { purpose: 'pair', created_at: Date.now(), grant_id: proof.grantId, owner: proof.owner },
    'pair-reauth',
  );
  cookieStore.set(PAIR_REAUTH_COOKIE, value, {
    ...getCookieOptions(),
    maxAge: Math.floor(PAIR_REAUTH_TTL_MS / 1000),
  });
}

/**
 * The live proof, or null. A proof from before grants existed (no grant id)
 * fails closed, so the user is simply asked to confirm again.
 */
export function readPairReauthFromStore(cookieStore: CookieStore): PairReauthProof | null {
  const raw = cookieStore.get(PAIR_REAUTH_COOKIE)?.value;
  if (!raw) return null;
  const data = decryptPayload(raw, 'pair-reauth');
  if (!data || data.purpose !== 'pair') return null;
  const createdAt = typeof data.created_at === 'number' ? data.created_at : 0;
  // Belt-and-suspenders alongside the cookie maxAge: an old proof whose
  // timestamp is outside the window is rejected even if the cookie survived.
  if (Date.now() - createdAt > PAIR_REAUTH_TTL_MS) return null;
  if (typeof data.grant_id !== 'string' || typeof data.owner !== 'string') return null;
  return { grantId: data.grant_id, owner: data.owner };
}

/**
 * Sign-out: forget the proof and kill its grant, so a QR left on screen dies.
 * With `slot`, only when the proof belongs to that account.
 */
export function clearPairReauthInStore(cookieStore: CookieStore, slot?: number): void {
  const raw = cookieStore.get(PAIR_REAUTH_COOKIE)?.value;
  if (!raw) return;
  const proof = readPairReauthFromStore(cookieStore);
  if (slot !== undefined && proof && !proof.owner.startsWith(`${slot}:`)) return;
  if (proof) discardGrant(proof.grantId);
  cookieStore.delete(PAIR_REAUTH_COOKIE);
}
