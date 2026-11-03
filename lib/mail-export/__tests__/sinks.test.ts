// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { blobHeldInMemory, canWritePrivateFile, downloadGraceMs, dropExportFiles, guardedSink, memorySink, openExportSink, pickSaveFile, privateFileSink, spoolLimit, sweepPrivateExports, ExportForbiddenError, ExportTooLargeError, SPOOL_MEMORY_LIMIT, type ExportFile, type ExportSink } from '@/lib/mail-export/sinks';
import { ZipWriter } from '@/lib/mail-export/zip-writer';
import { useMailTransferStore } from '@/stores/mail-transfer-store';

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

  it('never lets a ZIP through readable either, where a search for the text would find nothing', async () => {
    const { opfs, handed } = setUp();
    const sink = (await privateFileSink('a.zip', 'application/zip'))!;
    const zip = new ZipWriter((chunk) => sink.write(chunk));
    await zip.addFile('Inbox/1.eml', MAIL, new Date());
    await zip.finish();
    await sink.close();
    const asZip = (await import('@/lib/mail-import/zip-reader')).listZipEntries;
    expect(asText(opfs.written)).not.toContain('PK\x03\x04');
    expect(asText(opfs.written)).not.toContain('Inbox/1.eml');
    await expect(asZip(new Blob(opfs.written as BlobPart[]))).rejects.toThrow();
    expect((await asZip(handed[0])).map((entry) => entry.name)).toEqual(['Inbox/1.eml']);
  });

  it('downloads nothing when stopped while the spool is being opened, and leaves no Blob', async () => {
    const { opfs, handed } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    // Three pieces: a large spool must stop where it is, not be opened to the end first.
    for (let i = 0; i < 3; i += 1) await sink.write(new Uint8Array(1 << 20));
    expect(opfs.written.length).toBe(3);
    const controller = new AbortController();
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
      controller.abort();
      return decrypt(...args);
    });
    await expect(sink.close(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    // A stream reads one piece ahead at most before it hears the abort.
    expect(spy.mock.calls.length).toBeLessThan(3);
    spy.mockRestore();
    expect(handed).toEqual([]);
    await sink.abort();
    expect(opfs.files.size).toBe(0);
  });

  it('downloads nothing when stopped just as the Blob is ready', async () => {
    const { handed } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    await sink.write(MAIL);
    const controller = new AbortController();
    vi.stubGlobal('Response', class { blob() { controller.abort(); return Promise.resolve(new Blob(['x'])); } });
    await expect(sink.close(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(handed).toEqual([]);
  });

  it('stops at its limit while writing, and the spool goes', async () => {
    const { opfs } = setUp();
    const sink = (await privateFileSink('a.mbox', 'application/mbox', 10))!;
    await sink.write(new Uint8Array(10));
    await expect(sink.write(new Uint8Array(1))).rejects.toBeInstanceOf(ExportTooLargeError);
    await sink.abort();
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

describe('where the final Blob sits in memory', () => {
  const AGENTS: [string, string, boolean][] = [
    ['Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', true],
    ['Chrome on iOS, which is WebKit', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1', true],
    ['Firefox on iOS, which is WebKit', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15', true],
    ['Chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36', false],
    ['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0', false],
    ['Firefox', 'Mozilla/5.0 (Windows NT 10.0; rv:148.0) Gecko/20100101 Firefox/148.0', false],
    ['the desktop app', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Electron/40.0.0 Safari/537.36', false],
  ];

  it.each(AGENTS)('%s', (_name, userAgent, inMemory) => {
    vi.stubGlobal('navigator', { userAgent });
    expect(blobHeldInMemory()).toBe(inMemory);
    expect(spoolLimit()).toBe(inMemory ? SPOOL_MEMORY_LIMIT : Infinity);
  });

  it('a spool on such an engine takes the cap by default', async () => {
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { userAgent: AGENTS[0][1], storage: { getDirectory: async () => opfs.root }, locks: fakeLocks(new Set()) });
    const sink = (await privateFileSink('a.mbox', 'application/mbox'))!;
    // Nothing this size is allocated: the check is on the length it is told.
    const huge = { length: SPOOL_MEMORY_LIMIT + 1 } as Uint8Array;
    await expect(sink.write(huge)).rejects.toMatchObject({ name: 'ExportTooLargeError', limit: SPOOL_MEMORY_LIMIT });
  });
});

describe('a finished export held for its download', () => {
  function stubUrls() {
    // What earlier tests left held.
    dropExportFiles('all');
    const revoke = vi.fn();
    let n = 0;
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:${++n}`, revokeObjectURL: revoke }));
    return revoke;
  }

  async function finished(scope: string) {
    useMailTransferStore.setState({ job: { kind: 'export', scope, controller: new AbortController(), progress: { phase: 'running', exported: 0, failed: 0, failures: [], total: 0, fraction: 0 } } });
    const sink = memorySink('a.mbox', 'application/mbox');
    await sink.write(new Uint8Array(3));
    const file = await sink.close();
    useMailTransferStore.setState({ job: null });
    return file;
  }

  it('goes at a sign-out of its account while it waits out the grace period, with the dialog closed', async () => {
    const revoke = stubUrls();
    vi.useFakeTimers();
    const file = await finished('acc');
    void file.discard();
    expect(revoke).not.toHaveBeenCalled();
    dropExportFiles('someone-else');
    expect(revoke).not.toHaveBeenCalled();
    dropExportFiles('acc');
    expect(revoke).toHaveBeenCalledTimes(1);
    // Nothing to do when the wait ends.
    await vi.advanceTimersByTimeAsync(downloadGraceMs(3));
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('goes when everything goes', async () => {
    const revoke = stubUrls();
    await finished('acc');
    const opfs = fakeOpfs();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.root } });
    await sweepPrivateExports({ force: true });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('can\'t be downloaded once it has gone', async () => {
    stubUrls();
    const anchors: string[] = [];
    vi.stubGlobal('document', { createElement: () => ({ click() { anchors.push('clicked'); }, remove() {} }), body: { appendChild() {} } });
    const file = await finished('acc');
    expect(anchors).toEqual(['clicked']);
    dropExportFiles('acc');
    file.download?.();
    expect(anchors).toEqual(['clicked']);
  });
});

describe('the file the user picked', () => {
  function picked(handle: Record<string, unknown>) {
    const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    vi.stubGlobal('window', { showSaveFilePicker: async () => ({ createWritable: async () => writable, ...handle }) });
    return writable;
  }

  it('is removed on an abort where the browser can', async () => {
    const remove = vi.fn(async () => {});
    const writable = picked({ remove });
    const sink = await pickSaveFile('a.mbox', 'application/mbox', '.mbox');
    expect(await sink.abort()).toEqual({});
    expect(writable.abort).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  });

  it('says so where it can\'t be removed', async () => {
    picked({});
    expect(await (await pickSaveFile('a.mbox', 'application/mbox', '.mbox')).abort()).toEqual({ leftover: 'a.mbox' });
    picked({ remove: async () => { throw new Error('no'); } });
    expect(await (await pickSaveFile('a.mbox', 'application/mbox', '.mbox')).abort()).toEqual({ leftover: 'a.mbox' });
  });

  it('names the file as the person named it', async () => {
    picked({ name: 'my backup.mbox' });
    expect(await (await pickSaveFile('a.mbox', 'application/mbox', '.mbox')).abort()).toEqual({ leftover: 'my backup.mbox' });
  });

  it('isn\'t finished when stopped first', async () => {
    const writable = picked({});
    const sink = await pickSaveFile('a.mbox', 'application/mbox', '.mbox');
    const controller = new AbortController();
    controller.abort();
    await expect(sink.close(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(writable.close).not.toHaveBeenCalled();
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
