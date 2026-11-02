import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { VacationAudience, VacationForward } from '@/lib/jmap/sieve-types';
import { readVacationFilters, syncVacationWithFilters, type VacationFilters } from '@/stores/filter-store';
import { withVacationPeriod } from '@/lib/sieve/vacation-forward';
import { currentStoreEpoch } from '@/lib/store-epoch';
import { debug } from '@/lib/debug';
import { vacationHooks } from '@/lib/plugin-hooks';
import { vacationToView } from '@/lib/plugin-projection';
import { vacationReplyLoaded, vacationReplySaved } from '@/lib/vacation-calendar';

/** What the vacation card sets for forwarding; the period comes from the vacation. */
export type VacationForwardSettings = Pick<VacationForward, 'enabled' | 'to' | 'keepCopy'>;

/**
 * The vacation response was saved, but what the filters script carries for
 * it (forwarding, who gets the auto-reply) was not: forwarding may not run
 * or still run, and the auto-reply may go to the wrong senders.
 */
export class VacationFiltersError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'filters_save_error');
    this.name = 'VacationFiltersError';
  }
}

interface VacationStore {
  isEnabled: boolean;
  fromDate: string | null;
  toDate: string | null;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  /** Forwarding as stored in the filters script; null when none is set up. */
  forward: VacationForward | null;
  /** The account's filters script can carry forwarding (see readVacationFilters). */
  forwardAvailable: boolean;
  /** Who gets the auto-reply as stored; null when everyone does. */
  audience: VacationAudience | null;
  /** The auto-reply can be narrowed to some senders (see readVacationFilters). */
  audienceAvailable: boolean;
  /** Stored forwarding or recipients do not run until the card is saved (see readVacationFilters). */
  notRunning: boolean;
  /** The most forwards the filter rules let one message collect (see readVacationFilters). */
  otherForwards: number;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  isSupported: boolean;

  fetchVacationResponse: (client: IJMAPClient, accountId?: string) => Promise<void>;
  /**
   * Saves the out-of-office reply. Resolves false when a plugin stopped the
   * change (onBeforeVacationUpdate), true once it was saved. Throws
   * VacationFiltersError when only the filters script part could not be saved.
   */
  updateVacationResponse: (client: IJMAPClient, updates: {
    isEnabled?: boolean;
    fromDate?: string | null;
    toDate?: string | null;
    subject?: string;
    textBody?: string;
    htmlBody?: string | null;
    /** null removes the forwarding, leaving it out keeps it as it is. */
    forward?: VacationForwardSettings | null;
    /** null lets everyone have the auto-reply, leaving it out keeps it as it is. */
    audience?: VacationAudience | null;
  }, accountId?: string) => Promise<boolean>;
  setSupported: (supported: boolean) => void;
  clearState: () => void;
}

/** The card's part of what the filters script holds. */
function fromFilters(filters: VacationFilters) {
  return {
    forward: filters.forward,
    forwardAvailable: filters.forwardAvailable,
    audience: filters.audience,
    audienceAvailable: filters.audienceAvailable,
    notRunning: filters.notRunning,
    otherForwards: filters.otherForwards,
  };
}

/**
 * Whether the account has a filters script to read and sync. A shared
 * account goes by its own capabilities, which can lack Sieve where the
 * session has it (#1263); the own account by the session.
 */
function hasSieve(client: IJMAPClient, accountId?: string): boolean {
  return accountId ? client.accountSupports(accountId, 'urn:ietf:params:jmap:sieve') : client.supportsSieve();
}

// Each load, and each account switch (the store epoch), outdates the answers
// of the loads before it: one for another account must not land in the card
// on screen, where saving would write it to this account.
let loadGeneration = 0;

export const useVacationStore = create<VacationStore>()((set, get) => ({
  isEnabled: false,
  fromDate: null,
  toDate: null,
  subject: '',
  textBody: '',
  htmlBody: null,
  forward: null,
  forwardAvailable: false,
  audience: null,
  audienceAvailable: false,
  notRunning: false,
  otherForwards: 0,
  isLoading: false,
  isSaving: false,
  error: null,
  isSupported: false,

  fetchVacationResponse: async (client, accountId) => {
    const generation = ++loadGeneration;
    const epoch = currentStoreEpoch();
    const stale = () => generation !== loadGeneration || currentStoreEpoch() !== epoch;
    set({ isLoading: true, error: null });
    try {
      const vacation = await client.getVacationResponse(accountId);
      let isEnabled = vacation.isEnabled;
      let filters: VacationFilters | null = null;
      if (hasSieve(client, accountId)) {
        filters = await readVacationFilters(client, accountId).catch(() => null);
        // Running from the filters script leaves the vacation script itself
        // inactive, so VacationResponse reports it as off.
        if (filters) isEnabled = isEnabled || filters.includesVacation;
      }
      if (stale()) return;
      if (vacationHooks.onVacationLoaded.size > 0) {
        void vacationHooks.onVacationLoaded.emit(vacationToView({ ...vacation, isEnabled }));
      }
      set({
        isEnabled,
        fromDate: vacation.fromDate,
        toDate: vacation.toDate,
        subject: vacation.subject || '',
        textBody: vacation.textBody || '',
        htmlBody: vacation.htmlBody,
        forward: null,
        forwardAvailable: false,
        audience: null,
        audienceAvailable: false,
        notRunning: false,
        otherForwards: 0,
        ...(filters ? fromFilters(filters) : {}),
        isLoading: false,
      });
      // Out-of-office blocks the calendar (lib/vacation-calendar.ts): the
      // reply may have been set in another client.
      vacationReplyLoaded(client, accountId, { isEnabled, fromDate: vacation.fromDate, toDate: vacation.toDate, subject: vacation.subject || '' });
    } catch (error) {
      if (stale()) return;
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'fetch_error',
      });
    }
  },

  updateVacationResponse: async (client, updates, accountId) => {
    // The save itself goes to the account it was made for; only what it
    // leaves in the store is dropped once another load or account took over.
    const generation = loadGeneration;
    const epoch = currentStoreEpoch();
    const superseded = () => generation !== loadGeneration || currentStoreEpoch() !== epoch;
    const { forward: forwardSettings, audience, ...vacationUpdates } = updates;
    const before = get();
    const next = vacationToView({
      id: 'singleton',
      isEnabled: before.isEnabled,
      fromDate: before.fromDate,
      toDate: before.toDate,
      subject: before.subject,
      textBody: before.textBody,
      htmlBody: before.htmlBody,
      ...vacationUpdates,
    });
    if (!(await vacationHooks.onBeforeVacationUpdate.intercept(next))) return false;
    set({ isSaving: true, error: null });
    try {
      await client.setVacationResponse(vacationUpdates, accountId);
    } catch (error) {
      set(superseded()
        ? { isSaving: false }
        : { isSaving: false, error: error instanceof Error ? error.message : 'save_error' });
      throw error;
    }

    // Forwarding runs in the vacation's period, so it takes the dates along.
    const state = get();
    const fromDate = vacationUpdates.fromDate !== undefined ? vacationUpdates.fromDate : state.fromDate;
    const toDate = vacationUpdates.toDate !== undefined ? vacationUpdates.toDate : state.toDate;
    const period = { from: fromDate, until: toDate };

    let filtersError: VacationFiltersError | null = null;
    let filtersState: Partial<VacationStore> = {};
    const needsSync = vacationUpdates.isEnabled !== undefined || forwardSettings !== undefined || audience !== undefined;
    if (needsSync && hasSieve(client, accountId)) {
      let synced = false;
      try {
        await syncVacationWithFilters(
          client, vacationUpdates.isEnabled ?? state.isEnabled, accountId, forwardSettings, audience, period,
        );
        synced = true;
      } catch (error) {
        debug.error('Failed to keep filters active next to the vacation response:', error);
        // Forwarding that is or was on may now not run, or still run; an
        // auto-reply meant for some senders may go to everyone, or the other
        // way round.
        if (forwardSettings?.enabled || state.forward?.enabled || audience || state.audience) {
          filtersError = new VacationFiltersError(error);
        }
      }
      // What the filters script holds now, and whether it runs. After a
      // failed save the card keeps what the user set, to save it again.
      const filters = await readVacationFilters(client, accountId).catch(() => null);
      if (filters) {
        filtersState = synced ? fromFilters(filters) : { notRunning: filters.notRunning };
      } else if (synced) {
        filtersState = {
          ...(forwardSettings !== undefined
            ? { forward: forwardSettings && withVacationPeriod(forwardSettings, period) }
            : {}),
          ...(audience !== undefined ? { audience } : {}),
          notRunning: false,
        };
      }
    }

    set((current) => (superseded()
      ? { ...current, isSaving: false }
      : { ...current, ...vacationUpdates, ...filtersState, isSaving: false }));
    // The reply itself is saved even when its filters part failed.
    void vacationHooks.onVacationUpdate.emit(next);
    vacationReplySaved(client, accountId, before, { isEnabled: next.isEnabled, fromDate: next.fromDate, toDate: next.toDate, subject: next.subject });
    if (filtersError) throw filtersError;
    return true;
  },

  setSupported: (supported) => set({ isSupported: supported }),

  clearState: () => {
    loadGeneration++;
    set({
      isEnabled: false,
      fromDate: null,
      toDate: null,
      subject: '',
      textBody: '',
      htmlBody: null,
      forward: null,
      forwardAvailable: false,
      audience: null,
      audienceAvailable: false,
      notRunning: false,
      otherForwards: 0,
      isLoading: false,
      isSaving: false,
      error: null,
      isSupported: false,
    });
  },
}));
