import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Identity } from '@/lib/jmap/types';

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
  setPreferredPrimary: (identityId: string | null) => void;
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
      isLoading: false,
      error: null,
      subAddress: {
        recentTags: [],
        tagSuggestions: {},
      },

      setIdentities: (identities) => set({ identities }),

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

      setPreferredPrimary: (identityId) => set({ preferredPrimaryId: identityId }),

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
      }),
    }
  )
);
