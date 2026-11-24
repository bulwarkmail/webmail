import type { Identity } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { saveIdentityChanges, useIdentityStore } from '@/stores/identity-store';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';

/**
 * Signatures shared between addresses (#1190): an address can use another
 * address's signature instead of a copy that drifts. Every address still
 * keeps its signature on its identity on the server, so the composer, the
 * app and other clients send it as before; the webmail writes the source's
 * signature to the addresses that use it whenever it is saved.
 *
 * The links are kept in the settings per login (AccountEntry.id), since
 * identity ids are per server: login -> identity id -> source identity id.
 * A source never uses another's signature itself, so there are no chains.
 */
export type SignatureSources = Record<string, Record<string, string>>;

function linksOf(map: SignatureSources | undefined, loginId: string | null | undefined): Record<string, string> {
  if (!map || !loginId) return {};
  const links = map[loginId];
  return links && typeof links === 'object' && !Array.isArray(links) ? links : {};
}

/** The address whose signature this one uses, or null for its own. */
export function signatureSourceOf(
  map: SignatureSources | undefined,
  loginId: string | null | undefined,
  identityId: string,
  identities: readonly Identity[],
): Identity | null {
  const sourceId = linksOf(map, loginId)[identityId];
  if (typeof sourceId !== 'string' || sourceId === identityId) return null;
  return identities.find((i) => i.id === sourceId) ?? null;
}

/** The addresses that use this one's signature. */
export function identitiesUsingSignatureOf(
  map: SignatureSources | undefined,
  loginId: string | null | undefined,
  sourceId: string,
  identities: readonly Identity[],
): Identity[] {
  const links = linksOf(map, loginId);
  return identities.filter((i) => i.id !== sourceId && links[i.id] === sourceId);
}

/**
 * The map with one address using another's signature, or its own again
 * (sourceId null). The addresses that used this one's signature move on to
 * the new source with it, so no link points at an address that has one.
 */
export function setSignatureSource(
  map: SignatureSources,
  loginId: string,
  identityId: string,
  sourceId: string | null,
): SignatureSources {
  const links = { ...linksOf(map, loginId) };
  if (sourceId && sourceId !== identityId) {
    const root = typeof links[sourceId] === 'string' ? links[sourceId] : sourceId;
    if (root === identityId) {
      delete links[sourceId];
      links[identityId] = sourceId;
    } else {
      links[identityId] = root;
    }
    for (const [id, from] of Object.entries(links)) {
      if (from === identityId) links[id] = links[identityId];
    }
  } else {
    delete links[identityId];
  }
  const next = { ...map };
  if (Object.keys(links).length > 0) next[loginId] = links;
  else delete next[loginId];
  return next;
}

export interface SignatureFields {
  htmlSignature: string | null;
  textSignature: string | null;
}

/** The signature of an address, as JMAP clears a field (null). */
export function signatureFieldsOf(identity: { htmlSignature?: string | null; textSignature?: string | null }): SignatureFields {
  return {
    htmlSignature: identity.htmlSignature?.trim() ? identity.htmlSignature : null,
    textSignature: identity.textSignature?.trim() ? identity.textSignature : null,
  };
}

/** Writes a just-saved signature to the addresses of the active login that use it. */
export async function copySignatureToUsers(client: IJMAPClient, source: Identity, signature: SignatureFields): Promise<void> {
  const loginId = useAccountStore.getState().activeAccountId;
  const { signatureSources } = useSettingsStore.getState();
  const users = identitiesUsingSignatureOf(signatureSources, loginId, source.id, useIdentityStore.getState().identities);
  for (const user of users) {
    await saveIdentityChanges(client, user, signature);
  }
}
