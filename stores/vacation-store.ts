import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { isVacationIncludedInFilters, syncVacationWithFilters } from '@/stores/filter-store';
import { debug } from '@/lib/debug';

interface VacationStore {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  isSupported: boolean;

  fetchVacationResponse: (client: IJMAPClient, accountId?: string) => Promise<void>;
  updateVacationResponse: (client: IJMAPClient, updates: {
    isEnabled?: boolean;
    fromDate?: string | null;
    toDate?: string | null;
    subject?: string;
    textBody?: string;
    htmlBody?: string | null;
  }, accountId?: string) => Promise<void>;
  setSupported: (supported: boolean) => void;
  clearState: () => void;
}

export const useVacationStore = create<VacationStore>()((set) => ({
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: '',
  textBody: '',
  htmlBody: null,
  isLoading: false,
  isSaving: false,
  error: null,
  isSupported: false,

  fetchVacationResponse: async (client, accountId) => {
    set({ isLoading: true, error: null });
    try {
      const vacation = await client.getVacationResponse(accountId);
      let isEnabled = vacation.isEnabled;
      if (!isEnabled && client.supportsSieve()) {
        // Running from the filters script leaves the vacation script itself
        // inactive, so VacationResponse reports it as off.
        isEnabled = await isVacationIncludedInFilters(client, accountId).catch(() => false);
      }
      set({
        isEnabled,
        fromDate: vacation.fromDate,
        toDate: vacation.toDate,
        subject: vacation.subject || '',
        textBody: vacation.textBody || '',
        htmlBody: vacation.htmlBody,
        isLoading: false,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'fetch_error',
      });
    }
  },

  updateVacationResponse: async (client, updates, accountId) => {
    set({ isSaving: true, error: null });
    try {
      await client.setVacationResponse(updates, accountId);
      if (updates.isEnabled !== undefined && client.supportsSieve()) {
        try {
          await syncVacationWithFilters(client, updates.isEnabled, accountId);
        } catch (error) {
          debug.error('Failed to keep filters active next to the vacation response:', error);
        }
      }
      set((state) => ({
        ...state,
        ...updates,
        isSaving: false,
      }));
    } catch (error) {
      set({
        isSaving: false,
        error: error instanceof Error ? error.message : 'save_error',
      });
      throw error;
    }
  },

  setSupported: (supported) => set({ isSupported: supported }),

  clearState: () => set({
    isEnabled: false,
    fromDate: null,
    toDate: null,
    subject: '',
    textBody: '',
    htmlBody: null,
    isLoading: false,
    isSaving: false,
    error: null,
    isSupported: false,
  }),
}));
