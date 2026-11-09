import { describe, expect, it, vi } from 'vitest';

describe('isStoreUnavailableError', () => {
  it('recognises the error from another module copy, where instanceof does not', async () => {
    const first = await import('../types');
    const thrown = new first.StoreUnavailableError('down');
    vi.resetModules();
    const second = await import('../types');
    expect(thrown instanceof second.StoreUnavailableError).toBe(false);
    expect(second.isStoreUnavailableError(thrown)).toBe(true);
    expect(second.isStoreUnavailableError(new Error('other'))).toBe(false);
    expect(second.isStoreUnavailableError(null)).toBe(false);
  });
});

describe('redis store error mapping', () => {
  const reply = (message: string) => Object.assign(new Error(message), { name: 'ReplyError' });

  it('treats a full server (OOM under noeviction) and connection errors as unavailable', async () => {
    const { unavailable } = await import('../redis');
    const { isStoreUnavailableError } = await import('../types');
    for (const error of [reply('OOM command not allowed when used memory > \'maxmemory\'.'), reply('LOADING Redis is loading'), new Error('Stream isn\'t writeable')]) {
      let thrown: unknown;
      try { unavailable(error); } catch (e) { thrown = e; }
      expect(isStoreUnavailableError(thrown)).toBe(true);
    }
  });

  it('rethrows script and command errors as they are', async () => {
    const { unavailable } = await import('../redis');
    const bug = reply('ERR Error running script (call to f_x): attempt to compare nil');
    let thrown: unknown;
    try { unavailable(bug); } catch (e) { thrown = e; }
    expect(thrown).toBe(bug);
  });
});
