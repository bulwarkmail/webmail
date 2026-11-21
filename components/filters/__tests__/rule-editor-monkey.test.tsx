import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import type { Mailbox } from '@/lib/jmap/types';
import { generateScript } from '@/lib/sieve/generator';
import { parseScript } from '@/lib/sieve/parser';
import { useSettingsStore } from '@/stores/settings-store';
import { RuleEditor } from '../rule-editor';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), progress: vi.fn(), dismiss: vi.fn() },
}));

const STALWART_EXTENSIONS = [
  'body', 'copy', 'date', 'envelope', 'fileinto', 'imap4flags', 'include', 'mailbox', 'mailboxid', 'regex', 'reject',
  'relational', 'spamtest', 'spamtestplus', 'variables', 'vacation', 'ereject', 'special-use',
];

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null },
  { id: 'trash', name: 'Trash', role: 'trash', parentId: null },
  { id: 'junk', name: 'Junk', role: 'junk', parentId: null },
  { id: 'news', name: 'Newsletters', role: null, parentId: null },
  { id: 'work', name: 'Work', role: null, parentId: null },
  { id: 'proj', name: 'Projects', role: null, parentId: 'work' },
  { id: 'odd', name: 'Spaces & Ümlauts "quoted" \\ slash/ish', role: null, parentId: null },
].map((m) => ({ myRights: { mayAddItems: true }, isShared: false, sortOrder: 0, totalEmails: 0, unreadEmails: 0, ...m })) as unknown as Mailbox[];

const NASTY = [
  '', ' ', 'a', 'news@acme.example', 'acme.example', 'x@y', 'a, b,, c', ',', 'Ärger', '🎉', '"quoted"', 'back\\slash',
  '*?', '[', '(', '.*', 'a{2,}', '$', '\n', 'a'.repeat(300), '*/ require "x";', '0', '-5', '99999999999', '1.5', '2M',
  'me@elsewhere.example', 'me@elsewhere.example, you@there.example', 'not an address', 'X-Spam-Flag', 'List-Id', 'Bad:Header',
  '2026-11-20T10:00', '2026-01-01T00:00', '9999-12-31T23:59', 'garbage',
];

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STARTS: (FilterRule | undefined)[] = [
  undefined,
  {
    id: 'r1', name: 'Statements', enabled: true, matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'northbank' }],
    actions: [{ type: 'mark_read' }, { type: 'move', value: 'Newsletters', mailboxId: 'news' }], stopProcessing: true,
  },
  {
    id: 'r2', name: 'Mixed', enabled: false, matchType: 'any',
    conditions: [
      { field: 'size', comparator: 'greater_than', value: '5M' },
      { field: 'header', comparator: 'contains', value: 'codehub', headerName: 'List-Id' },
      { field: 'attachment', comparator: 'has_type', value: 'pdf' },
    ],
    actions: [{ type: 'forward', value: 'a@b.example', keepCopy: true }, { type: 'add_label', value: 'work' }, { type: 'stop' }],
    stopProcessing: false, activeFrom: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'r3', name: 'Gone folder', enabled: true, matchType: 'all',
    conditions: [{ field: 'subject', comparator: 'regex', value: '^\\[URGENT\\]' }],
    actions: [{ type: 'copy', value: 'Deleted/Folder' }, { type: 'discard' }, { type: 'reject', value: 'nope' }, { type: 'keep' }],
    stopProcessing: false,
  },
];

const out = process.env.RULE_MONKEY_OUT;

function clickable(): HTMLElement[] {
  const all = Array.from(document.body.querySelectorAll<HTMLElement>('input, select, button, [role="menuitem"]'));
  return all.filter((el) => {
    if ((el as HTMLInputElement).disabled) return false;
    const text = (el.textContent ?? '').trim();
    const label = el.getAttribute('aria-label') ?? '';
    return !['save', 'cancel', 'delete_rule'].includes(text) && !/close/i.test(label) && !/close/i.test(text);
  });
}

async function poke(el: HTMLElement, rnd: () => number): Promise<void> {
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
  if (el instanceof HTMLSelectElement) {
    const options = Array.from(el.options).filter((o) => !o.disabled);
    if (options.length > 0) fireEvent.change(el, { target: { value: pick(options).value } });
    return;
  }
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    fireEvent.click(el);
    return;
  }
  if (el instanceof HTMLInputElement) {
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: pick(NASTY) } });
    if (rnd() < 0.5) fireEvent.blur(el);
    return;
  }
  fireEvent.click(el);
}

function checkSaved(rule: FilterRule, seed: number, n: number): void {
  expect(rule.conditions.length, `seed ${seed}: conditions`).toBeGreaterThan(0);
  expect(rule.actions.length, `seed ${seed}: actions`).toBeGreaterThan(0);
  const types = rule.actions.map((a) => a.type);
  const deletes = types.includes('discard') || types.includes('reject');
  const files = types.includes('move') || types.includes('copy') || types.includes('keep');
  expect(deletes && files, `seed ${seed}: deletes and files ${types.join(',')}`).toBe(false);
  expect(types.includes('discard') && types.includes('reject'), `seed ${seed}: discard and reject`).toBe(false);
  for (const a of rule.actions) {
    if (a.type === 'forward') expect(a.value, `seed ${seed}: forward address`).toMatch(/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/);
    if (a.type === 'move' || a.type === 'copy') expect(a.mailboxId || a.value, `seed ${seed}: folder`).toBeTruthy();
    if (a.type === 'add_label') expect(a.value, `seed ${seed}: tag`).toBeTruthy();
  }
  for (const c of rule.conditions) {
    if (c.field !== 'all' && !(c.field === 'attachment' && c.comparator === 'has_any')) {
      const list = Array.isArray(c.value) ? c.value : [c.value];
      expect(list.length > 0 && list.every((v) => v.trim().length > 0), `seed ${seed}: empty value ${JSON.stringify(c)}`).toBe(true);
    }
    if (c.field === 'size') expect(c.value, `seed ${seed}: size`).toMatch(/^\d+[KMG]?$/);
    if (c.field === 'header') expect(c.headerName, `seed ${seed}: header`).toMatch(/^[\x21-\x39\x3b-\x7e]+$/);
  }
  expect(rule.name.trim().length, `seed ${seed}: name`).toBeGreaterThan(0);
  const script = generateScript([rule], undefined, { extensions: STALWART_EXTENSIONS });
  const parsed = parseScript(script);
  expect(parsed.isOpaque, `seed ${seed}: opaque`).toBe(false);
  expect(parsed.rules.map((r) => r.id), `seed ${seed}: round trip`).toEqual([rule.id]);
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `seed-${seed}-${n}.sieve`), script);
    writeFileSync(join(out, `seed-${seed}-${n}.json`), JSON.stringify(rule, null, 2));
  }
}

describe('the rule editor under random clicking', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    useSettingsStore.setState({
      emailKeywords: [
        { id: 'work', label: 'Work', color: 'blue' },
        { id: 'family', label: 'Family', color: 'green' },
      ] as never,
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const SEEDS = Number(process.env.RULE_MONKEY_SEEDS ?? 40);
  const STEPS = Number(process.env.RULE_MONKEY_STEPS ?? 60);

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`survives ${STEPS} random steps and then saves a valid rule or says why not (seed ${seed})`, async () => {
      const rnd = prng(seed);
      const onSave = vi.fn();
      const onClose = vi.fn();
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
        if (String(args[0]).includes('act(')) return;
        errors.push(args);
      });
      const start = STARTS[seed % STARTS.length];
      useSettingsStore.setState({ showAdvancedSettings: rnd() < 0.5 });
      render(
        <RuleEditor
          rule={seed % 3 === 0 ? start : undefined}
          initialRule={seed % 3 === 1 ? start : undefined}
          mailboxes={mailboxes}
          maxRedirects={seed % 4 === 0 ? 1 : seed % 4 === 1 ? 0 : null}
          forwardsBefore={seed % 5 === 0 ? 1 : 0}
          periodsSupported={rnd() < 0.7}
          regexSupported={rnd() < 0.7}
          offerApplyToExisting
          applyExistingFolder="Inbox"
          previewMatches={async () => (rnd() < 0.2 ? null : { items: [], total: Math.floor(rnd() * 5), complete: rnd() < 0.5, inFolder: Math.floor(rnd() * 3) })}
          onSave={onSave}
          onDelete={() => {}}
          onClose={onClose}
        />,
      );
      for (let step = 0; step < STEPS; step++) {
        if (rnd() < 0.08) {
          await act(async () => { await vi.advanceTimersByTimeAsync(600); });
          continue;
        }
        if (rnd() < 0.06) {
          fireEvent.click(screen.getByText('save'));
          continue;
        }
        const targets = clickable();
        if (targets.length === 0) break;
        await act(async () => { await poke(targets[Math.floor(rnd() * targets.length)], rnd); });
        expect(screen.getByRole('dialog'), `seed ${seed} step ${step}: dialog gone`).toBeTruthy();
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      const before = onSave.mock.calls.length;
      fireEvent.click(screen.getByText('save'));
      onSave.mock.calls.forEach(([rule, options], n) => {
        checkSaved(rule, seed, n);
        expect(['new', 'folder', 'all']).toContain(options?.applyTo);
      });
      if (onSave.mock.calls.length === before) {
        expect(screen.getAllByRole('alert').length, `seed ${seed}: refused without saying why`).toBeGreaterThan(0);
      }
      spy.mockRestore();
      expect(errors, `seed ${seed}: console errors`).toEqual([]);
    });
  }
});
