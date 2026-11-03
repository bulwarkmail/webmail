/**
 * What an export reads from when it runs from the local store: the methods
 * lib/mail-export/engine.ts uses, answered from the store. A message comes as the
 * raw original the store kept, never rebuilt, since a rebuilt one loses signatures
 * and exact bytes. For one that isn't kept, the real client fetches it as usual
 * when the server can be reached. Otherwise it's a MessageNotKeptError, which the
 * engine counts.
 *
 * Store reads have no rate limit, so the engine runs with no gate of its own and
 * this keeps to the server's limit for what goes to the network.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { isStandInId, newStandInId } from '@/lib/jmap/stand-in-ids';
import type { Mailbox } from '@/lib/jmap/types';
import type { StoreBackend } from '@/lib/store/client/api';
import type { MethodCall } from '@/lib/store/engine/transport';
import { MessageNotKeptError, RateGate, type ExportClient, type NotKeptReason } from './engine';

const PAGE = 500;
const REQUESTS_PER_MINUTE = 600;
/** Failed downloads in a row before the rest of the run stops trying the network. */
const NETWORK_TRIES = 3;

type RawAnswer = { ok: true; blob: Blob } | { ok: false; reason: NotKeptReason };

export interface LocalExportClientOptions {
  account: string;
  /** The JMAP account in the store (not the local account id). */
  jmap: string;
  store: Pick<StoreBackend, 'answer' | 'area'>;
  /** The real client if the server may be reached right now, else null. Asked for each message. */
  online: () => Partial<Pick<IJMAPClient, 'fetchBlobForTransfer' | 'getBlobsAsBase64' | 'getMaxConcurrentRequests'>> | null;
  /** Keeps what goes to the network to the server's pace. A test can pass its own. */
  gate?: Pick<RateGate, 'take'>;
}

export type LocalExportClient = ExportClient & { getMailboxes(): Promise<Mailbox[]> };

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

/** A fetch that never got an answer: TypeError in every browser, whatever it says, or the client's own time-out. */
function isNetworkFailure(error: unknown): boolean {
  if (isAbort(error)) return false;
  const { name, message } = (error ?? {}) as { name?: string; message?: string };
  return name === 'TypeError' || /network|timed out/i.test(message ?? '');
}

function networkGate(): RateGate {
  return new RateGate(REQUESTS_PER_MINUTE, Date.now, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

export function localExportClient({ account, jmap, store, online, gate = networkGate() }: LocalExportClientOptions): LocalExportClient {
  let networkMisses = 0;
  const reachable = () => (networkMisses >= NETWORK_TRIES ? null : online());

  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const calls: MethodCall[] = [[name, { accountId: jmap, ...args }, '0']];
    const answer = await store.answer(account, calls);
    const [method, result] = answer?.methodResponses?.[0] ?? [];
    if (!answer || method === 'error') throw new Error(String((result as { description?: string; type?: string } | undefined)?.description ?? (result as { type?: string } | undefined)?.type ?? `${name} got no answer`));
    return result as T;
  };

  const fetchBlobForTransfer = async (blobId: string, _accountId: string | undefined, signal?: AbortSignal): Promise<Uint8Array> => {
    // A draft written on this device: the server has never heard of it, and it has no original yet.
    if (isStandInId(blobId)) throw new MessageNotKeptError('not_kept');
    const kept = await store.area<RawAnswer>(account, 'mail.rawBlob', { jmap, blobId });
    if (kept.ok) return new Uint8Array(await kept.blob.arrayBuffer());
    const real = reachable();
    if (!real?.fetchBlobForTransfer) throw new MessageNotKeptError(kept.reason);
    await gate.take();
    try {
      const bytes = await real.fetchBlobForTransfer(blobId, jmap, signal);
      networkMisses = 0;
      return bytes;
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      networkMisses += 1;
      // The engine tries this again; by the last try this message counts as not kept.
      throw new Error('network failure');
    }
  };

  return {
    getMailboxes: async () => (await call<{ list: Mailbox[] }>('Mailbox/get', { ids: null })).list,

    queryEmailFields: async (filter, properties, _accountId, limit = Number.MAX_SAFE_INTEGER) => {
      const emails: Record<string, unknown>[] = [];
      for (let position = 0; emails.length < limit;) {
        const { ids } = await call<{ ids: string[] }>('Email/query', {
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          position,
          limit: Math.min(PAGE, limit - emails.length),
        });
        if (ids.length === 0) break;
        const { list } = await call<{ list: Record<string, unknown>[] }>('Email/get', { ids, properties });
        // A message with no blobId still counts: the engine leaves such a row out silently.
        emails.push(...list.map((email) => (typeof email.blobId === 'string' ? email : { ...email, blobId: newStandInId() })));
        position += ids.length;
        if (ids.length < PAGE) break;
      }
      return emails as never;
    },

    getBlobsAsBase64: async (blobIds) => {
      const real = reachable();
      const wanted = blobIds.filter((blobId) => !isStandInId(blobId));
      if (!real?.getBlobsAsBase64 || wanted.length === 0) return null;
      const kept = new Set(await store.area<string[]>(account, 'mail.rawKept', { jmap, blobIds: wanted }));
      const missing = wanted.filter((blobId) => !kept.has(blobId));
      if (missing.length === 0) return null;
      await gate.take();
      return real.getBlobsAsBase64(missing, jmap, { sized: true });
    },

    fetchBlobForTransfer,

    fetchBlob: async (blobId) => new Blob([await fetchBlobForTransfer(blobId, jmap) as BlobPart]),

    getMaxConcurrentRequests: () => online()?.getMaxConcurrentRequests?.() ?? 4,
  };
}
