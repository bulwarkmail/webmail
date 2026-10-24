import type { EditorView } from "@tiptap/pm/view";

// Tab inserts indentation instead of moving focus out of the editor.
// ProseMirror's keymap only handles Tab inside lists (sink) and tables
// (next cell); in a plain text block nothing claims it, so the browser
// default fires and focus jumps to the next field mid-sentence - users
// fell back to typing spaces.
//
// We insert 4 non-breaking spaces rather than a literal tab: HTML collapses
// raw \t at render time (white-space handling in most mail clients), while
// &nbsp; survives Gmail/Outlook rendering. Shift+Tab stays untouched as
// reverse focus navigation.
export function tabIndentKeyDown(
  view: EditorView,
  event: KeyboardEvent,
): boolean {
  if (event.key !== "Tab" || event.shiftKey) return false;
  // Only indent in top-level text blocks (depth 1 = direct child of the
  // doc). Deeper selections sit inside a list or a table, whose keymaps
  // own Tab (sink list item / hop to the next cell) and must not be
  // shadowed by an indent.
  const { $from } = view.state.selection;
  if ($from.depth !== 1 || !$from.parent.isTextblock) return false;
  event.preventDefault();
  view.dispatch(
    // U+00A0 = non-breaking space; see the comment above for why these
    // are not plain spaces.
    view.state.tr.insertText("    "),
  );
  return true;
}
