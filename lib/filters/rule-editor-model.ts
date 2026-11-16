import type { FilterAction } from '@/lib/jmap/sieve-types';

export interface FolderChoice {
  on: boolean;
  mailboxId?: string;
  value: string;
}

export interface Checklist {
  markRead: boolean;
  star: boolean;
  tag: { on: boolean; ids: string[] };
  copy: FolderChoice;
  move: FolderChoice;
  forward: { on: boolean; to: string; keepCopy: boolean };
  keep: boolean;
  reject: { on: boolean; message: string };
  discard: boolean;
  extra: FilterAction[];
}

export type ChecklistKey = 'markRead' | 'star' | 'tag' | 'copy' | 'move' | 'forward' | 'keep' | 'reject' | 'discard';

export type ChecklistProblem = 'none' | 'tag' | 'copy' | 'move' | 'forward' | 'reject' | 'conflict';

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emptyChecklist(): Checklist {
  return {
    markRead: false,
    star: false,
    tag: { on: false, ids: [] },
    copy: { on: false, value: '' },
    move: { on: false, value: '' },
    forward: { on: false, to: '', keepCopy: true },
    keep: false,
    reject: { on: false, message: '' },
    discard: false,
    extra: [],
  };
}

export function forwardAddresses(text: string): string[] {
  return text.split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean);
}

export function checklistFromActions(actions: FilterAction[]): Checklist {
  const state = emptyChecklist();
  let forwardSeen = false;
  const forwards: string[] = [];
  for (const action of actions) {
    switch (action.type) {
      case 'mark_read':
        state.markRead = true;
        break;
      case 'star':
        state.star = true;
        break;
      case 'add_label':
        if (action.value && !state.tag.ids.includes(action.value)) state.tag.ids.push(action.value);
        state.tag.on = true;
        break;
      case 'move':
      case 'copy': {
        const slot = state[action.type];
        if (slot.on) {
          state.extra.push(action);
        } else {
          state[action.type] = { on: true, value: action.value ?? '', ...(action.mailboxId ? { mailboxId: action.mailboxId } : {}) };
        }
        break;
      }
      case 'forward':
        if (forwardSeen && !!action.keepCopy !== state.forward.keepCopy) {
          state.extra.push(action);
          break;
        }
        if (!forwardSeen) state.forward.keepCopy = !!action.keepCopy;
        forwardSeen = true;
        if (action.value) forwards.push(action.value);
        state.forward.on = true;
        break;
      case 'keep':
        state.keep = true;
        break;
      case 'reject':
        if (state.reject.on) state.extra.push(action);
        else state.reject = { on: true, message: action.value ?? '' };
        break;
      case 'discard':
        state.discard = true;
        break;
      case 'stop':
        break;
    }
  }
  state.forward.to = forwards.join(', ');
  return state;
}

function folderAction(type: 'move' | 'copy', choice: FolderChoice): FilterAction {
  return { type, ...(choice.mailboxId ? { mailboxId: choice.mailboxId } : {}), value: choice.value };
}

function extraKept(state: Checklist, action: FilterAction): boolean {
  switch (action.type) {
    case 'move':
    case 'copy':
    case 'forward':
    case 'reject':
      return state[action.type].on;
    default:
      return true;
  }
}

export function checklistToActions(state: Checklist): FilterAction[] {
  const actions: FilterAction[] = [];
  const extra = state.extra.filter((a) => extraKept(state, a));
  if (state.markRead) actions.push({ type: 'mark_read' });
  if (state.star) actions.push({ type: 'star' });
  if (state.tag.on) for (const id of state.tag.ids) actions.push({ type: 'add_label', value: id });
  if (state.copy.on) actions.push(folderAction('copy', state.copy));
  if (state.move.on) actions.push(folderAction('move', state.move));
  const forwardExtras = extra.filter((a) => a.type === 'forward');
  actions.push(...extra.filter((a) => a.type !== 'forward' && a.type !== 'reject'));
  if (state.forward.on) {
    for (const to of forwardAddresses(state.forward.to)) {
      actions.push({ type: 'forward', value: to, ...(state.forward.keepCopy ? { keepCopy: true } : {}) });
    }
  }
  actions.push(...forwardExtras);
  if (state.keep) actions.push({ type: 'keep' });
  if (state.reject.on) actions.push({ type: 'reject', value: state.reject.message });
  actions.push(...extra.filter((a) => a.type === 'reject'));
  if (state.discard) actions.push({ type: 'discard' });
  return actions;
}

const FILING: ChecklistKey[] = ['move', 'copy', 'keep'];

function isOn(state: Checklist, key: ChecklistKey): boolean {
  const value = state[key];
  return typeof value === 'boolean' ? value : value.on;
}

export function blockedActions(state: Checklist): Set<ChecklistKey> {
  const blocked = new Set<ChecklistKey>();
  const block = (key: ChecklistKey) => { if (!isOn(state, key)) blocked.add(key); };
  if (state.discard || state.reject.on) {
    FILING.forEach(block);
    block(state.discard ? 'reject' : 'discard');
  }
  if (FILING.some((key) => isOn(state, key))) {
    block('discard');
    block('reject');
  }
  return blocked;
}

export function checklistProblem(state: Checklist): ChecklistProblem | null {
  const removes = state.discard || state.reject.on;
  if ((removes && FILING.some((key) => isOn(state, key))) || (state.discard && state.reject.on)) return 'conflict';
  if (state.tag.on && state.tag.ids.length === 0) return 'tag';
  if (state.copy.on && !state.copy.mailboxId && !state.copy.value.trim()) return 'copy';
  if (state.move.on && !state.move.mailboxId && !state.move.value.trim()) return 'move';
  if (state.forward.on) {
    const addresses = forwardAddresses(state.forward.to);
    if (addresses.length === 0 || !addresses.every((a) => ADDRESS.test(a))) return 'forward';
  }
  if (state.reject.on && !state.reject.message.trim()) return 'reject';
  if (checklistToActions(state).length === 0) return 'none';
  return null;
}

export type SizeUnit = '' | 'K' | 'M';

export function parseSize(value: string): { amount: string; unit: SizeUnit } {
  const m = /^(\d+)([KMG]?)$/i.exec(value.trim());
  if (!m) return { amount: value.trim(), unit: 'K' };
  const unit = m[2].toUpperCase();
  if (unit === 'G') return { amount: String(Number(m[1]) * 1024), unit: 'M' };
  if (unit === 'K' || unit === 'M') return { amount: m[1], unit };
  const bytes = Number(m[1]);
  if (bytes > 0 && bytes % (1024 * 1024) === 0) return { amount: String(bytes / (1024 * 1024)), unit: 'M' };
  if (bytes > 0 && bytes % 1024 === 0) return { amount: String(bytes / 1024), unit: 'K' };
  return { amount: m[1], unit: '' };
}

export function formatSize(amount: string, unit: SizeUnit): string {
  const n = amount.trim();
  return /^\d+$/.test(n) ? `${n}${unit}` : '';
}

export function sizeInBytes(value: string): number | null {
  const m = /^(\d+)([KMG]?)$/i.exec(value.trim());
  if (!m) return null;
  const scale = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G'];
  return Number(m[1]) * scale;
}
