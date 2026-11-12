/**
 * One principal listing per client, shared by everything that needs the
 * server's directory: the share dialog, recipient autocomplete and free/busy.
 * Each used to download the whole directory on its own - the share dialog on
 * every open - and a listing pages through up to 20,000 principals. Lists the
 * user sees read it through loadScopedPrincipalDirectory
 * (lib/directory-scope.ts), which applies the admin policy's directory rules.
 */

import type { IJMAPClient } from "./client-interface";
import type { PrincipalListing } from "./types";

export const PRINCIPAL_DIRECTORY_TTL_MS = 5 * 60 * 1000;

const listings = new WeakMap<IJMAPClient, { loadedAt: number; listing: Promise<PrincipalListing> }>();

function fetchListing(client: IJMAPClient): Promise<PrincipalListing> {
  if (client.listPrincipals) return client.listPrincipals();
  return client.getPrincipals().then((principals) => ({ principals, status: "ok" as const }));
}

/**
 * The client's principal listing, shared while it is fresh; callers that
 * arrive while it loads get the same request. Never rejects.
 */
export function loadPrincipalDirectory(client: IJMAPClient): Promise<PrincipalListing> {
  const cached = listings.get(client);
  if (cached && Date.now() - cached.loadedAt < PRINCIPAL_DIRECTORY_TTL_MS) {
    return cached.listing;
  }
  const listing = fetchListing(client).catch((): PrincipalListing => ({ principals: [], status: "error" }));
  const entry = { loadedAt: Date.now(), listing };
  listings.set(client, entry);
  void listing.then(({ status }) => {
    // A failed listing isn't kept, so the next caller asks again.
    if (status === "error" && listings.get(client) === entry) listings.delete(client);
  });
  return listing;
}
