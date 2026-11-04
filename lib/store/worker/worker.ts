/**
 * The store worker. Every tab has one, parked on the owner lock, and only the
 * holder loads the wasm and touches OPFS. The lock is held for the worker's
 * whole life, so handing over means: close, pause the VFS, then let go.
 *
 * Built to public/store-worker.js by scripts/build-store-worker.mjs.
 */

import { WasmStorage } from '../adapters/wasm';
import { STORE_AREAS } from '../areas';
import { RPC_CHANNEL, OWNER_LOCK, type ChannelMessage, type PageToWorker, type WorkerToPage } from './protocol';
import { StoreHost, storeFilesToPrune } from './host';

const scope = self as unknown as {
  postMessage(message: WorkerToPage): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<PageToWorker>) => void): void;
  close(): void;
};

let clientId = '';
let moduleUrl = '';
let storage: WasmStorage | null = null;
let host: StoreHost | null = null;
let channel: BroadcastChannel | null = null;
let releaseLock: (() => void) | null = null;

function reply(id: string, result?: unknown): void {
  scope.postMessage({ kind: 'result', id, result });
}

function replyError(id: string, error: unknown): void {
  scope.postMessage({
    kind: 'result',
    id,
    error: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : undefined,
  });
}

function requireHost(): StoreHost {
  if (!host) throw new Error('This tab does not own the local store');
  return host;
}

async function becomeOwner(): Promise<void> {
  storage = await WasmStorage.install(moduleUrl);
  host = new StoreHost({
    areas: STORE_AREAS,
    storage,
    emit: (event) => {
      scope.postMessage({ kind: 'event', event });
      channel?.postMessage({ kind: 'event', event } satisfies ChannelMessage);
    },
    needAuth: (account) => scope.postMessage({ kind: 'need-auth', account }),
  });
  channel = new BroadcastChannel(RPC_CHANNEL);
  channel.onmessage = async (event: MessageEvent<ChannelMessage>) => {
    const message = event.data;
    if (message.kind === 'who-owns') {
      channel?.postMessage({ kind: 'owner-changed', owner: clientId } satisfies ChannelMessage);
      return;
    }
    if (message.kind !== 'rpc') return;
    try {
      const result = await requireHost().call(message.method, message.params);
      channel?.postMessage({ kind: 'reply', id: message.id, to: message.from, result } satisfies ChannelMessage);
    } catch (error) {
      channel?.postMessage({
        kind: 'reply',
        id: message.id,
        to: message.from,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : undefined,
      } satisfies ChannelMessage);
    }
  };
  channel.postMessage({ kind: 'owner-changed', owner: clientId } satisfies ChannelMessage);
  scope.postMessage({ kind: 'owner' });
}

async function release(): Promise<void> {
  // The order matters: the OPFS handles have to be free before the lock is.
  channel?.postMessage({ kind: 'owner-changed', owner: null } satisfies ChannelMessage);
  await host?.closeAll();
  host = null;
  storage?.pause();
  storage = null;
  channel?.close();
  channel = null;
  releaseLock?.();
  releaseLock = null;
}

scope.addEventListener('message', async (event) => {
  const message = event.data;
  switch (message.kind) {
    case 'init':
      clientId = message.clientId;
      moduleUrl = message.moduleUrl;
      void navigator.locks.request(OWNER_LOCK, () => new Promise<void>((resolve) => {
        releaseLock = resolve;
        becomeOwner().catch((error) => {
          scope.postMessage({
            kind: 'event',
            event: { type: 'error', account: '', area: 'store', message: error instanceof Error ? error.message : String(error) },
          });
          resolve();
        });
      }));
      break;
    case 'open':
      try {
        reply(message.id, await requireHost().openAccount(message.params));
      } catch (error) {
        replyError(message.id, error);
      }
      break;
    case 'prune-files':
      try {
        for (const file of storeFilesToPrune(storage?.files() ?? [], message.keep)) storage?.remove(file);
        reply(message.id);
      } catch (error) {
        replyError(message.id, error);
      }
      break;
    case 'close-account':
      try {
        await requireHost().closeAccount(message.account);
        reply(message.id);
      } catch (error) {
        replyError(message.id, error);
      }
      break;
    case 'rekey':
      try {
        await requireHost().rekey(message.account, message.file, message.keyHex);
        reply(message.id);
      } catch (error) {
        replyError(message.id, error);
      }
      break;
    case 'set-auth':
      host?.setAuth(message.account, message.auth);
      break;
    case 'set-session':
      host?.setSession(message.account, message.session);
      break;
    case 'set-inverted':
      host?.setInvertedKeywordSort(message.account, message.inverted);
      break;
    case 'release':
      try {
        await release();
        reply(message.id);
      } catch (error) {
        replyError(message.id, error);
      }
      break;
  }
});
