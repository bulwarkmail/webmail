import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastWithUndo, undoMoveAction } from '../email-action-toast';
import { clearUndoHistory, recordUndo, undoHistory, undoLatest } from '../undo-history';
import { resetUndoDeck } from '../undo-deck';
import { useToastStore } from '@/stores/toast-store';
import { useEmailStore, type EmailRestoreBatch } from '@/stores/email-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const labels = { undo: 'Undo', done: 'Moved back', failed: "Couldn't undo" };
const client = {} as IJMAPClient;
const toasts = () => useToastStore.getState().toasts;
const front = () => toasts()[0];
const undoMove = () => useEmailStore.getState().undoMove as unknown as ReturnType<typeof vi.fn>;
let seq = 0;
const point = (id: string) => ({ id, mailboxIds: { inbox: true }, seen: true });
const mail = (subject?: string): EmailRestoreBatch[] => {
  const id = `e${++seq}`;
  return [{ client, points: [point(id)], messages: { [id]: { key: id, subject } } }];
};
const act = (title: string, subject?: string) => toastWithUndo(title, undoMoveAction(client, mail(subject), labels));
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  clearUndoHistory();
  resetUndoDeck();
  useToastStore.setState({ toasts: [] });
  useEmailStore.setState({ undoMove: vi.fn().mockResolvedValue(undefined) as never });
});

describe('the undo deck', () => {
  it('stacks a run of actions into one card, the newest in front, the rest behind it', () => {
    for (let i = 1; i <= 12; i++) act(`Archived ${i}`);

    expect(toasts()).toHaveLength(1);
    expect(front().title).toBe('Archived 12');
    expect(front().action?.label).toBe('Undo');
    expect(front().behind?.map((c) => c.title)).toEqual(['Archived 11', 'Archived 10', 'Archived 9', 'Archived 8', 'Archived 7', 'Archived 6', 'Archived 5', 'Archived 4', 'Archived 3']);
    expect(undoHistory()).toHaveLength(10);
  });

  it('brings the action before forward when Undo is used, and keeps the card up', async () => {
    act('Archived');
    act('Deleted');

    front().action!.onClick();
    await settle();

    expect(undoMove()).toHaveBeenCalledTimes(1);
    expect(toasts().map((t) => t.title)).toEqual(['Archived']);
    expect(front().behind ?? []).toHaveLength(0);
  });

  it('keeps the card open on Undo while there is an action behind it, and lets it close on the last', () => {
    act('Archived');
    act('Deleted');

    expect(front().action?.keepOpen).toBe(true);
    front().action!.onClick();
    expect(front().action?.keepOpen).toBeFalsy();
  });

  it('walks the deck back the same way with Ctrl+Z', async () => {
    act('Archived');
    act('Moved to Receipts');
    act('Deleted');

    undoLatest();
    await settle();
    expect(toasts().map((t) => t.title)).toEqual(['Moved to Receipts']);
    expect(front().behind).toHaveLength(1);

    undoLatest();
    await settle();
    expect(toasts().map((t) => t.title)).toEqual(['Archived']);
  });

  it('undoes a card from inside the deck and leaves the others where they are', async () => {
    act('Archived 1');
    act('Archived 2');
    act('Archived 3');

    front().behind![0].action.onClick();
    await settle();

    expect(undoMove()).toHaveBeenCalledTimes(1);
    expect(front().title).toBe('Archived 3');
    expect(front().behind?.map((c) => c.title)).toEqual(['Archived 1']);
    expect(undoHistory().map((e) => e.label)).toEqual(['Archived 1', 'Archived 3']);
    expect(toasts()).toHaveLength(1);
  });

  it('names the message each card is about', () => {
    act('Archived', 'Lunch tomorrow?');
    act('Deleted', 'Lunch tomorrow?');

    expect(front().message).toBe('Lunch tomorrow?');
    expect(front().behind?.[0].message).toBe('Lunch tomorrow?');
  });

  it('names a conversation by its subject when its replies carry Re: and Fwd:', () => {
    const subjects: Record<string, string> = { m1: 'Sprint priorities', m2: 'Re: Sprint priorities', m3: 'RE: Fwd: Sprint priorities' };
    const thread: EmailRestoreBatch[] = [{ client, points: ['m1', 'm2', 'm3'].map(point), messages: Object.fromEntries(Object.entries(subjects).map(([id, subject]) => [id, { key: id, subject }])) }];
    toastWithUndo('Archived', undoMoveAction(client, thread, labels));

    expect(front().message).toBe('Sprint priorities');
  });

  it('names no message when the action took several different ones', () => {
    const two: EmailRestoreBatch[] = [{ client, points: ['m1', 'm2'].map(point), messages: { m1: { key: 'm1', subject: 'Lunch' }, m2: { key: 'm2', subject: 'Invoice' } } }];
    toastWithUndo('2 conversations archived', undoMoveAction(client, two, labels));

    expect(front().message).toBeUndefined();
  });

  it('names each card by its own message when two accounts use the same message id', () => {
    const fromA: EmailRestoreBatch[] = [{ client, accountId: 'a', points: [point('k1')], messages: { k1: { key: 'me/a:k1', subject: 'Lunch' } } }];
    const fromB: EmailRestoreBatch[] = [{ client, accountId: 'b', points: [point('k1')], messages: { k1: { key: 'me/b:k1', subject: 'Invoice' } } }];
    toastWithUndo('Archived', undoMoveAction(client, fromA, labels));
    toastWithUndo('Archived', undoMoveAction(client, fromB, labels));

    expect(front().message).toBe('Invoice');
    expect(front().behind?.[0].message).toBe('Lunch');
  });

  it('keeps the card of another account\'s message that happens to have the same id', async () => {
    const fromA: EmailRestoreBatch[] = [{ client, accountId: 'a', points: [point('k1')], messages: { k1: { key: 'me/a:k1' } } }];
    const fromB: EmailRestoreBatch[] = [{ client, accountId: 'b', points: [point('k1')], messages: { k1: { key: 'me/b:k1' } } }];
    toastWithUndo('Archived A', undoMoveAction(client, fromA, labels));
    toastWithUndo('Archived B', undoMoveAction(client, fromB, labels));

    front().behind![0].action.onClick();
    await settle();

    expect(undoHistory().map((e) => e.label)).toEqual(['Archived B']);
  });

  it('drops a later card for the same message once an earlier one is undone, so it cannot bring the undone action back', async () => {
    const same: EmailRestoreBatch[] = [{ client, points: [point('x1')], messages: { x1: { key: 'x1' } } }];
    toastWithUndo('Archived', undoMoveAction(client, same, labels));
    toastWithUndo('Moved to Trash', undoMoveAction(client, same, labels));
    act('Archived other');

    front().behind!.find((c) => c.title === 'Archived')!.action.onClick();
    await settle();

    expect(undoMove()).toHaveBeenCalledTimes(1);
    expect(undoHistory().map((e) => e.label)).toEqual(['Archived other']);
    expect(front().title).toBe('Archived other');
    expect(front().behind ?? []).toHaveLength(0);
  });

  it('starts a new card instead of joining a deck that is already on its way out', () => {
    act('Archived 1');
    const leaving = front().id;
    front().onLeave?.();
    act('Archived 2');

    expect(toasts().map((t) => t.title)).toEqual(['Archived 2']);
    expect(front().id).not.toBe(leaving);
  });

  it('takes a card away when its action falls out of the undo history', () => {
    act('Archived');
    for (let i = 0; i < 10; i++) recordUndo('Starred', () => {});
    expect(toasts()).toHaveLength(0);

    act('Archived again');
    clearUndoHistory();
    expect(toasts()).toHaveLength(0);
  });

  it('starts the countdown again for each card that comes to the front', () => {
    act('Archived');
    const first = front().revision;
    act('Deleted');
    const second = front().revision;
    front().action!.onClick();

    expect(second).not.toBe(first);
    expect(front().revision).not.toBe(second);
  });

  it('says the last one was put back once the deck is empty', async () => {
    act('Archived');

    undoLatest();
    await settle();

    expect(toasts().map((t) => t.title)).toEqual(['Moved back']);
  });

  it('starts a new deck after the last one went, while Ctrl+Z still reaches the older actions', async () => {
    act('Archived 1');
    act('Archived 2');
    useToastStore.getState().removeToast(front().id);

    act('Archived 3');
    expect(front().behind ?? []).toHaveLength(0);

    undoLatest();
    await settle();
    undoLatest();
    await settle();

    expect(undoMove()).toHaveBeenCalledTimes(2);
    expect(toasts().map((t) => t.title)).toEqual(['Moved back']);
  });
});
