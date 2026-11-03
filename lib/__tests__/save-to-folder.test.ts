import { afterEach, describe, expect, it, vi } from 'vitest';
import { canPickFolder, createUniqueNamer, isPickerCancelled, saveFilesToFolder, type FolderHandle } from '@/lib/attachments/save-to-folder';

class FakeFolder implements FolderHandle {
  name = 'Downloads';
  files = new Map<string, string>();
  failWriteOf: string | null = null;
  removed: string[] = [];

  async getFileHandle(name: string, options?: { create?: boolean }) {
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
