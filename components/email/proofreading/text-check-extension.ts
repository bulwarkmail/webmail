// Underlines for what text checkers found, in the rich editor.
//
// The composer hands the extension a list of issues with document ranges
// (setTextIssues). The decorations then move with the text on every edit;
// one whose text was changed (typing inside it, a paste over it) is dropped
// right away, before the checker has answered again. Clicking, tapping or
// right-clicking an underline asks the composer to open its popup.
//
// A replacement is one transaction and one undo step of its own (closed
// before and after, so typing right after it isn't merged in), and only
// happens while the underlined range still holds the text the checker saw.

import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { closeHistory } from '@tiptap/pm/history';
import type { CheckKind } from '@/lib/proofreading/annotations';

export interface TextIssueRange {
  /** The host's key for the issue. */
  key: string;
  from: number;
  to: number;
  kind: CheckKind;
  /** The text the checker saw there. */
  text: string;
}

interface IssueSpec {
  key: string;
  kind: CheckKind;
  text: string;
}

interface CheckState {
  decos: DecorationSet;
  active: string | null;
}

type Meta = { issues: TextIssueRange[] } | { active: string | null };

export const textCheckKey = new PluginKey<CheckState>('textCheck');

export type IssueOpenVia = 'click' | 'contextmenu' | 'keyboard';

export interface TextCheckOptions {
  /** An underline was clicked, tapped or right-clicked. */
  onOpen: (key: string, anchor: DOMRect | null, via: IssueOpenVia) => void;
  /** A key pressed in the text; true when it was handled (Escape, next/previous issue). */
  onKey?: (event: KeyboardEvent) => boolean;
}

/**
 * Next (1) or previous (-1) issue: Mod+' and Mod+;, by the key's place on
 * the keyboard (Ä and Ö on a German one), with or without Shift.
 */
export function issueNavigationKey(event: KeyboardEvent): 1 | -1 | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.code === 'Quote') return 1;
  if (event.code === 'Semicolon') return -1;
  return null;
}

function decorationFor(range: TextIssueRange, active: boolean): Decoration {
  return Decoration.inline(
    range.from,
    range.to,
    {
      class: `text-issue text-issue-${range.kind}${active ? ' text-issue-active' : ''}`,
      'data-text-issue': range.key,
    },
    { key: range.key, kind: range.kind, text: range.text } satisfies IssueSpec,
  );
}

function build(doc: EditorState['doc'], issues: TextIssueRange[], active: string | null): DecorationSet {
  const decos: Decoration[] = [];
  for (const r of issues) {
    if (r.from < 0 || r.to > doc.content.size || r.to <= r.from) continue;
    if (doc.textBetween(r.from, r.to, '\n', '\uFFFC') !== r.text) continue;
    decos.push(decorationFor(r, r.key === active));
  }
  return DecorationSet.create(doc, decos);
}

/** Decorations left after an edit: mapped, minus those whose text changed. */
function mapThrough(tr: Transaction, set: DecorationSet): DecorationSet {
  let decos = set.map(tr.mapping, tr.doc);
  const touched: { from: number; to: number }[] = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      touched.push({ from: rest.map(newStart, -1), to: rest.map(newEnd, 1) });
    });
  });
  if (!touched.length) return decos;
  const stale: Decoration[] = [];
  for (const { from, to } of touched) {
    for (const d of decos.find(Math.max(0, from - 1), Math.min(tr.doc.content.size, to + 1))) {
      const spec = d.spec as IssueSpec;
      if (tr.doc.textBetween(d.from, d.to, '\n', '\uFFFC') !== spec.text) stale.push(d);
    }
  }
  if (stale.length) decos = decos.remove(stale);
  return decos;
}

function issueAt(view: EditorView, pos: number): Decoration | null {
  const state = textCheckKey.getState(view.state);
  if (!state) return null;
  return state.decos.find(pos, pos).find((d) => d.from <= pos && pos <= d.to) ?? null;
}

export function createTextCheckExtension(options: () => TextCheckOptions) {
  return Extension.create({
    name: 'textCheck',
    addProseMirrorPlugins() {
      return [
        new Plugin<CheckState>({
          key: textCheckKey,
          state: {
            init: () => ({ decos: DecorationSet.empty, active: null }),
            apply(tr, value, _old, state) {
              const meta = tr.getMeta(textCheckKey) as Meta | undefined;
              if (meta && 'issues' in meta) return { decos: build(state.doc, meta.issues, value.active), active: value.active };
              let decos = tr.docChanged ? mapThrough(tr, value.decos) : value.decos;
              let active = value.active;
              if (meta && 'active' in meta && meta.active !== active) {
                active = meta.active;
                // Redraw the two underlines whose look changes.
                const redraw = decos.find().filter((d) => {
                  const k = (d.spec as IssueSpec).key;
                  return k === active || k === value.active;
                });
                decos = decos.remove(redraw).add(state.doc, redraw.map((d) => {
                  const spec = d.spec as IssueSpec;
                  return decorationFor({ key: spec.key, kind: spec.kind, text: spec.text, from: d.from, to: d.to }, spec.key === active);
                }));
              }
              return { decos, active };
            },
          },
          props: {
            decorations(state) {
              return textCheckKey.getState(state)?.decos;
            },
            handleKeyDown(_view, event) {
              return options().onKey?.(event) ?? false;
            },
            handleClick(view, pos, event) {
              const deco = issueAt(view, pos);
              if (!deco) return false;
              const el = (event.target as Element | null)?.closest?.('[data-text-issue]') ?? null;
              options().onOpen((deco.spec as IssueSpec).key, el?.getBoundingClientRect() ?? null, 'click');
              // The caret still goes where the user clicked.
              return false;
            },
            handleDOMEvents: {
              contextmenu(view, event) {
                const el = (event.target as Element | null)?.closest?.('[data-text-issue]');
                const key = el?.getAttribute('data-text-issue');
                if (!el || !key) return false;
                const known = textCheckKey.getState(view.state)?.decos.find().some((d) => (d.spec as IssueSpec).key === key);
                if (!known) return false;
                // Our popup instead of the browser's menu (and of the
                // plugins' selection menu above it).
                event.preventDefault();
                event.stopPropagation();
                options().onOpen(key, el.getBoundingClientRect(), 'contextmenu');
                return true;
              },
            },
          },
        }),
      ];
    },
  });
}

/** Put the checkers' issues on the editor, replacing what was there. */
export function setTextIssues(editor: Editor, issues: TextIssueRange[]): void {
  if (editor.isDestroyed) return;
  const { tr } = editor.state;
  editor.view.dispatch(tr.setMeta(textCheckKey, { issues } satisfies Meta).setMeta('addToHistory', false));
}

/** Mark the issue whose popup is open (or none). */
export function setActiveIssue(editor: Editor, key: string | null): void {
  if (editor.isDestroyed) return;
  const { tr } = editor.state;
  editor.view.dispatch(tr.setMeta(textCheckKey, { active: key } satisfies Meta).setMeta('addToHistory', false));
}

/** The issues drawn now, in document order, with their current ranges. */
export function drawnIssues(state: EditorState): TextIssueRange[] {
  const set = textCheckKey.getState(state)?.decos;
  if (!set) return [];
  return set.find().map((d) => {
    const spec = d.spec as IssueSpec;
    return { key: spec.key, kind: spec.kind, text: spec.text, from: d.from, to: d.to };
  }).sort((a, b) => a.from - b.from);
}

/**
 * Replace an underlined range with `replacement`: one undo step, and only
 * if the range still holds the text the checker saw. Returns false if not.
 */
export function applyIssueReplacement(editor: Editor, key: string, replacement: string): boolean {
  if (editor.isDestroyed) return false;
  const range = drawnIssues(editor.state).find((r) => r.key === key);
  if (!range) return false;
  const { state } = editor;
  if (state.doc.textBetween(range.from, range.to, '\n', '\uFFFC') !== range.text) return false;
  const tr = closeHistory(state.tr);
  tr.insertText(replacement, range.from, range.to);
  tr.setSelection(TextSelection.create(tr.doc, range.from + replacement.length));
  editor.view.dispatch(tr);
  // Typing right after the fix is a step of its own.
  editor.view.dispatch(closeHistory(editor.state.tr));
  return true;
}

/** Select the next (dir 1) or previous (dir -1) issue from the caret; returns its key. */
export function selectNextIssue(editor: Editor, dir: 1 | -1): string | null {
  const issues = drawnIssues(editor.state);
  if (!issues.length) return null;
  const { from, to } = editor.state.selection;
  const target = dir === 1
    ? issues.find((r) => r.from >= to && !(r.from === from && r.to === to)) ?? issues[0]
    : [...issues].reverse().find((r) => r.to <= from && !(r.from === from && r.to === to)) ?? issues[issues.length - 1];
  const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target.from, target.to)).scrollIntoView();
  editor.view.dispatch(tr);
  return target.key;
}

/** Where an issue is on screen, for its popup. */
export function issueRect(editor: Editor, key: string): DOMRect | null {
  const range = drawnIssues(editor.state).find((r) => r.key === key);
  if (!range || editor.isDestroyed) return null;
  const el = editor.view.dom.querySelector(`[data-text-issue="${CSS.escape(key)}"]`);
  if (el) return el.getBoundingClientRect();
  try {
    const a = editor.view.coordsAtPos(range.from);
    const b = editor.view.coordsAtPos(range.to);
    return new DOMRect(a.left, a.top, Math.max(1, b.right - a.left), a.bottom - a.top);
  } catch {
    return null;
  }
}
