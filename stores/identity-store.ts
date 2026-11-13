import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { EmailAddress, Identity } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { identityHooks } from '@/lib/plugin-hooks';
import { identityToView } from '@/lib/plugin-projection';

// Constants for sub-addressing limits
const MAX_RECENT_TAGS = 10;
const MAX_DOMAIN_SUGGESTIONS = 5;

interface SubAddressState {
  recentTags: string[];
  tagSuggestions: Record<string, string[]>;
}

interface IdentityStore {
  // Identity state (from server)
  identities: Identity[];
  selectedIdentityId: string | null;
  preferredPrimaryId: string | null;
  /**
   * The account (AccountEntry.id) `preferredPrimaryId` was chosen for.
   * Identity ids are short and repeat across accounts ("b", "c"), so the
   * value means nothing for another account (#1644). null for a value kept
   * from before this was recorded.
   */
  preferredPrimaryAccountId: string | null;
  isLoading: boolean;
  error: string | null;

  // Sub-addressing state (persisted locally)
  subAddress: SubAddressState;

  // Actions - Identity CRUD
  setIdentities: (identities: Identity[]) => void;
  addIdentity: (identity: Identity) => void;
  updateIdentityLocal: (identityId: string, updates: Partial<Identity>) => void;
  removeIdentity: (identityId: string) => void;
  selectIdentity: (identityId: string | null) => void;
  setPreferredPrimary: (identityId: string | null, accountId?: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearIdentities: () => void;

  // Sub-addressing actions
  addRecentTag: (tag: string) => void;
  addTagSuggestion: (domain: string, tag: string) => void;
  getTagSuggestionsForDomain: (domain: string) => string[];
  clearRecentTags: () => void;
}

export const useIdentityStore = create<IdentityStore>()(
  persist(
    (set, get) => ({
      identities: [],
      selectedIdentityId: null,
      preferredPrimaryId: null,
      preferredPrimaryAccountId: null,
      isLoading: false,
      error: null,
      subAddress: {
        recentTags: [],
        tagSuggestions: {},
      },

      setIdentities: (identities) => {
        const changed = identitySetKey(get().identities) !== identitySetKey(identities);
        set({ identities });
        // Reordering (a new default sender) is not a load; only tell plugins
        // when the identities themselves are new or differ.
        if (changed && identityHooks.onIdentitiesLoaded.size > 0) {
          void identityHooks.onIdentitiesLoaded.emit(identities.map(identityToView));
        }
      },

      addIdentity: (identity) => set((state) => ({
        identities: [...state.identities, identity]
      })),

      updateIdentityLocal: (identityId, updates) => set((state) => ({
        identities: state.identities.map(id =>
          id.id === identityId ? { ...id, ...updates } : id
        )
      })),

      removeIdentity: (identityId) => set((state) => ({
        identities: state.identities.filter(id => id.id !== identityId),
        selectedIdentityId: state.selectedIdentityId === identityId
          ? null
          : state.selectedIdentityId
      })),

      selectIdentity: (identityId) => set({ selectedIdentityId: identityId }),

      setPreferredPrimary: (identityId, accountId = null) => set({
        preferredPrimaryId: identityId,
        preferredPrimaryAccountId: identityId ? accountId : null,
      }),

      setLoading: (loading) => set({ isLoading: loading }),

      setError: (error) => set({ error }),

      clearIdentities: () => set({
        identities: [],
        selectedIdentityId: null,
        error: null,
      }),

      addRecentTag: (tag) => set((state) => {
        const recent = [tag, ...state.subAddress.recentTags.filter(t => t !== tag)];
        return {
          subAddress: {
            ...state.subAddress,
            recentTags: recent.slice(0, MAX_RECENT_TAGS),
          }
        };
      }),

      addTagSuggestion: (domain, tag) => set((state) => {
        const suggestions = { ...state.subAddress.tagSuggestions };
        const existing = suggestions[domain] || [];
        if (!existing.includes(tag)) {
          suggestions[domain] = [...existing, tag].slice(0, MAX_DOMAIN_SUGGESTIONS);
        }
        return {
          subAddress: {
            ...state.subAddress,
            tagSuggestions: suggestions,
          }
        };
      }),

      getTagSuggestionsForDomain: (domain) => {
        return get().subAddress.tagSuggestions[domain] || [];
      },

      clearRecentTags: () => set((state) => ({
        subAddress: {
          ...state.subAddress,
          recentTags: [],
        }
      })),
    }),
    {
      name: 'identity-storage',
      // Only persist sub-addressing data, not identities (they're server-side).
      // The default sender identity (`preferredPrimaryId`) is the per-account
      // value for the *active* account; it is kept here purely as a local
      // fallback so the choice survives a reload when settings sync is off.
      // The durable, cross-device, exportable source of truth is the synced
      // settings store, keyed per account (`preferredIdentityIds`), which is
      // re-applied via applyPreferredIdentity() once server settings load and
      // overrides this value per account (issue #507).
      partialize: (state) => ({
        subAddress: state.subAddress,
        preferredPrimaryId: state.preferredPrimaryId,
        preferredPrimaryAccountId: state.preferredPrimaryAccountId,
      }),
    }
  )
);

/** Order-independent fingerprint of an identity list. */
function identitySetKey(identities: Identity[]): string {
  return JSON.stringify(identities.map((i) => JSON.stringify(i)).sort());
}

export interface IdentityInput {
  name: string;
  email: string;
  replyTo?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  textSignature?: string | null;
  htmlSignature?: string | null;
}

// Identity changes made by the user (Settings > Identities). Each asks
// onBeforeIdentityChange first, makes the JMAP call, and tells plugins only
// once the server accepted it. They return false when a plugin stopped the
// change, true otherwise; server errors are thrown to the caller.

export async function createIdentityWithHooks(client: IJMAPClient, data: IdentityInput): Promise<boolean> {
  const draft = identityToView({ id: '', mayDelete: true, ...data } as Identity);
  if (!(await identityHooks.onBeforeIdentityChange.intercept({ change: 'create', identity: draft }))) return false;
  const created = await client.createIdentity(
    data.name, data.email, data.replyTo, data.bcc, data.textSignature, data.htmlSignature,
  );
  void identityHooks.onIdentityCreate.emit(identityToView(created));
  return true;
}

export async function updateIdentityWithHooks(
  client: IJMAPClient,
  identity: Identity,
  updates: Partial<Omit<IdentityInput, 'email'>>,
): Promise<boolean> {
  const next = identityToView({ ...identity, ...updates } as Identity);
  if (!(await identityHooks.onBeforeIdentityChange.intercept({ identityId: identity.id, change: 'update', identity: next }))) {
    return false;
  }
  await client.updateIdentity(identity.id, updates);
  void identityHooks.onIdentityUpdate.emit(next);
  return true;
}

/**
 * Change some fields of one identity (the Account page's name, a signature
 * on Composing) and keep the local list in step, without reloading every
 * identity. Callers then run the auth store's syncIdentities so the From
 * line and the account switcher follow.
 */
export async function saveIdentityChanges(
  client: IJMAPClient,
  identity: Identity,
  updates: Partial<Omit<IdentityInput, 'email'>>,
): Promise<boolean> {
  if (!(await updateIdentityWithHooks(client, identity, updates))) return false;
  useIdentityStore.getState().updateIdentityLocal(identity.id, updates as Partial<Identity>);
  return true;
}

export async function deleteIdentityWithHooks(client: IJMAPClient, identity: Identity): Promise<boolean> {
  if (!(await identityHooks.onBeforeIdentityChange.intercept({
    identityId: identity.id, change: 'delete', identity: identityToView(identity),
  }))) {
    return false;
  }
  await client.deleteIdentity(identity.id);
  void identityHooks.onIdentityDelete.emit({ identityId: identity.id });
  return true;
}

/** Tells plugins the user picked another From identity in the composer. */
export function notifyIdentitySelected(identities: Identity[], identityId: string): void {
  const identity = identities.find((i) => i.id === identityId);
  if (identity) void identityHooks.onIdentitySelect.emit(identityToView(identity));
}
