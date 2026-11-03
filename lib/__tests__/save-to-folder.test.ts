import { afterEach, describe, expect, it, vi } from 'vitest';
import { canPickFolder, createUniqueNamer, isPickerCancelled, saveFilesToFolder, type FolderHandle } from '@/lib/attachments/save-to-folder';

class FakeFolder implements FolderHandle {
  name = 'Downloads';
  files = new Map<string, string>();
  failWriteOf: string | null = null;
  removed: string[] = [];
  refused = new Set<string>();

  async getFileHandle(name: string, options?: { create?: boolean }) {
    // What Windows and Chromium's File System Access refuse.
    const stem = name.split('.')[0].toLowerCase();
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(stem)
      || /\.(lnk|url|scf|local)$/i.test(name)
      || name.toLowerCase() === 'desktop.ini'
      || new TextEncoder().encode(name).length > 255
      || this.refused.has(name)) {
      throw new TypeError(`Name is not allowed: ${name}`);
    }
    if (!this.files.has(name)) {
      if (!options?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      this.files.set(name, '');
    }
    return {
      createWritable: async () => ({
        write: async (data: unknown) => {
          if (this.failWriteOf === name) throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' });
          this.files.set(name, String(data));
        },
        close: async () => {},
        abort: async () => {},
      }),
    };
  }

  async removeEntry(name: string) {
    this.removed.push(name);
    this.files.delete(name);
  }
}

const item = (name: string, content: string | null = name) => ({ name, read: async () => content as unknown as BufferSource | null });
const always = () => true;

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

describe('saveFilesToFolder', () => {
  it('writes each file and says how many', async () => {
    const folder = new FakeFolder();
    const result = await saveFilesToFolder(folder, [item('a.txt'), item('b.txt')], always);
    expect(result).toEqual({ folder: 'Downloads', total: 2, saved: 2, skipped: 0, stopped: null });
    expect(folder.files.get('a.txt')).toBe('a.txt');
  });

  it('gives same-named attachments their own files', async () => {
    const folder = new FakeFolder();
    await saveFilesToFolder(folder, [item('scan.pdf', 'one'), item('scan.pdf', 'two'), item('scan.pdf', 'three')], always);
    expect([...folder.files.entries()]).toEqual([['scan.pdf', 'one'], ['scan (1).pdf', 'two'], ['scan (2).pdf', 'three']]);
  });

  it('never overwrites a file already in the folder', async () => {
    const folder = new FakeFolder();
    folder.files.set('report.pdf', 'precious');
    await saveFilesToFolder(folder, [item('report.pdf', 'new')], always);
    expect(folder.files.get('report.pdf')).toBe('precious');
    expect(folder.files.get('report (1).pdf')).toBe('new');
  });

  it('stops at a failed write, keeps what is saved, and leaves no empty file', async () => {
    const folder = new FakeFolder();
    folder.failWriteOf = 'b.txt';
    const result = await saveFilesToFolder(folder, [item('a.txt'), item('b.txt'), item('c.txt')], always);
    expect(result).toMatchObject({ saved: 1, total: 3, stopped: 'write' });
    expect([...folder.files.keys()]).toEqual(['a.txt']);
    expect(folder.removed).toEqual(['b.txt']);
  });

  it('skips a file that cannot be fetched and goes on, as the zip does', async () => {
    const folder = new FakeFolder();
    const broken = { name: 'gone.bin', read: async () => { throw new Error('404'); } };
    const result = await saveFilesToFolder(folder, [item('a.txt'), broken, item('c.txt')], always);
    expect(result).toMatchObject({ saved: 2, skipped: 1, stopped: null });
  });

  it('asks the policy before every file, and a policy turning on stops the rest', async () => {
    const folder = new FakeFolder();
    let asked = 0;
    // On for the first file's two checks, then off.
    const allowed = () => ++asked <= 2;
    const read = vi.fn(async () => 'x' as unknown as BufferSource);
    const result = await saveFilesToFolder(folder, [{ name: 'a', read }, { name: 'b', read }], allowed);
    expect(result).toMatchObject({ saved: 1, stopped: 'policy' });
    expect(read).toHaveBeenCalledTimes(1);
    expect([...folder.files.keys()]).toEqual(['a']);
  });

  it('writes nothing fetched while the policy turned on', async () => {
    const folder = new FakeFolder();
    let on = true;
    const read = vi.fn(async () => { on = false; return 'x' as unknown as BufferSource; });
    const result = await saveFilesToFolder(folder, [{ name: 'a', read }], () => on);
    expect(result).toMatchObject({ saved: 0, stopped: 'policy' });
    expect(folder.files.size).toBe(0);
  });

  it('keeps a sender\'s path out of the file name', async () => {
    const folder = new FakeFolder();
    await saveFilesToFolder(folder, [item('../../evil.exe'), item('C:\\Windows\\win.ini'), item('a:b?.txt'), item('...')], always);
    expect([...folder.files.keys()]).toEqual(['evil.exe', 'win.ini', 'a_b_.txt', 'attachment']);
  });
});

describe('names a file system or the shell keeps for itself', () => {
  it('renames them, so the attachment is still saved', async () => {
    const folder = new FakeFolder();
    const names = ['CON', 'NUL.txt', 'com1.tar.gz', 'desktop.ini', 'x.lnk', 'x.url', 'x.scf', 'X.LNK'];
    const result = await saveFilesToFolder(folder, names.map((name) => item(name)), always);
    expect(result).toMatchObject({ saved: names.length, skipped: 0, stopped: null });
    expect([...folder.files.keys()]).toEqual(['_CON', '_NUL.txt', '_com1.tar.gz', '_desktop.ini', 'x.lnk.txt', 'x.url.txt', 'x.scf.txt', 'X.LNK.txt']);
  });

  it('leaves names that only look like them', async () => {
    const folder = new FakeFolder();
    await saveFilesToFolder(folder, ['context.txt', 'console.log', 'nullable.ts', 'lnk.pdf'].map((name) => item(name)), always);
    expect([...folder.files.keys()]).toEqual(['context.txt', 'console.log', 'nullable.ts', 'lnk.pdf']);
  });

  it('shortens a name over the limit, in bytes, keeping the extension and whole characters', async () => {
    const folder = new FakeFolder();
    const long = `${'ü'.repeat(200)}.pdf`;
    const result = await saveFilesToFolder(folder, [item(long), item(long)], always);
    expect(result.saved).toBe(2);
    const [first, second] = [...folder.files.keys()];
    expect(first.endsWith('.pdf')).toBe(true);
    expect(first).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(first).length).toBeLessThanOrEqual(255);
    expect(new TextEncoder().encode(second).length).toBeLessThanOrEqual(255);
    expect(second.endsWith(' (1).pdf')).toBe(true);
  });

  it('skips one name the folder still refuses and goes on to the rest', async () => {
    const folder = new FakeFolder();
    folder.refused.add('odd.bin');
    const result = await saveFilesToFolder(folder, [item('a.txt'), item('odd.bin'), item('c.txt')], always);
    expect(result).toMatchObject({ saved: 2, skipped: 1, stopped: null });
    expect([...folder.files.keys()]).toEqual(['a.txt', 'c.txt']);
  });
});

describe('the helpers', () => {
  it('sees the picker only where the browser has it', () => {
    expect(canPickFolder()).toBe(false);
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = () => {};
    expect(canPickFolder()).toBe(true);
  });

  it('tells a closed picker from a failure', () => {
    expect(isPickerCancelled(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isPickerCancelled(Object.assign(new Error('x'), { name: 'SecurityError' }))).toBe(false);
    expect(isPickerCancelled(null)).toBe(false);
  });

  it('numbers zip entries like before', () => {
    const name = createUniqueNamer();
    expect(['a.txt', 'a.txt', 'a.txt', '', ''].map(name)).toEqual(['a.txt', 'a (1).txt', 'a (2).txt', 'attachment', 'attachment (1)']);
  });
});
