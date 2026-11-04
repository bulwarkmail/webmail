import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { registerComposeFlush } from '@/lib/compose-flush-registry';
import { openPopoutChannel, type PopoutMessage } from '../channel';
import { answerWhenComposerOpens, commitReturnedComposer, dropReturnedComposer, offerReturnedComposer, onReturnedComposer, onReturnedComposerElsewhere, returnComposerToMain, takeReturnedComposer } from '../return-to-main';

// The way a composer goes back from its own window. The window lets go of its text only when
// the main window says the composer is there, and at no moment may both windows hold it.

const PAYLOAD = { mode: 'compose' as const, initialData: { subject: 'Hello' } as never };
const alive = () => true;

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
function mainWindow(onMessage: (message: PopoutMessage, post: (m: PopoutMessage) => void) => void) {
  const heard: PopoutMessage[] = [];
  const channel = openPopoutChannel((message) => {
    heard.push(message);
    onMessage(message, (m) => channel?.post(m));
  });
  return heard;
}

describe('from the pop-out', () => {
  it('sends the draft and its login, commits when the main window is ready, and goes by its answer', async () => {
    const seen: unknown[] = [];
    const heard = mainWindow((message, post) => {
      if (message.type === 'composer-return') {
        seen.push([message.accountId, message.payload]);
        post({ type: 'composer-return-ready', returnId: message.returnId });
      }
      if (message.type === 'composer-return-commit') post({ type: 'composer-return-answer', returnId: message.returnId, status: 'shown' });
    });
    await expect(returnComposerToMain(PAYLOAD, 'alice', alive)).resolves.toBe('shown');
    expect(seen).toEqual([['alice', PAYLOAD]]);
    expect(heard.map((message) => message.type)).toEqual(['composer-return', 'composer-return-commit']);
  });

  it('hears that the main window is busy', async () => {
    mainWindow((message, post) => {
      if (message.type === 'composer-return') post({ type: 'composer-return-answer', returnId: message.returnId, status: 'busy' });
    });
    await expect(returnComposerToMain(PAYLOAD, 'alice', alive)).resolves.toBe('busy');
  });

  it('ignores what is said about another composer', async () => {
    const heard = mainWindow((message, post) => {
      if (message.type !== 'composer-return') return;
      post({ type: 'composer-return-answer', returnId: 'someone-else', status: 'shown' });
      post({ type: 'composer-return-ready', returnId: 'someone-else' });
    });
    await expect(returnComposerToMain(PAYLOAD, 'alice', alive, 60)).resolves.toBe('no-answer');
    expect(heard.map((message) => message.type)).not.toContain('composer-return-commit');
  });

  it('with no answer it keeps the text and calls the move off, so no second copy turns up', async () => {
    const heard = mainWindow(() => {});
    await expect(returnComposerToMain(PAYLOAD, 'alice', alive, 30)).resolves.toBe('no-answer');
    await vi.waitFor(() => expect(heard.map((message) => message.type)).toEqual(['composer-return', 'composer-return-cancel']));
  });

  it('once committed it doesn\'t give up on a slow main window, which has the text by then', async () => {
    let answer: (() => void) | null = null;
    mainWindow((message, post) => {
      if (message.type === 'composer-return') post({ type: 'composer-return-ready', returnId: message.returnId });
      if (message.type === 'composer-return-commit') answer = () => post({ type: 'composer-return-answer', returnId: message.returnId, status: 'shown' });
    });
    const result = returnComposerToMain(PAYLOAD, 'alice', alive, 30);
    let settled = false;
    void result.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(settled).toBe(false);
    expect(answer).not.toBeNull();
    answer!();
    await expect(result).resolves.toBe('shown');
  });

  it('once committed it keeps the text if the main window goes away', async () => {
    mainWindow((message, post) => {
      if (message.type === 'composer-return') post({ type: 'composer-return-ready', returnId: message.returnId });
    });
    let there = true;
    const result = returnComposerToMain(PAYLOAD, 'alice', () => there, 30);
    await new Promise((resolve) => setTimeout(resolve, 60));
    there = false;
    await expect(result).resolves.toBe('no-answer');
  });
});

describe('in the main window', () => {
  const returned = (id: string, answer = vi.fn(), sendReady = vi.fn()) => ({ returnId: id, payload: PAYLOAD, answer, sendReady });

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

  it('claiming asks the pop-out, and only its go ahead lets the page open anything', async () => {
    const sendReady = vi.fn();
    offerReturnedComposer(returned('a', vi.fn(), sendReady));
    const taken = takeReturnedComposer()!;
    expect(sendReady).not.toHaveBeenCalled();
    const claim = taken.claim();
    expect(sendReady).toHaveBeenCalledOnce();
    commitReturnedComposer('a');
    await expect(claim).resolves.toBe(true);
  });

  it('a pop-out that gave up as the page took it wins: nothing opens here', async () => {
    offerReturnedComposer(returned('a'));
    const taken = takeReturnedComposer()!;
    const claim = taken.claim();
    dropReturnedComposer('a');
    await expect(claim).resolves.toBe(false);
  });

  it('silence after asking means no', async () => {
    vi.useFakeTimers();
    offerReturnedComposer(returned('a'));
    const claim = takeReturnedComposer()!.claim();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(claim).resolves.toBe(false);
  });

  it('says shown only when a composer has really opened', () => {
    const answer = vi.fn();
    answerWhenComposerOpens({ returnId: 'a', payload: PAYLOAD, answer, claim: async () => true });
    expect(answer).not.toHaveBeenCalled();
    const stop = registerComposeFlush(async () => {});
    expect(answer).toHaveBeenCalledWith('shown');
    stop();
  });
});
