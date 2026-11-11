import { useAuthStore } from '@/stores/auth-store';
import { getActiveAccountSlot } from '@/lib/auth/active-account-slot';
import { currentStoreEpoch } from '@/lib/store-epoch';
import { getManagementCapability } from './management-capability';
import { isStalwartJmapPassthroughEnabled } from './principal';
import { stalwartJmap, requireResult } from './jmap-passthrough';

export interface MaskedAddress {
  id: string;
  accountId: string;
  email: string;
  forDomain: string | null;
  description: string | null;
  enabled: boolean;
}

type MaskedEmailRecord = Omit<MaskedAddress, 'enabled' | 'accountId'> & {
  accountId?: string;
} & Partial<Record<'enable' | 'enabled', boolean>>;

export class MaskedEmailError extends Error {
  constructor(public readonly type: string, description?: string) {
    super(description || type);
  }
}

export function maskedEmailErrorType(error: unknown): string | undefined {
  if (error instanceof MaskedEmailError) return error.type;
  const e = error as { status?: number; methodError?: { type?: string } } | null;
  return e?.status === 403 ? 'forbidden' : e?.methodError?.type;
}

/**
 * Stalwart Community answers every call on an Enterprise-only registry
 * object (MaskedEmail among them) with `forbidden` and this detail
 * (`assert_enterprise_object`, crates/jmap/src/registry/mod.rs). Any other
 * `forbidden` is a permission the session lacks.
 */
function enterpriseOnly(error: unknown): boolean {
  if (maskedEmailErrorType(error) !== 'forbidden') return false;
  const description = error instanceof MaskedEmailError ? error.message
    : (error as { methodError?: { description?: string } } | null)?.methodError?.description;
  return typeof description === 'string' && /only available in the enterprise edition/i.test(description);
}

export function maskedEmailUnavailable(error: unknown): boolean {
  return ['unknownMethod', 'unknownCapability', 'notImplemented', 'unsupported'].includes(maskedEmailErrorType(error) || '') ||
    enterpriseOnly(error);
}

/** One authenticated account and cookie slot; callers cannot supply an owner. */
export function createMaskedEmailManager() {
  const client = useAuthStore.getState().client;
  if (!client) return null;
  const accountId = client.getAccountId();
  const capability = getManagementCapability(client, accountId);
  if (!capability) return null;
  // The released Stalwart 1.x schema calls this field `enable`; the Inbuxa
  // registry calls it `enabled`. Normalize at the capability boundary only.
  const enabledProperty = capability === 'urn:stalwart:jmap' ? 'enable' : 'enabled';
  const properties = ['id', 'accountId', 'email', 'forDomain', 'description', enabledProperty];
  const slot = getActiveAccountSlot() ?? 0;
  const epoch = currentStoreEpoch();
  const ownedIds = new Set<string>();
  const destroyAttempts = new Map<string, 'pending' | 'uncertain' | 'confirmed'>();
  const core = client.getCapabilities()['urn:ietf:params:jmap:core'] as { maxObjectsInGet?: number } | undefined;
  const maxGet = core?.maxObjectsInGet;
  const batchSize = typeof maxGet === 'number' && Number.isInteger(maxGet) && maxGet > 0 ? Math.min(maxGet, 50) : 1;
  const isCurrent = () => currentStoreEpoch() === epoch &&
    useAuthStore.getState().client === client && client.getAccountId() === accountId &&
    (getActiveAccountSlot() ?? 0) === slot;
  const assertCurrent = () => {
    if (!isCurrent()) throw new MaskedEmailError('staleContext');
  };
  async function request<T>(method: string, args: Record<string, unknown>): Promise<T> {
    assertCurrent();
    if (!(await isStalwartJmapPassthroughEnabled())) throw new MaskedEmailError('unsupported');
    assertCurrent();
    const responses = await stalwartJmap([[method, { ...args, accountId }, 'masked']], {
      slot, management: { accountId, capability: capability! },
    });
    assertCurrent();
    const result = requireResult<T & { accountId?: string }>(responses, method);
    if (result.accountId !== undefined && result.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
    return result;
  }
  function verifyRecord(raw: MaskedEmailRecord): MaskedAddress {
    // Native account-filtered get responses redact each record's owner for
    // ordinary users. Callers first require the response envelope's owner;
    // any explicit record owner must still agree with that captured account.
    if (Object.hasOwn(raw, 'accountId') && raw.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
    const enabled = raw[enabledProperty];
    if (typeof raw.id !== 'string' || typeof raw.email !== 'string' || typeof enabled !== 'boolean' ||
      !(raw.description == null || typeof raw.description === 'string') ||
      !(raw.forDomain == null || typeof raw.forDomain === 'string')) throw new MaskedEmailError('invalidResponse');
    return { id: raw.id, accountId, email: raw.email, enabled,
      description: raw.description ?? null, forDomain: raw.forDomain ?? null };
  }
  return {
    isCurrent,
    async list(): Promise<MaskedAddress[]> {
      const addresses: MaskedAddress[] = [];
      const seen = new Set<string>();
      let position = 0;
      let queryState: string | undefined;
      let expectedTotal: number | undefined;
      // The accountId filter is essential even for a privileged session.
      for (;;) {
        const page = await request<{ ids: string[]; queryState?: string; total?: number }>('x:MaskedEmail/query', {
          filter: { accountId }, position, limit: 50, calculateTotal: true,
        });
        if (!Array.isArray(page.ids) || page.ids.some(id => typeof id !== 'string' || seen.has(id))) {
          throw new MaskedEmailError('invalidResponse');
        }
        if (page.total !== undefined) {
          if (!Number.isSafeInteger(page.total) || page.total < position + page.ids.length) throw new MaskedEmailError('invalidResponse');
          if (expectedTotal !== undefined && page.total !== expectedTotal) throw new MaskedEmailError('listChanged');
          expectedTotal = page.total;
        }
        if (queryState !== undefined && page.queryState !== undefined && queryState !== page.queryState) {
          throw new MaskedEmailError('listChanged');
        }
        queryState = page.queryState;
        if (page.ids.length === 0) {
          if (expectedTotal !== undefined && position < expectedTotal) throw new MaskedEmailError('invalidResponse');
          if (position === 0) {
            // A generic registry query may succeed even when the object/get
            // is unavailable (Stalwart Community) or its read permission is
            // missing. Verify support without creating an address.
            const empty = await request<{ accountId: string; list: MaskedEmailRecord[] }>('x:MaskedEmail/get', { ids: [], properties });
            if (empty.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
            if (!Array.isArray(empty.list) || empty.list.length !== 0) throw new MaskedEmailError('invalidResponse');
          }
          break;
        }
        page.ids.forEach(id => seen.add(id));
        for (let offset = 0; offset < page.ids.length; offset += batchSize) {
          const ids = page.ids.slice(offset, offset + batchSize);
          const result = await request<{ accountId: string; list: MaskedEmailRecord[] }>('x:MaskedEmail/get', {
            ids, properties,
          });
          if (result.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
          if (!Array.isArray(result.list)) throw new MaskedEmailError('invalidResponse');
          for (const raw of result.list) {
            if (!ids.includes(raw.id) || addresses.some(address => address.id === raw.id)) throw new MaskedEmailError('invalidResponse');
            addresses.push(verifyRecord(raw));
          }
        }
        position += page.ids.length;
        // Stop only at a verified complete result, not merely a short page.
        // Inbuxa's query currently consumes position during validation; an
        // unnecessary terminal query can therefore repeat the first page.
        if (position === expectedTotal) break;
      }
      assertCurrent();
      if (expectedTotal !== undefined && addresses.length !== expectedTotal) throw new MaskedEmailError('listChanged');
      ownedIds.clear();
      addresses.forEach(address => ownedIds.add(address.id));
      // A complete fresh read can reconcile an uncertain deletion. Pending
      // writes and confirmed deletions stay guarded against duplicate sends.
      for (const [id, state] of destroyAttempts) {
        if (state === 'uncertain') destroyAttempts.delete(id);
      }
      return addresses;
    },
    async create(input: { description: string; forDomain: string }): Promise<string> {
      const result = await request<{
        created?: Record<string, { id: string }>;
        notCreated?: Record<string, { type: string; description?: string }>;
      }>('x:MaskedEmail/set', { create: { new: {
        // Stalwart refuses a present but empty string; no description is null.
        description: input.description || null, forDomain: input.forDomain || null, [enabledProperty]: true,
      } } });
      const error = result.notCreated?.new;
      if (error) throw new MaskedEmailError(error.type, error.description);
      if (typeof result.created?.new?.id !== 'string') throw new MaskedEmailError('invalidResponse');
      return result.created.new.id;
    },
    async update(id: string, changes: { description?: string; enabled?: boolean }): Promise<void> {
      assertCurrent();
      if (!ownedIds.has(id)) throw new MaskedEmailError('ownershipMismatch');
      // Copy only the two editable fields, including for untyped callers.
      const patch: Record<string, string | boolean | null> = {};
      // A cleared description is removed (null), as Stalwart refuses an empty one.
      if (typeof changes.description === 'string') patch.description = changes.description || null;
      if (typeof changes.enabled === 'boolean') patch[enabledProperty] = changes.enabled;
      if (!Object.keys(patch).length) throw new MaskedEmailError('invalidProperties');
      const result = await request<{
        updated?: Record<string, unknown>;
        notUpdated?: Record<string, { type: string; description?: string }>;
      }>('x:MaskedEmail/set', { update: { [id]: patch } });
      const error = result.notUpdated?.[id];
      if (error) throw new MaskedEmailError(error.type, error.description);
      if (!result.updated || !Object.hasOwn(result.updated, id)) throw new MaskedEmailError('invalidResponse');
    },
    async destroy(id: string): Promise<void> {
      assertCurrent();
      if (!ownedIds.has(id)) throw new MaskedEmailError('ownershipMismatch');
      if (destroyAttempts.has(id)) throw new MaskedEmailError('deleteUnconfirmed');
      destroyAttempts.set(id, 'pending');
      try {
        const result = await request<{
          accountId: string; destroyed?: unknown;
          notDestroyed?: Record<string, { type: string; description?: string }>;
        }>('x:MaskedEmail/set', { destroy: [id] });
        if (result.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
        if (result.destroyed !== undefined && (!Array.isArray(result.destroyed) ||
          result.destroyed.some(value => value !== id) || result.destroyed.length > 1)) throw new MaskedEmailError('invalidResponse');
        if (result.notDestroyed !== undefined && (!result.notDestroyed || typeof result.notDestroyed !== 'object' ||
          Array.isArray(result.notDestroyed) || Object.keys(result.notDestroyed).some(key => key !== id))) {
          throw new MaskedEmailError('invalidResponse');
        }
        const error = result.notDestroyed?.[id];
        if (result.notDestroyed && Object.hasOwn(result.notDestroyed, id)) {
          if (!error || typeof error.type !== 'string' || (Array.isArray(result.destroyed) && result.destroyed.length)) {
            throw new MaskedEmailError('invalidResponse');
          }
          destroyAttempts.delete(id);
          throw new MaskedEmailError(error.type, error.description);
        }
        if (!Array.isArray(result.destroyed) || result.destroyed.length !== 1) throw new MaskedEmailError('invalidResponse');
        destroyAttempts.set(id, 'confirmed');
        ownedIds.delete(id);
      } catch (error) {
        if (destroyAttempts.get(id) === 'pending') {
          const type = maskedEmailErrorType(error);
          const status = (error as { status?: number } | null)?.status;
          if (status === 401 || status === 403 || type === 'forbidden' || maskedEmailUnavailable(error)) {
            destroyAttempts.delete(id);
          } else {
            destroyAttempts.set(id, 'uncertain');
            throw new MaskedEmailError('deleteUnconfirmed');
          }
        }
        throw error;
      }
    },
  };
}

export type MaskedEmailManager = NonNullable<ReturnType<typeof createMaskedEmailManager>>;
