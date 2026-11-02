import { describe, it, expect, vi, afterEach } from 'vitest';
import { canWritePrivateFile, downloadGraceMs, privateFileSink, sweepPrivateExports } from '@/lib/mail-export/sinks';

/** A tiny origin private file system: one directory of files. */
function fakeOpfs() {
  const files = new Map<string, Uint8Array[]>();
  const dir = {
    getFileHandle: async (name: string) => {
      if (!files.has(name)) files.set(name, []);
      return {
        createWritable: async () => ({
          write: async (data: Uint8Array) => { files.get(name)!.push(data); },
          close: async () => {},
          abort: async () => {},
        }),
        getFile: async () => new File(files.get(name)! as BlobPart[], name),
      };
    },
    removeEntry: async (name: string) => { files.delete(name); },
    keys: async function* () { yield* [...files.keys()]; },
  };
  const root = {
    getDirectoryHandle: async (name: string, opts?: { create?: boolean }) => {
      if (name !== 'bulwark-exports') throw new Error('no');
      if (!opts?.create && files.size === 0 && !created) throw new DOMException('missing', 'NotFoundError');
      created = true;
      return dir;
    },
    removeEntry: vi.fn(async () => { files.clear(); }),
  };
  let created = false;
  return { files, root };
}

/** Web Locks where `held` names belong to another tab. */
function fakeLocks(held: Set<string>) {
  return {
    request: async (name: string, _o: unknown, cb: (lock: unknown) => unknown) => cb(held.has(name) ? null : { name }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sweepPrivateExports', () => {
  it('deletes the files no tab holds and leaves another tab\'s running export alone', async () => {
    const opfs = fakeOpfs();
    opfs.files.set('1-old', [new Uint8Array(3)]);
    opfs.files.set('2-busy', [new Uint8Array(3)]);
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.root }, locks: fakeLocks(new Set(['bulwark-export-file:2-busy'])) });
    await sweepPrivateExports();
    expect([...opfs.files.keys()]).toEqual(['2-busy']);
  });

  it('sweeps nothing without Web Locks unless everyone signed out', async () => {
    const opfs = fakeOpfs();
    opfs.files.set('1-old', [new Uint8Array(3)]);
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.root } });
    await sweepPrivateExports();
    expect(opfs.files.size).toBe(1);
    await sweepPrivateExports({ force: true });
    expect(opfs.root.removeEntry).toHaveBeenCalledWith('bulwark-exports', { recursive: true });
  });
});

describe('privateFileSink', () => {
  it('keeps the file while its download may still read it, and deletes it after', async () => {
    vi.useFakeTimers();
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.root }, locks: fakeLocks(new Set()) });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() }));
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    await sink.write(new Uint8Array(10));
    const file = await sink.close();
    const gone = file.discard();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(opfs.files.size).toBe(1);
    await vi.advanceTimersByTimeAsync(downloadGraceMs(10));
    await gone;
    expect(opfs.files.size).toBe(0);
  });

  it('deletes at once on sign-out', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.root }, locks: fakeLocks(new Set()) });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() }));
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    await sink.write(new Uint8Array(10));
    await (await sink.close()).discard(true);
    expect(opfs.files.size).toBe(0);
  });
});

describe('canWritePrivateFile', () => {
  it('is false where the private file system has no writable files (Safari before 26)', () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({}) } });
    vi.stubGlobal('FileSystemFileHandle', class {});
    expect(canWritePrivateFile()).toBe(false);
    vi.stubGlobal('FileSystemFileHandle', class { createWritable() {} });
    expect(canWritePrivateFile()).toBe(true);
  });
});
