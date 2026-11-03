import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { registerComposeFlush } from '@/lib/compose-flush-registry';
import { openPopoutChannel, type PopoutMessage } from '../channel';
import { answerWhenComposerOpens, dropReturnedComposer, offerReturnedComposer, onReturnedComposer, onReturnedComposerElsewhere, returnComposerToMain, takeReturnedComposer } from '../return-to-main';

// The way a composer goes back from its own window. The window lets go of its text only when
// the main window says the composer is there, so every other outcome has to say so too.

const PAYLOAD = { mode: 'compose' as const, initialData: { subject: 'Hello' } as never };

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  FakeBroadcastChannel.reset();
});

afterEach(() => {
  takeReturnedComposer();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Plays the main window's end of the channel. */
function mainWindow(onReturn: (message: Extract<PopoutMessage, { type: 'composer-return' }>, post: (m: PopoutMessage) => void) => void) {
  const heard: PopoutMessage[] = [];
  const channel = openPopoutChannel((message) => {
    heard.push(message);
    if (message.type === 'composer-return') onReturn(message, (m) => channel?.post(m));
  });
  return heard;
}

describe('from the pop-out', () => {
  it('sends the draft and its login, and goes by what the main window answers', async () => {
    const seen: unknown[] = [];
    mainWindow((message, post) => {
      seen.push([message.accountId, message.payload]);
      post({ type: 'composer-return-answer', returnId: message.returnId, status: 'shown' });
    });
    await expect(returnComposerToMain(PAYLOAD, 'alice')).resolves.toBe('shown');
    expect(seen).toEqual([['alice', PAYLOAD]]);
  });

  it('hears that the main window is busy', async () => {
    mainWindow((message, post) => post({ type: 'composer-return-answer', returnId: message.returnId, status: 'busy' }));
    await expect(returnComposerToMain(PAYLOAD, 'alice')).resolves.toBe('busy');
  });

  it('ignores an answer about another composer', async () => {
    mainWindow((_message, post) => post({ type: 'composer-return-answer', returnId: 'someone-else', status: 'shown' }));
    await expect(returnComposerToMain(PAYLOAD, 'alice', 60)).resolves.toBe('no-answer');
  });

  it('with no answer it keeps the text and calls the move off, so no second copy turns up', async () => {
    const heard = mainWindow(() => {});
    await expect(returnComposerToMain(PAYLOAD, 'alice', 30)).resolves.toBe('no-answer');
    await vi.waitFor(() => expect(heard.map((message) => message.type)).toEqual(['composer-return', 'composer-return-cancel']));
  });
});

describe('in the main window', () => {
  const returned = (id: string, answer = vi.fn()) => ({ returnId: id, payload: PAYLOAD, answer });

  it('tells the mail page, and only the mail page, when it is there', () => {
    const mail = vi.fn();
    const elsewhere = vi.fn();
    const stops = [onReturnedComposer(mail), onReturnedComposerElsewhere(elsewhere)];
    offerReturnedComposer(returned('a'));
    expect(mail).toHaveBeenCalledOnce();
    expect(elsewhere).not.toHaveBeenCalled();
    for (const stop of stops) stop();
  });

  it('with no mail page it asks for one, and the composer waits for the page to mount', () => {
    const elsewhere = vi.fn();
    const stop = onReturnedComposerElsewhere(elsewhere);
    offerReturnedComposer(returned('a'));
    expect(elsewhere).toHaveBeenCalledOnce();
    expect(takeReturnedComposer()?.returnId).toBe('a');
    expect(takeReturnedComposer()).toBeNull();
    stop();
  });

  it('a second one while the first waits is told busy and takes nothing over', () => {
    const second = vi.fn();
    offerReturnedComposer(returned('a'));
    offerReturnedComposer(returned('b', second));
    expect(second).toHaveBeenCalledWith('busy');
    expect(takeReturnedComposer()?.returnId).toBe('a');
  });

  it('forgets one the pop-out gave up on, and no other', () => {
    offerReturnedComposer(returned('a'));
    dropReturnedComposer('b');
    expect(takeReturnedComposer()?.returnId).toBe('a');
    offerReturnedComposer(returned('c'));
    dropReturnedComposer('c');
    expect(takeReturnedComposer()).toBeNull();
  });

  it('says shown only when a composer has really opened', () => {
    const answer = vi.fn();
    answerWhenComposerOpens(returned('a', answer));
    expect(answer).not.toHaveBeenCalled();
    const stop = registerComposeFlush(async () => {});
    expect(answer).toHaveBeenCalledWith('shown');
    stop();
  });

  it('says nothing if no composer opens, so the pop-out stays with the text', () => {
    vi.useFakeTimers();
    const answer = vi.fn();
    answerWhenComposerOpens(returned('a', answer), 100);
    vi.advanceTimersByTime(200);
    const stop = registerComposeFlush(async () => {});
    expect(answer).not.toHaveBeenCalled();
    stop();
  });
});
