// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { canWritePrivateFile, downloadGraceMs, guardedSink, openExportSink, privateFileSink, sweepPrivateExports, ExportForbiddenError, type ExportFile, type ExportSink } from '@/lib/mail-export/sinks';

/** A tiny origin private file system: one directory of files. */
function fakeOpfs() {
  const files = new Map<string, Uint8Array[]>();
  /** Everything ever written to this file system, deleted or not. */
  const written: Uint8Array[] = [];
  const dir = {
    getFileHandle: async (name: string) => {
      if (!files.has(name)) files.set(name, []);
      return {
        createWritable: async () => ({
          write: async (data: Uint8Array) => { files.get(name)!.push(data); written.push(data); },
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
  return { files, written, root };
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
  const MAIL = new TextEncoder().encode('Subject: Very secret mail\r\n\r\nThe plain body\r\n');

  /** A sink on a fake file system; `handed` is what would be downloaded. */
  function setUp() {
    const opfs = fakeOpfs();
    const handed: Blob[] = [];
    const revoke = vi.fn();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.root }, locks: fakeLocks(new Set()) });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => { handed.push(blob); return 'blob:x'; }, revokeObjectURL: revoke }));
    return { opfs, handed, revoke };
  }

  const asText = (parts: Uint8Array[]) => Buffer.concat(parts).toString('latin1');

  it('never writes readable mail to the private files, and hands out the exact bytes', async () => {
    const { opfs, handed } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    // More than one piece, so the pieces have to come back in order.
    const big = new Uint8Array(1024 * 1024 + 7).map((_, i) => i % 251);
    await sink.write(MAIL);
    await sink.write(big);
    await sink.write(big);
    const file = await sink.close();
    expect(opfs.written.length).toBeGreaterThanOrEqual(2);
    expect(asText(opfs.written)).not.toContain('secret');
    expect(asText(opfs.written)).not.toContain('plain body');
    expect(handed).toHaveLength(1);
    expect(handed[0].type).toBe('application/mbox');
    // Not toEqual: it walks 2 MB element by element.
    expect(Buffer.from(await handed[0].arrayBuffer()).equals(Buffer.concat([MAIL, big, big]))).toBe(true);
    expect(file.size).toBe(MAIL.length + 2 * big.length);
  });

  it('seals the same mail differently each time', async () => {
    const { opfs } = setUp();
    for (let i = 0; i < 2; i += 1) {
      const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
      await sink.write(MAIL);
      await sink.close();
    }
    expect(opfs.written).toHaveLength(2);
    expect(asText([opfs.written[0]])).not.toBe(asText([opfs.written[1]]));
  });

  it('deletes the spool the moment the export is done, before any download is over', async () => {
    const { opfs } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    await sink.write(MAIL);
    expect(opfs.files.size).toBe(1);
    await sink.close();
    expect(opfs.files.size).toBe(0);
  });

  it('deletes the spool when the export is cancelled', async () => {
    const { opfs } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    await sink.write(MAIL);
    await sink.abort();
    expect(opfs.files.size).toBe(0);
  });

  it('keeps the Blob while its download may still read it, and frees it after', async () => {
    const { revoke } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    await sink.write(MAIL);
    const file: ExportFile = await sink.close();
    vi.useFakeTimers();
    const gone = file.discard();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(revoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(downloadGraceMs(MAIL.length));
    await gone;
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });

  it('frees the Blob at once on sign-out', async () => {
    const { revoke } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    await sink.write(MAIL);
    await (await sink.close()).discard(true);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });

  it('leaves nothing behind when the Blob can\'t be made', async () => {
    const { opfs, handed } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    await sink.write(MAIL);
    vi.stubGlobal('Response', class { blob() { return Promise.reject(new Error('out of memory')); } });
    await expect(sink.close()).rejects.toThrow('out of memory');
    await sink.abort();
    expect(handed).toEqual([]);
    expect(opfs.files.size).toBe(0);
  });

  it('a crash leaves only sealed bytes, which the sweep at the next start deletes', async () => {
    const { opfs } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    await sink.write(MAIL.slice());
    // 1 MB forces a piece out; a crash here never reaches close or abort.
    await sink.write(new Uint8Array(1 << 20));
    expect(asText(opfs.written)).not.toContain('secret');
    expect(opfs.files.size).toBe(1);
    // The tab that held the file is gone: its lock is free again.
    await sweepPrivateExports();
    expect(opfs.files.size).toBe(0);
  });
});

describe('guardedSink', () => {
  function fakeSink(): ExportSink & { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
    return {
      kind: 'picker',
      write: vi.fn(async () => {}),
      close: vi.fn(async () => ({ name: 'x', size: 0, discard: async () => {} })),
      abort: vi.fn(async () => {}),
    };
  }

  it('passes writes through while allowed', async () => {
    const inner = fakeSink();
    const sink = guardedSink(inner, () => true);
    await sink.write(new Uint8Array(1));
    await sink.close();
    expect(inner.write).toHaveBeenCalledTimes(1);
    expect(inner.close).toHaveBeenCalledTimes(1);
  });

  it('stops a write and a close the moment the policy says no', async () => {
    const inner = fakeSink();
    const sink = guardedSink(inner, () => false);
    await expect(sink.write(new Uint8Array(1))).rejects.toBeInstanceOf(ExportForbiddenError);
    await expect(sink.close()).rejects.toBeInstanceOf(ExportForbiddenError);
    expect(inner.write).not.toHaveBeenCalled();
    expect(inner.close).not.toHaveBeenCalled();
  });
});

describe('openExportSink', () => {
  it('uses the picker where there is one, and nothing else when the user closes it', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.root }, locks: fakeLocks(new Set()) });
    vi.stubGlobal('window', { showSaveFilePicker: async () => { throw new DOMException('closed', 'AbortError'); } });
    expect(await openExportSink('a.mbox', 'application/mbox', '.mbox')).toBeNull();
    expect(opfs.files.size).toBe(0);
    vi.stubGlobal('window', { showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }) }) });
    expect((await openExportSink('a.mbox', 'application/mbox', '.mbox'))?.kind).toBe('picker');
  });

  it('goes to the spool where there is no picker', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.root }, locks: fakeLocks(new Set()) });
    expect((await openExportSink('a.mbox', 'application/mbox', '.mbox'))?.kind).toBe('private');
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
