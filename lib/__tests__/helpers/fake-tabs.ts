// Browser tabs for one test process: a shared Web Locks queue and a
// BroadcastChannel that delivers to every other tab (never to the sender),
// asynchronously and as a copy, like the real ones.

type Listener = (event: { data: unknown }) => void;
type Waiter = { tab: number; grant: () => void };

export interface FakeTab {
  locks: LockManager;
  channel: BroadcastChannel;
  /** Closes the tab: its locks go to the next tab in line, its posts stop. */
  close: () => void;
}

export function createFakeBrowser() {
  const tabs: { id: number; listeners: Set<Listener>; closed: boolean }[] = [];
  const holders = new Map<string, number>();
  const queues = new Map<string, Waiter[]>();

  const release = (name: string) => {
    holders.delete(name);
    queues.get(name)?.shift()?.grant();
  };

  function openTab(): FakeTab {
    const self = { id: tabs.length, listeners: new Set<Listener>(), closed: false };
    tabs.push(self);

    const channel = {
      postMessage(data: unknown) {
        if (self.closed) return;
        for (const other of tabs) {
          if (other === self || other.closed) continue;
          const copy = structuredClone(data);
          setTimeout(() => other.listeners.forEach((l) => l({ data: copy })), 0);
        }
      },
      addEventListener(_type: string, listener: Listener) {
        self.listeners.add(listener);
      },
    };

    const locks = {
      request(
        name: string,
        options: { signal?: AbortSignal; ifAvailable?: boolean },
        callback: (lock: { name: string } | null) => Promise<unknown>,
      ) {
        if (options.ifAvailable && holders.has(name)) return Promise.resolve().then(() => callback(null));
        return new Promise((resolve, reject) => {
          const grant = () => {
            holders.set(name, self.id);
            Promise.resolve()
              .then(() => callback({ name }))
              .then(resolve, reject)
              .finally(() => {
                if (!self.closed && holders.get(name) === self.id) release(name);
              });
          };
          if (options.signal?.aborted) {
            reject(new DOMException('The request was aborted.', 'AbortError'));
            return;
          }
          if (!holders.has(name)) {
            grant();
            return;
          }
          const waiter = { tab: self.id, grant };
          const queue = queues.get(name) ?? [];
          queue.push(waiter);
          queues.set(name, queue);
          options.signal?.addEventListener('abort', () => {
            const at = queue.indexOf(waiter);
            if (at < 0) return;
            queue.splice(at, 1);
            reject(new DOMException('The request was aborted.', 'AbortError'));
          });
        });
      },
    };

    const close = () => {
      self.closed = true;
      for (const queue of queues.values()) {
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].tab === self.id) queue.splice(i, 1);
      }
      for (const [name, holder] of [...holders]) if (holder === self.id) release(name);
    };

    return {
      locks: locks as unknown as LockManager,
      channel: channel as unknown as BroadcastChannel,
      close,
    };
  }

  return { openTab };
}

/** Lets queued lock grants and channel deliveries run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
