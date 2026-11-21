import type { PersistStorage, StorageValue } from 'zustand/middleware';

/**
 * localStorage for a persisted store that is open in several browser tabs.
 *
 * zustand's persist writes the whole persisted state on every set(), so a tab
 * that still holds an old value writes it back over another tab's change the
 * next time anything in the store moves (an event load is enough). Here each
 * write keeps what is stored for the fields this tab hasn't changed since it
 * last read or wrote them, and stores only the fields it changed.
 *
 * A field counts as changed when its value differs from the one this tab had
 * at its last read or write. `keep` and `claim` override that for one field:
 * `keep` shows a value in this tab without storing it, `claim` stores the
 * tab's value at the next write even when it looks unchanged.
 */
export interface MergeOnWriteStorage<S> extends PersistStorage<S> {
  /** Treats `value` as this tab's unchanged copy of `key`: writes keep the stored one. */
  keep(key: keyof S & string, value: unknown): void;
  /** Stores this tab's value of `key` at the next write. */
  claim(key: keyof S & string): void;
}

type Fields = Record<string, unknown>;

function localStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readStored<S>(name: string): StorageValue<S> | null {
  const text = localStore()?.getItem(name) ?? null;
  if (text === null) return null;
  try {
    return JSON.parse(text) as StorageValue<S>;
  } catch {
    return null;
  }
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function mergeOnWriteStorage<S>(): MergeOnWriteStorage<S> {
  // Per stored name: this tab's copy of each field at its last read or write.
  const baselines = new Map<string, Fields>();
  const claimed = new Set<string>();
  const keptFields = new Map<string, unknown>();

  const baselineOf = (name: string) => {
    let baseline = baselines.get(name);
    if (!baseline) {
      baseline = {};
      baselines.set(name, baseline);
    }
    return baseline;
  };

  return {
    getItem: (name) => {
      const stored = readStored<S>(name);
      baselines.set(name, { ...((stored?.state ?? {}) as Fields) });
      return stored;
    },
    setItem: (name, value) => {
      const storage = localStore();
      if (!storage) return;
      const ours = value.state as Fields;
      const baseline = baselineOf(name);
      for (const [key, kept] of keptFields) baseline[key] = kept;
      keptFields.clear();
      const stored = readStored<S>(name);
      const theirs = stored && stored.version === value.version ? (stored.state as Fields) : null;
      const next: Fields = { ...(theirs ?? {}) };
      for (const key of Object.keys(ours)) {
        const changed = !theirs || !(key in theirs) || claimed.has(key)
          || !(key in baseline) || !same(ours[key], baseline[key]);
        if (changed) next[key] = ours[key];
        baseline[key] = ours[key];
      }
      claimed.clear();
      try {
        storage.setItem(name, JSON.stringify({ ...value, state: next }));
      } catch {
        // Storage full or blocked: the state is still in memory for this page.
      }
    },
    removeItem: (name) => {
      baselines.delete(name);
      localStore()?.removeItem(name);
    },
    keep: (key, value) => {
      keptFields.set(key, value);
      claimed.delete(key);
    },
    claim: (key) => {
      claimed.add(key);
      keptFields.delete(key);
    },
  };
}
