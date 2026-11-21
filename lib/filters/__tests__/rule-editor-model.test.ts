import { describe, it, expect } from 'vitest';
import type { FilterAction } from '@/lib/jmap/sieve-types';
import {
  blockedActions,
  checklistFromActions,
  checklistToActions,
  checklistProblem,
  emptyChecklist,
  forwardAddresses,
  parseSize,
  formatSize,
} from '../rule-editor-model';

describe('rule editor checklist', () => {
  it('ticking Mark read and Move gives both actions, the flag before the move', () => {
    const state = emptyChecklist();
    state.move = { on: true, mailboxId: 'mb-1', value: 'Receipts' };
    state.markRead = true;
    expect(checklistToActions(state)).toEqual([
      { type: 'mark_read' },
      { type: 'move', mailboxId: 'mb-1', value: 'Receipts' },
    ]);
  });

  it('an existing rule opens with its actions ticked and saves back the same actions', () => {
    const actions: FilterAction[] = [
      { type: 'mark_read' },
      { type: 'star' },
      { type: 'add_label', value: 'work' },
      { type: 'add_label', value: 'bills' },
      { type: 'copy', mailboxId: 'mb-2', value: 'Archive' },
      { type: 'move', mailboxId: 'mb-1', value: 'Receipts' },
      { type: 'forward', value: 'a@x.com', keepCopy: true },
      { type: 'forward', value: 'b@x.com', keepCopy: true },
    ];
    const state = checklistFromActions(actions);
    expect(state.markRead).toBe(true);
    expect(state.star).toBe(true);
    expect(state.tag).toEqual({ on: true, ids: ['work', 'bills'] });
    expect(state.forward).toEqual({ on: true, to: 'a@x.com, b@x.com', keepCopy: true });
    expect(checklistToActions(state)).toEqual(actions);
  });

  it('keeps what the checklist cannot show, such as a second folder to move to', () => {
    const actions: FilterAction[] = [
      { type: 'move', mailboxId: 'mb-1', value: 'A' },
      { type: 'move', mailboxId: 'mb-2', value: 'B' },
    ];
    expect(checklistToActions(checklistFromActions(actions))).toEqual(actions);
  });

  it('remembers a value while its box is unticked, and leaves it out of the rule', () => {
    const state = checklistFromActions([{ type: 'move', mailboxId: 'mb-1', value: 'A' }, { type: 'mark_read' }]);
    state.move.on = false;
    expect(checklistToActions(state)).toEqual([{ type: 'mark_read' }]);
    expect(state.move.mailboxId).toBe('mb-1');
  });

  it('Delete and Reject cannot be combined with filing the message', () => {
    const state = emptyChecklist();
    state.discard = true;
    expect(blockedActions(state)).toEqual(new Set(['move', 'copy', 'keep', 'reject']));
    const moving = emptyChecklist();
    moving.move.on = true;
    expect(blockedActions(moving)).toEqual(new Set(['discard', 'reject']));
  });

  it('says what is missing', () => {
    expect(checklistProblem(emptyChecklist())).toBe('none');
    const state = emptyChecklist();
    state.move.on = true;
    expect(checklistProblem(state)).toBe('move');
    state.move.mailboxId = 'mb-1';
    state.move.value = 'A';
    state.forward = { on: true, to: 'not an address', keepCopy: true };
    expect(checklistProblem(state)).toBe('forward');
    state.forward.to = 'a@x.com; b@y.org';
    expect(checklistProblem(state)).toBeNull();
  });

  it('stops every forward when Forward is unticked, including ones the editor cannot show', () => {
    const state = checklistFromActions([
      { type: 'forward', value: 'a@x.example', keepCopy: true },
      { type: 'forward', value: 'b@x.example' },
      { type: 'move', value: 'A', mailboxId: 'a' },
      { type: 'move', value: 'B', mailboxId: 'b' },
    ]);
    state.forward.on = false;
    state.move.on = false;
    expect(checklistToActions(state)).toEqual([]);
  });

  it('flags contradicting actions a rule from an older editor may carry', () => {
    const conflicts: FilterAction[][] = [
      [{ type: 'copy', value: 'A', mailboxId: 'a' }, { type: 'discard' }],
      [{ type: 'keep' }, { type: 'reject', value: 'no' }],
      [{ type: 'discard' }, { type: 'reject', value: 'no' }],
    ];
    for (const actions of conflicts) expect(checklistProblem(checklistFromActions(actions))).toBe('conflict');
    expect(checklistProblem(checklistFromActions([{ type: 'star' }, { type: 'discard' }]))).toBeNull();
  });

  it('splits forward addresses on commas, semicolons and spaces', () => {
    expect(forwardAddresses(' a@x.com,b@y.org ;  c@z.net ')).toEqual(['a@x.com', 'b@y.org', 'c@z.net']);
  });

  it('reads and writes sizes in KB and MB', () => {
    expect(parseSize('5M')).toEqual({ amount: '5', unit: 'M' });
    expect(parseSize('2048')).toEqual({ amount: '2', unit: 'K' });
    expect(parseSize('1500')).toEqual({ amount: '1500', unit: '' });
    expect(formatSize('10', 'M')).toBe('10M');
    expect(formatSize('', 'K')).toBe('');
  });
});
