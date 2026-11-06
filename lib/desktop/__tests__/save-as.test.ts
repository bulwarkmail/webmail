import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeSaveAvailable, saveMessagesNatively } from '../save-as';

// File > Save as… in the desktop app: the shell asks where first, on the click, and the
// bytes follow one file at a time (src/main/features/os-save-open.ts in the desktop repo).

function fakeShell(begin: unknown) {
  const calls: string[] = [];
  const written: { index: number; text: string }[] = [];
  const saveAs = {
    begin: vi.fn(async (request: { names: string[] }) => {
      calls.push(`begin:${request.names.join(',')}`);
      return begin;
    }),
    write: vi.fn(async (_id: string, index: number, data: Uint8Array) => {
      calls.push(`write:${index}`);
      written.push({ index, text: new TextDecoder().decode(data) });
      return true;
    }),
    end: vi.fn(async () => {
      calls.push('end');
      return { saved: written.length, failed: 0 };
    }),
  };
  window.bulwarkDesktop = { version: 1, platform: 'win32', saveAs } as never;
  return { saveAs, calls, written };
}

afterEach(() => {
  delete window.bulwarkDesktop;
});

describe('saving messages through the desktop app', () => {
  it('does nothing in a browser, where the caller downloads', async () => {
    expect(nativeSaveAvailable()).toBe(false);
    expect(await saveMessagesNatively([{ name: 'a.eml', load: async () => new Uint8Array() }])).toBeNull();
  });

  it('asks where before it fetches anything, then hands over each file in order', async () => {
    const { calls, written } = fakeShell({ id: 's1' });
    expect(nativeSaveAvailable()).toBe(true);
    const load = (text: string) => async () => {
      calls.push(`load:${text}`);
      return new Blob([text]);
    };
    const outcome = await saveMessagesNatively([{ name: 'One.eml', load: load('one') }, { name: 'Two.eml', load: load('two') }]);
    expect(calls).toEqual(['begin:One.eml,Two.eml', 'load:one', 'write:0', 'load:two', 'write:1', 'end']);
    expect(written).toEqual([{ index: 0, text: 'one' }, { index: 1, text: 'two' }]);
    expect(outcome).toEqual({ status: 'saved', saved: 2, failed: 0 });
  });

  it('fetches nothing when the user cancels or the shell says no', async () => {
    const load = vi.fn(async () => new Uint8Array([1]));
    fakeShell({ cancelled: true });
    expect(await saveMessagesNatively([{ name: 'a.eml', load }])).toEqual({ status: 'cancelled' });
    const { saveAs } = fakeShell({ refused: 'policy' });
    expect(await saveMessagesNatively([{ name: 'a.eml', load }])).toEqual({ status: 'refused', reason: 'policy' });
    expect(load).not.toHaveBeenCalled();
    expect(saveAs.write).not.toHaveBeenCalled();
  });

  it('goes on past a message that could not be fetched, and still ends the save', async () => {
    const { saveAs, written } = fakeShell({ id: 's2' });
    saveAs.end.mockResolvedValueOnce({ saved: 1, failed: 1 });
    const outcome = await saveMessagesNatively([
      { name: 'Gone.eml', load: async () => { throw new Error('404'); } },
      { name: 'Here.eml', load: async () => new TextEncoder().encode('here') },
    ]);
    expect(written).toEqual([{ index: 1, text: 'here' }]);
    expect(saveAs.end).toHaveBeenCalledWith('s2');
    expect(outcome).toEqual({ status: 'saved', saved: 1, failed: 1 });
  });
});
