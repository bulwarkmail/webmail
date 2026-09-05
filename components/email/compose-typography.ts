"use client";

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Mark, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import type { ComposeFontFamily, ComposeFontSize } from "@/stores/settings-store";

/**
 * Compose typography — make the composer's *default* text style (font family,
 * font size, colour) match the reply it is editing, so a human edit is
 * invisible.
 *
 * WHY: our pipeline drafts a reply as inline-styled HTML (e.g. Georgia 15px in a
 * warm ink). TipTap, left to itself, gives every brand-new paragraph — the one
 * created by Enter, or an inline-reply line typed between two quoted lines — the
 * editor's bare default (sans, 16px, black). The result is a visibly mismatched
 * edit sitting next to the drafted body.
 *
 * FIX: the three properties are all attributes of the single `textStyle` mark
 * (font-family + font-size from @tiptap/extension-text-style submodules, colour
 * from @tiptap/extension-color), which renders inline as
 * `<span style="font-family:…;font-size:…;color:…">` and survives Bulwark's
 * sanitize→editor→serialize send path (proven by scripts/bulwark/roundtrip.mjs).
 * This extension keeps that mark in the editor's *stored marks* whenever the
 * cursor sits at an empty position, so every newly typed run — including the
 * first character of a fresh paragraph — carries the same family+size+colour and
 * therefore SENDS and MATCHES. It fills only the attributes that are missing, so
 * a colour or font the user picked by hand always wins.
 */

/** Web-safe font stacks (no web-font loading). `null` = leave the family unset. */
export const COMPOSE_FONT_FAMILY_CSS: Record<ComposeFontFamily, string | null> = {
  default: null,
  sans: "Arial, Helvetica, sans-serif",
  "serif-georgia": "Georgia, 'Times New Roman', serif",
  "serif-times": "'Times New Roman', Times, serif",
  verdana: "Verdana, Geneva, sans-serif",
  trebuchet: "'Trebuchet MS', Helvetica, sans-serif",
  monospace: "'Courier New', Courier, monospace",
};

/** Compose text-size tiers mapped to px. `null` = leave the size unset. */
export const COMPOSE_FONT_SIZE_CSS: Record<ComposeFontSize, string | null> = {
  default: null,
  small: "13px",
  normal: "14px",
  medium: "15px",
  large: "16px",
  "x-large": "18px",
};

/** The resolved default marks the composer should apply to typed text. */
export interface ComposeDefaults {
  fontFamily: string | null;
  fontSize: string | null;
  color: string | null;
}

const EMPTY_DEFAULTS: ComposeDefaults = { fontFamily: null, fontSize: null, color: null };

function hasAnyDefault(d: ComposeDefaults): boolean {
  return Boolean(d.fontFamily || d.fontSize || d.color);
}

/**
 * The typography of the reply body currently in the editor: the attributes of
 * the first `textStyle`-marked text run. Atom nodes (the quoted original, the
 * signature block) hold their HTML as an attribute rather than as child text, so
 * `descendants` never walks into them — the sample is always the reply body, not
 * the quote below it. Returns all-null when the body carries no inline style.
 */
export function sampleTypography(doc: ProseMirrorNode): ComposeDefaults {
  let found: ComposeDefaults | null = null;
  doc.descendants((node) => {
    if (found) return false;
    if (!node.isText) return true;
    const ts = node.marks.find((m) => m.type.name === "textStyle");
    if (ts && (ts.attrs.fontFamily || ts.attrs.fontSize || ts.attrs.color)) {
      found = {
        fontFamily: ts.attrs.fontFamily ?? null,
        fontSize: ts.attrs.fontSize ?? null,
        color: ts.attrs.color ?? null,
      };
      return false;
    }
    return true;
  });
  return found ?? { ...EMPTY_DEFAULTS };
}

/**
 * Resolve the effective compose defaults. The reply being edited (the `sample`)
 * always wins so edits stay invisible; the user's Compose-font / Compose-size
 * settings supply the family, size and colour only when there is no styled
 * draft to match (a fresh message); the drafted reply always wins so edits stay
 * invisible. `userColor` is optional — omit it and colour derives purely from
 * the sample, defaulting to unset (the editor's own colour).
 */
export function resolveComposeDefaults(opts: {
  userFamily: string | null;
  userSize: string | null;
  userColor?: string | null;
  sample: ComposeDefaults;
}): ComposeDefaults {
  const { userFamily, userSize, userColor = null, sample } = opts;
  return {
    fontFamily: sample.fontFamily ?? userFamily ?? null,
    fontSize: sample.fontSize ?? userSize ?? null,
    color: sample.color ?? userColor ?? null,
  };
}

/**
 * A marks array with a `textStyle` mark that fills the compose defaults into any
 * attribute the current marks leave unset. Existing values (a colour or font the
 * user chose) are preserved; other marks (bold, link, …) pass through untouched.
 */
function withComposeDefaults(
  marks: readonly Mark[],
  schema: Schema,
  defaults: ComposeDefaults
): readonly Mark[] {
  const textStyleType = schema.marks.textStyle;
  if (!textStyleType) return marks;
  const existing = marks.find((m) => m.type === textStyleType);
  const attrs: Record<string, unknown> = { ...(existing?.attrs ?? {}) };
  if (defaults.fontFamily && !attrs.fontFamily) attrs.fontFamily = defaults.fontFamily;
  if (defaults.fontSize && !attrs.fontSize) attrs.fontSize = defaults.fontSize;
  if (defaults.color && !attrs.color) attrs.color = defaults.color;
  const others = marks.filter((m) => m.type !== textStyleType);
  return textStyleType.create(attrs).addToSet(others);
}

const composeTypographyKey = new PluginKey("composeTypography");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    composeTypography: {
      /** Set the resolved default family/size/colour for newly typed text. */
      setComposeDefaults: (defaults: ComposeDefaults) => ReturnType;
      /** Fill the missing default marks across the editable reply body (once, on load). */
      applyComposeDefaultsToBody: () => ReturnType;
    };
  }
}

export interface ComposeTypographyStorage {
  defaults: ComposeDefaults;
}

export type ComposeTypographyOptions = Record<string, never>;

/** Read this extension's per-editor storage off an editor instance. */
function readStorage(editor: { storage: unknown }): ComposeTypographyStorage {
  return (editor.storage as Record<string, ComposeTypographyStorage>).composeTypography;
}

export const ComposeTypography = Extension.create<ComposeTypographyOptions, ComposeTypographyStorage>({
  name: "composeTypography",

  addStorage(): ComposeTypographyStorage {
    return { defaults: { ...EMPTY_DEFAULTS } };
  },

  addCommands() {
    return {
      setComposeDefaults:
        (defaults: ComposeDefaults) =>
        ({ editor, state, tr, dispatch }) => {
          readStorage(editor).defaults = defaults;
          // Refresh the stored marks now so an already-placed cursor picks the
          // new defaults up immediately (not only after the next keystroke).
          if (dispatch && state.selection.empty && hasAnyDefault(defaults)) {
            const current = state.storedMarks || state.selection.$from.marks();
            const desired = withComposeDefaults(current, state.schema, defaults);
            if (!Mark.sameSet(current, desired)) {
              tr.setStoredMarks(desired as Mark[]);
            }
          }
          return true;
        },

      applyComposeDefaultsToBody:
        () =>
        ({ editor, state, tr, dispatch }) => {
          const defaults = readStorage(editor).defaults;
          if (!hasAnyDefault(defaults)) return false;
          const textStyleType = state.schema.marks.textStyle;
          if (!textStyleType) return false;
          let modified = false;
          state.doc.descendants((node, pos) => {
            // Never touch the verbatim atom nodes (quoted original, signature).
            if (node.type.name === "quotedHtml" || node.type.name === "signatureBlock") {
              return false;
            }
            if (!node.isText) return true;
            const existing = node.marks.find((m) => m.type === textStyleType);
            const attrs: Record<string, unknown> = { ...(existing?.attrs ?? {}) };
            let changed = false;
            if (defaults.fontFamily && !attrs.fontFamily) {
              attrs.fontFamily = defaults.fontFamily;
              changed = true;
            }
            if (defaults.fontSize && !attrs.fontSize) {
              attrs.fontSize = defaults.fontSize;
              changed = true;
            }
            if (defaults.color && !attrs.color) {
              attrs.color = defaults.color;
              changed = true;
            }
            if (changed) {
              tr.addMark(pos, pos + node.nodeSize, textStyleType.create(attrs));
              modified = true;
            }
            return true;
          });
          if (modified && dispatch) {
            tr.setMeta("composeTypographyFill", true);
            dispatch(tr);
          }
          return modified;
        },
    };
  },

  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        key: composeTypographyKey,
        // Keep the compose defaults in the stored marks whenever the cursor sits
        // at an empty position, so the next typed run (a fresh paragraph, an
        // inline-reply line) inherits family+size+colour and thus SENDS matching
        // the drafted body. Fills only missing attributes, so a hand-picked
        // colour/font is never overridden; terminates because a second pass sees
        // the marks already present.
        appendTransaction(transactions, _oldState, newState) {
          const defaults = readStorage(editor).defaults;
          if (!hasAnyDefault(defaults)) return null;
          if (!transactions.some((t) => t.docChanged || t.selectionSet)) return null;
          const sel = newState.selection;
          if (!sel.empty) return null;
          const current = newState.storedMarks || sel.$from.marks();
          const desired = withComposeDefaults(current, newState.schema, defaults);
          if (Mark.sameSet(current, desired)) return null;
          return newState.tr.setStoredMarks(desired as Mark[]);
        },
      }),
    ];
  },
});
