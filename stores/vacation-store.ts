import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { VacationAudience, VacationForward } from '@/lib/jmap/sieve-types';
import type { VacationResponse } from '@/lib/jmap/types';
import { parseStalwartVacationScript, type StalwartVacationReply } from '@/lib/sieve/stalwart-vacation';
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
  /**
   * The account has filters (Sieve) but they couldn't be read on the last
   * load, so whether the out-of-office forwards mail isn't known.
   */
  forwardUnknown: boolean;
  /** The most forwards the filter rules let one message collect (see readVacationFilters). */
  otherForwards: number;
  /**
   * Set while the reply shown is one that only Stalwart's old "vacation"
   * script holds (see fetchVacationResponse), with the account it was read
   * for. The next save for that account sends it along, so that the server
   * answers with what the card shows.
   */
  replyOnlyInScript: { accountId: string | undefined } | null;
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

/** Whether the server holds a reply at all: a text, a subject or a period. */
function hasReply(vacation: VacationResponse): boolean {
  return !!(vacation.subject || vacation.textBody || vacation.htmlBody || vacation.fromDate || vacation.toDate);
}

/** The reply in Stalwart's old "vacation" script (see parseStalwartVacationScript), or null. */
async function readStalwartVacation(
  client: IJMAPClient,
  blobId: string,
  accountId?: string,
): Promise<StalwartVacationReply | null> {
  try {
    return await parseStalwartVacationScript(
      await client.getSieveScriptContent(blobId, accountId || client.getSieveAccountId()),
    );
  } catch {
    return null;
  }
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
  forwardUnknown: false,
  otherForwards: 0,
  replyOnlyInScript: null,
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
      let reply: StalwartVacationReply = vacation;
      let replyOnlyInScript: VacationStore['replyOnlyInScript'] = null;
      let isEnabled = vacation.isEnabled;
      let filters: VacationFilters | null = null;
      const sieve = hasSieve(client, accountId);
      if (sieve) {
        filters = await readVacationFilters(client, accountId).catch(() => null);
        if (filters) {
          // Running from the filters script leaves the vacation script itself
          // inactive, so VacationResponse reports it as off. Stalwart 1.2 does
          // the same for a "vacation" script from before its update, which
          // still answers while it is the active one.
          isEnabled = isEnabled || filters.includesVacation || !!filters.stalwartVacation?.isActive;
          // From 1.2 Stalwart keeps the reply in "managed" and starts it
          // empty; one set before the update is only in the old script. The
          // card shows it, and the next save moves it to "managed". Not while
          // the server answers from "managed": that reply is the one in use,
          // empty or not.
          if (filters.stalwartVacation && !vacation.isEnabled && !hasReply(vacation)) {
            const old = await readStalwartVacation(client, filters.stalwartVacation.blobId, accountId);
            if (old) {
              reply = old;
              replyOnlyInScript = { accountId };
            }
          }
        }
      }
      if (stale()) return;
      if (vacationHooks.onVacationLoaded.size > 0) {
        void vacationHooks.onVacationLoaded.emit(vacationToView({ ...vacation, ...reply, isEnabled }));
      }
      set({
        isEnabled,
        fromDate: reply.fromDate,
        toDate: reply.toDate,
        subject: reply.subject || '',
        textBody: reply.textBody || '',
        htmlBody: reply.htmlBody,
        forward: null,
        forwardAvailable: false,
        audience: null,
        audienceAvailable: false,
        notRunning: false,
        otherForwards: 0,
        forwardUnknown: sieve && !filters,
        ...(filters ? fromFilters(filters) : {}),
        replyOnlyInScript,
        isLoading: false,
      });
      // Out-of-office blocks the calendar (lib/vacation-calendar.ts): the
      // reply may have been set in another client.
      vacationReplyLoaded(client, accountId, { isEnabled, fromDate: reply.fromDate, toDate: reply.toDate, subject: reply.subject || '' });
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
    const { forward: forwardSettings, audience, ...given } = updates;
    const before = get();
    // A reply that only Stalwart's old script holds goes along, with its
    // switch: a save that only turns the reply on (a plugin) or off (the
    // sidebar) would otherwise leave "managed" without it, and the server
    // would answer with its default text while the card shows the old one.
    const carried = before.replyOnlyInScript && before.replyOnlyInScript.accountId === accountId
      ? {
        isEnabled: before.isEnabled,
        fromDate: before.fromDate,
        toDate: before.toDate,
        subject: before.subject,
        textBody: before.textBody,
        htmlBody: before.htmlBody,
      }
      : {};
    const vacationUpdates = { ...carried, ...given };
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
      : { ...current, ...vacationUpdates, ...filtersState, replyOnlyInScript: null, isSaving: false }));
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
      forwardUnknown: false,
      otherForwards: 0,
      replyOnlyInScript: null,
      isLoading: false,
      isSaving: false,
      error: null,
      isSupported: false,
    });
  },
}));
