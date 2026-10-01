"use client";

import React, { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey, TextSelection } from "@tiptap/pm/state";
import { Suggestion, exitSuggestion, type SuggestionMount, type SuggestionOptions } from "@tiptap/suggestion";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { filterMentionCandidates, type MentionCandidate } from "@/lib/recipient-mentions";

export const recipientMentionPluginKey = new PluginKey<{ active: boolean }>("recipientMention");

/**
 * Whether the "@" list is open in this editor. It owns Escape then, and the
 * composer, which handles Escape in the capture phase before the editor
 * sees it, has to let that one through.
 */
export function isRecipientMentionActive(editor: Editor | null | undefined): boolean {
  return !!editor && !editor.isDestroyed && !!recipientMentionPluginKey.getState(editor.state)?.active;
}

/**
 * Replaces the typed "@que" with "@Label " as plain text. Never as HTML: the
 * label comes from recipient display names, which a reply-all takes from the
 * incoming message.
 */
export function insertMention(editor: Editor, range: Range, label: string) {
  const text = `@${label}`;
  const after = editor.state.doc.resolve(range.to).nodeAfter;
  const spaceFollows = !!after?.isText && /^\s/.test(after.text ?? "");
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.insertText(spaceFollows ? text : `${text} `, range.from, range.to);
      tr.setSelection(TextSelection.create(tr.doc, range.from + text.length + 1));
      tr.scrollIntoView();
      return true;
    })
    .run();
}

export interface RecipientMentionOptions {
  /** The recipients an @ can address right now; read on every keystroke. */
  getCandidates: () => MentionCandidate[];
  render?: SuggestionOptions<MentionCandidate, MentionCandidate>["render"];
}

/**
 * "@" in the body offers the message's recipients and inserts the chosen
 * one's first name as plain text. The suggestion is only active while a
 * recipient matches what was typed, so an @ nobody matches - or one typed
 * without recipients - leaves Enter and Escape to the editor and composer.
 */
export const RecipientMention = Extension.create<RecipientMentionOptions>({
  name: "recipientMention",
  // While the list is open its Enter, Tab and arrows go ahead of the list,
  // table and core keymaps, which run at the default priority (100).
  priority: 101,

  addOptions() {
    return {
      getCandidates: () => [],
      render: undefined,
    };
  },

  // Focus leaving the editor (Shift+Tab, another field) closes the list. Left
  // open, it would float over that field and keep Escape from the composer.
  onBlur() {
    if (isRecipientMentionActive(this.editor)) exitSuggestion(this.editor.view, recipientMentionPluginKey);
  },

  addProseMirrorPlugins() {
    const { getCandidates, render } = this.options;
    return [
      Suggestion<MentionCandidate, MentionCandidate>({
        editor: this.editor,
        pluginKey: recipientMentionPluginKey,
        char: "@",
        // Only at the start of a word, so info@example.com never triggers.
        allowedPrefixes: [" ", "\u00a0"],
        decorationClass: "recipient-mention-query",
        floatingUi: { strategy: "fixed" },
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return false;
          const code = state.schema.marks.code;
          if (code && state.doc.rangeHasMark(range.from, range.to, code)) return false;
          const query = state.doc.textBetween(range.from + 1, range.to);
          return filterMentionCandidates(getCandidates(), query).length > 0;
        },
        items: ({ query }) => filterMentionCandidates(getCandidates(), query),
        command: ({ editor, range, props }) => insertMention(editor, range, props.label),
        render,
      }),
    ];
  },
});

export interface RecipientMentionListHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface RecipientMentionListProps {
  editor: Editor;
  items: MentionCandidate[];
  command: (item: MentionCandidate) => void;
  mount: SuggestionMount;
}

export const RecipientMentionList = forwardRef<RecipientMentionListHandle, RecipientMentionListProps>(
  function RecipientMentionList({ editor, items, command, mount }, ref) {
    const t = useTranslations("email_composer");
    const listId = useId();
    // Every keystroke brings new items; the highlight starts over with them.
    const [selection, setSelection] = useState({ items, index: 0 });
    const selected = selection.items === items ? selection.index : 0;
    const [position, setPosition] = useState<{ x: number; y: number; strategy: "absolute" | "fixed" } | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Anchored under the typed "@..." by the suggestion's own positioning,
    // which follows scrolling and resizing and dismisses on outside clicks.
    useLayoutEffect(() => {
      const element = listRef.current;
      if (!element) return;
      return mount(element, {
        onPosition: ({ x, y, strategy }) => {
          // Keep the list on screen in narrow panes.
          const maxX = window.innerWidth - element.offsetWidth - 8;
          setPosition({ x: Math.max(8, Math.min(x, maxX)), y, strategy });
        },
      });
    }, [mount]);

    useEffect(() => {
      listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
    }, [selected]);

    // The caret stays in the editor, so the editor points screen readers at
    // the list and its highlighted name, as the To/Cc autocomplete does for
    // its input. Removed again when the list closes.
    useEffect(() => {
      if (editor.isDestroyed) return;
      const dom = editor.view.dom;
      dom.setAttribute("aria-autocomplete", "list");
      dom.setAttribute("aria-controls", listId);
      return () => {
        dom.removeAttribute("aria-autocomplete");
        dom.removeAttribute("aria-controls");
        dom.removeAttribute("aria-activedescendant");
      };
    }, [editor, listId]);

    useEffect(() => {
      if (editor.isDestroyed) return;
      editor.view.dom.setAttribute("aria-activedescendant", `${listId}-${selected}`);
    }, [editor, listId, selected]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event) => {
        if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || items.length === 0) return false;
        if (event.key === "ArrowDown") {
          setSelection({ items, index: (selected + 1) % items.length });
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelection({ items, index: (selected + items.length - 1) % items.length });
          return true;
        }
        if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
          command(items[selected]);
          return true;
        }
        return false;
      },
    }), [items, selected, command]);

    return (
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("mention_recipients")}
        className="z-50 w-72 max-w-[calc(100vw-16px)] max-h-48 overflow-y-auto bg-background border border-border rounded-md shadow-lg"
        // A press anywhere on the list - its scrollbar too - keeps the focus
        // in the editor, which would otherwise close the list on blur.
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: position?.strategy ?? "fixed",
          left: position?.x ?? 0,
          top: position?.y ?? 0,
          visibility: position ? undefined : "hidden",
        }}
      >
        {items.map((item, i) => (
          <button
            key={item.email}
            id={`${listId}-${i}`}
            type="button"
            role="option"
            aria-selected={i === selected}
            className={cn(
              "w-full px-3 py-2 text-start text-sm flex items-center gap-2",
              i === selected ? "bg-accent text-accent-foreground" : "hover:bg-muted"
            )}
            onMouseDown={(e) => {
              // Keep the editor focused and the typed "@..." in place.
              e.preventDefault();
              command(item);
            }}
          >
            <Avatar name={item.name} email={item.email} size="sm" className="shrink-0 w-6 h-6 text-[10px]" />
            {/* What will be inserted comes first: for "Nagy János" that may be
                the surname, which the full name alone would not show. */}
            <span className="font-medium shrink-0">@{item.label}</span>
            <span className="text-muted-foreground truncate">
              {item.name && item.name !== item.label ? `${item.name} · ${item.email}` : item.email}
            </span>
          </button>
        ))}
      </div>
    );
  }
);
