import { afterEach, describe, expect, it } from 'vitest';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { beginComposeTakeover, composeTakeoverOptions, endComposeTakeover, resetComposeTakeovers } from '../compose-takeover';

// The header options the composer registers with a takeover, as a raw send
// from the plugin that runs it reads them back.

const OPTIONS = { replyTo: [{ name: 'Team', email: 'team@example.org' }], readReceiptTo: 'ann@example.com', priority: 'high' as const };

/** What `read` returns while the handler of `pluginId` runs the takeover. */
async function during<T>(pluginId: string, read: () => T): Promise<T> {
  let seen: T | undefined;
  emailHooks.onComposeSend.register(pluginId, () => {
    seen = read();
    return false;
  });
  await emailHooks.onComposeSend.takeOver({} as never);
  clearAllHooks();
  return seen as T;
}

afterEach(() => {
  clearAllHooks();
  resetComposeTakeovers();
});

describe('the options of a composer send', () => {
  it('go to the plugin that runs the takeover, for the identity it was opened for', async () => {
    beginComposeTakeover('i1', OPTIONS);
    expect(await during('smime', () => [
      composeTakeoverOptions('smime', 'i1'),
      composeTakeoverOptions('other', 'i1'),
      composeTakeoverOptions('smime', 'i2'),
    ])).toEqual([OPTIONS, null, null]);
  });

  it('are gone outside the takeover and after it ended', async () => {
    const token = beginComposeTakeover('i1', OPTIONS);
    expect(composeTakeoverOptions('smime', 'i1')).toBeNull();
    endComposeTakeover(token);
    expect(await during('smime', () => composeTakeoverOptions('smime', 'i1'))).toBeNull();
  });

  it('are empty for a takeover opened without any', async () => {
    beginComposeTakeover('i1');
    expect(await during('smime', () => composeTakeoverOptions('smime', 'i1'))).toEqual({});
  });

  it('match an identity of another signed-in account by its own id', async () => {
    beginComposeTakeover('acct-2::i1', OPTIONS);
    expect(await during('smime', () => composeTakeoverOptions('smime', 'i1'))).toEqual(OPTIONS);
  });

  it('count for two sends of one identity at once only when they agree', async () => {
    beginComposeTakeover('i1', OPTIONS);
    beginComposeTakeover('i1', { ...OPTIONS });
    expect(await during('smime', () => composeTakeoverOptions('smime', 'i1'))).toEqual(OPTIONS);
    beginComposeTakeover('i1', { ...OPTIONS, priority: 'low' });
    expect(await during('smime', () => composeTakeoverOptions('smime', 'i1'))).toBeNull();
  });
});
