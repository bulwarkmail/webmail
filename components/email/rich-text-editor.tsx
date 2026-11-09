"use client";

import React, { useEffect, useCallback, useLayoutEffect, useState, useRef } from "react";
import { popoverFitHeight, popoverShift } from "@/lib/popover-shift";
import { createPortal } from "react-dom";
import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import type { SuggestionProps } from "@tiptap/suggestion";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import Heading from "@tiptap/extension-heading";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextDirection } from "@/components/email/text-direction";
import { PlainTextPaste } from "@/components/email/plain-text-paste";
import { pastedImageFiles } from "@/components/email/paste-images";
import { TextStyle, BackgroundColor } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { FontSize, FONT_SIZES, composeTextStyleCss, type ComposeTextStyle } from "@/components/email/font-size";
import { ResizableImage } from "@/components/email/resizable-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { ReplyQuoteCollapse } from "@/components/email/reply-quote-collapse";
import { QuotedHtml, restoreCaretAfterContentSync, serializeEditorContent } from "@/components/email/quoted-html";
import { keepLoadedParagraphSpacing, paragraphStyleWithoutSpacing, trailingParagraphBreakRule } from "@/components/email/paragraph-breaks";
import { SignatureBlock } from "@/components/email/signature-block";
import { styledBlockAttributes } from "@/components/email/styled-block-attributes";
import { RecipientMention, RecipientMentionList, type RecipientMentionListHandle } from "@/components/email/recipient-mention";
import { MentionChipCard, setMentionRecipients } from "@/components/email/mention-chip";
import { mentionSuggestions, type MentionCandidate, type MentionContact } from "@/lib/recipient-mentions";
import { cn } from "@/lib/utils";
import { getMarkRange } from "@tiptap/core";
import { LinkDialog } from "@/components/email/link-dialog";
import { ImageUrlDialog } from "@/components/email/image-url-dialog";
import { ImageAltDialog } from "@/components/email/image-alt-dialog";

/** A typed address without a scheme ("example.com") becomes a web link. */
export function withLinkScheme(value: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("#") || value.startsWith("/")
    ? value
    : `https://${value}`;
}
import { useSettingsStore } from "@/stores/settings-store";
import { createTextCheckExtension, type TextCheckOptions } from "@/components/email/proofreading/text-check-extension";
import { useTranslations } from "next-intl";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ArrowLeftRight,
  Link as LinkIcon,
  Undo,
  Redo,
  Quote,
  Code,
  RemoveFormatting,
  FormatPainter,
  Heading1,
  Heading2,
  Table as TableIcon,
  Baseline,
  Highlighter,
  Trash2,
  Rows3,
  Columns3,
  ImageIcon,
  Ellipsis,
} from "@/components/icons";

/**
 * Groups of the formatting toolbar that move behind "More formatting" when one
 * row is too narrow for all of them, the least used first. Each with its
 * buttons and the separators that go with it.
 */
const FOLDABLE_GROUPS = [
  { id: "history", buttons: 4, separators: 2 },
  { id: "align", buttons: 3, separators: 1 },
  { id: "headings", buttons: 2, separators: 1 },
  { id: "table", buttons: 1, separators: 0 },
  { id: "blocks", buttons: 2, separators: 0 },
] as const;
type FoldableGroup = (typeof FOLDABLE_GROUPS)[number]["id"];
/**
 * Always in the row: font size, bold, italic, underline, strikethrough, the
 * two colours, the lists, link, an image's description and More (12), with
 * their 3 separators.
 */
const FIXED_TOOLBAR = { buttons: 12, separators: 3 };

/**
 * How many of FOLDABLE_GROUPS go behind "More formatting" for one row of
 * `width` px. 0 for a toolbar that isn't laid out (hidden, or not measured).
 */
export function formattingFoldCount(width: number, sizes: { button: number; gap: number; separator: number; directionButton?: boolean }): number {
  if (!(width > 0)) return 0;
  const span = (buttons: number, separators: number) => buttons * (sizes.button + sizes.gap) + separators * (sizes.separator + sizes.gap);
  const groups = FOLDABLE_GROUPS.map((group) => span(group.buttons + (group.id === "align" && sizes.directionButton ? 1 : 0), group.separators));
  let needed = span(FIXED_TOOLBAR.buttons, FIXED_TOOLBAR.separators) + groups.reduce((sum, group) => sum + group, 0);
  // All of it fits without the More button.
  if (needed - (sizes.button + sizes.gap) <= width + 1) return 0;
  for (let count = 1; count <= groups.length; count++) {
    needed -= groups[count - 1];
    if (needed <= width + 1) return count;
  }
  return groups.length;
}

/** The toolbar's inner width and the sizes of what is in it, in px. */
function measureFormattingToolbar(toolbar: HTMLElement, directionButton: boolean): number {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const style = getComputedStyle(toolbar);
  const width = toolbar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  const button = toolbar.querySelector<HTMLElement>(":scope > [data-toolbar-item], :scope > div > [data-toolbar-item]")?.offsetWidth || 1.75 * rem;
  return formattingFoldCount(width, { button, gap: 0.125 * rem, separator: 1 + 0.25 * rem, directionButton });
}

export interface InlineImageUpload {
  src: string;
  cid?: string;
}

const StyledParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...styledBlockAttributes,
      style: { ...styledBlockAttributes.style, parseHTML: paragraphStyleWithoutSpacing },
    };
  },
  // The <br> serializeEditorContent adds to empty lines isn't a hard break.
  parseHTML() {
    return [...(this.parent?.() ?? []), trailingParagraphBreakRule];
  },
});

const StyledHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...styledBlockAttributes,
    };
  },
});

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  onImageUpload?: (file: File) => Promise<InlineImageUpload | null>;
  placeholder?: string;
  className?: string;
  hasError?: boolean;
  onEditorReady?: (editor: Editor) => void;
  /** Recipients an "@" in the text offers to mention; none turns it off. */
  mentionCandidates?: MentionCandidate[];
  /**
   * Contacts matching what was typed after the "@", offered after the
   * recipients. Without it, an "@" offers the recipients only.
   */
  findMentionContacts?: (query: string) => MentionContact[];
  /** The field a picked contact who isn't a recipient yet is added to. */
  mentionAddsTo?: 'to' | 'cc';
  /** A contact was picked who isn't a recipient yet. */
  onMentionAdd?: (candidate: MentionCandidate) => void;
  /**
   * Hide the formatting toolbar on a phone. It wraps onto two rows there and,
   * with the address fields, left little room for the text above the keyboard.
   */
  collapseToolbarOnMobile?: boolean;
  /**
   * Where the formatting toolbar sits: above the text (the default), pinned
   * to the bottom of the editor as Gmail's compose window has it, or folded
   * away entirely.
   */
  toolbarPlacement?: 'top' | 'bottom' | 'hidden';
  /**
   * "short" keeps bold, italic, underline, the lists and link: enough for a
   * few lines such as an out-of-office reply. "full" is the composer's.
   */
  toolbar?: 'full' | 'short';
  /**
   * A "Picture" button that takes a picture's web address (a signature's logo). Pictures
   * pasted or dropped still need onImageUpload.
   */
  pictureFromWeb?: boolean;
  /** The editing area's accessible name ("Message"). */
  ariaLabel?: string;
  /** The body failed validation: exposed as aria-invalid on the editing area. */
  ariaInvalid?: boolean;
  /** The id of the text that explains the error. */
  ariaDescribedBy?: string;
  /** The font and size the text starts in (the sent mail carries them too). */
  defaultTextStyle?: ComposeTextStyle;
  /**
   * The browser's own spell check. Off while a proofreading plugin checks
   * spelling here, so there aren't two sets of underlines.
   */
  spellcheck?: boolean;
  /** The language the text is written in (the writing-language setting). */
  lang?: string;
  /** Proofreading underlines: clicks on them, and keys in the text. */
  textCheck?: TextCheckOptions;
}

/** What the editing area tells assistive technology, besides TipTap's role=textbox. */
export function editorA11yAttributes({ ariaLabel, ariaInvalid, ariaDescribedBy, defaultTextStyle, spellcheck = true, lang }: Pick<RichTextEditorProps, 'ariaLabel' | 'ariaInvalid' | 'ariaDescribedBy' | 'defaultTextStyle' | 'spellcheck' | 'lang'>): Record<string, string> {
  const style = defaultTextStyle ? composeTextStyleCss(defaultTextStyle) : "";
  return {
    class: "tiptap focus-inset min-h-[100px] px-4 py-3 text-sm text-foreground",
    ...(style ? { style } : {}),
    role: "textbox",
    "aria-multiline": "true",
    spellcheck: spellcheck ? "true" : "false",
    ...(lang ? { lang } : {}),
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(ariaInvalid ? { "aria-invalid": "true" } : {}),
    ...(ariaInvalid && ariaDescribedBy ? { "aria-describedby": ariaDescribedBy } : {}),
  };
}

/**
 * One button of the formatting toolbar. `item` names it for the toolbar's
 * roving focus (one Tab stop, arrows inside). A toggle passes `pressed`, a
 * button that opens a popover passes `popup` and `expanded`.
 */
const ToolbarButton = React.forwardRef<HTMLButtonElement, {
  item: string;
  active?: boolean;
  pressed?: boolean;
  popup?: "menu" | "dialog";
  expanded?: boolean;
  onClick: () => void;
  /** A double click keeps the button armed after each use (format painter). */
  onDoubleClick?: () => void;
  /** Keep the editor's focus (and its selection) through the click (format painter). */
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
}>(function ToolbarButton({ item, active, pressed, popup, expanded, onClick, onDoubleClick, onMouseDown, children, title, disabled }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-toolbar-item={item}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseDown={onMouseDown}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={pressed === undefined ? undefined : pressed}
      data-active={active || undefined}
      aria-haspopup={popup}
      aria-expanded={popup ? !!expanded : undefined}
      className={cn(
        // Bigger on a phone, where 28px was hard to hit with a finger.
        "p-1.5 max-md:p-2 rounded hover:bg-accent transition-colors",
        (active || pressed) && "bg-accent text-accent-foreground",
        disabled && "opacity-40 cursor-not-allowed"
      )}
    >
      {children}
    </button>
  );
});

/**
 * What the format painter copies: the four marks the toolbar toggles, the
 * three textStyle attributes, and the heading level (only ever applied —
 * flattening the target's headings would take its lists and code with them).
 */
type PaintedFormat = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string | null;
  backgroundColor: string | null;
  fontSize: string | null;
  heading: 1 | 2 | null;
};

/** The painter while armed: the copied format, the selection it came from
 *  (so re-selecting that same range doesn't apply to itself), and whether a
 *  double click keeps it armed after each use. */
type PainterState = { format: PaintedFormat; from: number; to: number; sticky: boolean };

/**
 * A toolbar popover (font size, colours, table) that works from the
 * keyboard: it takes the focus when it opens (the checked entry, else the
 * first), the arrows move inside it (in a grid with `columns`), and Escape
 * or Tab close it and put the focus back on its button.
 */
function ToolbarPopover({
  label,
  role,
  columns,
  onClose,
  triggerRef,
  className,
  children,
}: {
  label: string;
  role: "menu" | "dialog";
  /** Arrange the leading `[data-grid-item]` entries in rows of this many. */
  columns?: number;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);

  useEffect(() => {
    const list = items();
    const checked = list.find((el) => el.getAttribute("aria-checked") === "true");
    (checked ?? list[0])?.focus();
  }, []);

  // Anchored to its button, it would run off a narrow composer's edge.
  useLayoutEffect(() => {
    const el = ref.current;
    const toolbar = el?.closest('[role="toolbar"]');
    if (!el || !toolbar) return;
    const box = toolbar.getBoundingClientRect();
    const shift = popoverShift(el.getBoundingClientRect(), {
      left: Math.max(box.left, 0),
      right: Math.min(box.right, window.innerWidth),
    });
    if (shift !== 0) el.style.transform = `translateX(${shift}px)`;
    // Too tall for the room under its button (a short window, 150 % zoom): above
    // it when there's more room there, and scrolling inside either way.
    const trigger = triggerRef.current?.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const fit = trigger ? popoverFitHeight({ top: rect.top, height: rect.height }, trigger, window.innerHeight) : null;
    if (fit) {
      if (fit.above) {
        el.style.top = "auto";
        el.style.bottom = "100%";
        el.style.marginTop = "0";
        el.style.marginBottom = "0.25rem";
      }
      el.style.maxHeight = `${fit.maxHeight}px`;
      el.style.overflowY = "auto";
    }
    // triggerRef is a ref: it doesn't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = (returnFocus: boolean) => {
    onClose();
    if (returnFocus) triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const rtl = ref.current ? getComputedStyle(ref.current).direction === "rtl" : false;
    const gridCount = columns ? list.filter((el) => el.hasAttribute("data-grid-item")).length : 0;
    const inGrid = columns && i >= 0 && i < gridCount;
    let next = -1;
    switch (e.key) {
      case "Escape":
      case "Tab":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case "ArrowDown":
        next = inGrid ? (i + columns! < gridCount ? i + columns! : gridCount < list.length ? gridCount : i) : Math.min(i + 1, list.length - 1);
        break;
      case "ArrowUp":
        next = inGrid ? (i - columns! >= 0 ? i - columns! : i) : i === gridCount && gridCount > 0 ? gridCount - 1 : Math.max(i - 1, 0);
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        if (!columns) return;
        const forward = (e.key === "ArrowRight") !== rtl;
        next = forward ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
        break;
      }
      case "Home":
        next = 0;
        break;
      case "End":
        next = list.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    list[next]?.focus();
  };

  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      onKeyDown={onKeyDown}
      // Focus moving out (a click elsewhere, a screen reader jump) closes it.
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to && !ref.current?.contains(to) && !triggerRef.current?.contains(to)) close(false);
      }}
      className={cn("absolute z-50 top-full start-0 mt-1 bg-popover border border-border rounded-md shadow-md", className)}
    >
      {children}
    </div>
  );
}

function ToolbarSeparator() {
  return <div className="w-px h-5 bg-border mx-0.5" />;
}

const TABLE_PICKER_ROWS = 6;
const TABLE_PICKER_COLS = 8;

// Preset text colours (2 x 8). Inline `style="color: …"` survives email
// round-trips; the TextStyle/Color extensions are already registered to
// preserve pasted colours - this palette just adds a UI to set them.
const TEXT_COLORS = [
  "#000000", "#5f6368", "#9aa0a6", "#c5221f", "#e8710a", "#f9ab00", "#188038", "#1967d2",
  "#7627bb", "#c2185b", "#795548", "#fa5252", "#fd7e14", "#40c057", "#4dabf7", "#e64980",
];
// What each swatch is called, for screen readers and the tooltip
// (email_composer.toolbar.colors.*).
const TEXT_COLOR_NAMES: Record<string, string> = {
  "#000000": "black", "#5f6368": "dark_gray", "#9aa0a6": "gray", "#c5221f": "dark_red",
  "#e8710a": "orange", "#f9ab00": "yellow", "#188038": "green", "#1967d2": "blue",
  "#7627bb": "purple", "#c2185b": "dark_pink", "#795548": "brown", "#fa5252": "red",
  "#fd7e14": "light_orange", "#40c057": "light_green", "#4dabf7": "light_blue", "#e64980": "pink",
};

function TableSizePicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const t = useTranslations("email_composer.toolbar");
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  return (
    <div>
      <div
        className="grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${TABLE_PICKER_COLS}, 1fr)` }}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: TABLE_PICKER_ROWS * TABLE_PICKER_COLS }).map((_, i) => {
          const r = Math.floor(i / TABLE_PICKER_COLS);
          const c = i % TABLE_PICKER_COLS;
          const active = hover && r <= hover.r && c <= hover.c;
          return (
            <button
              key={i}
              type="button"
              data-grid-item=""
              aria-label={t("table_size", { rows: r + 1, cols: c + 1 })}
              onMouseEnter={() => setHover({ r, c })}
              onFocus={() => setHover({ r, c })}
              onClick={() => onPick(r + 1, c + 1)}
              className={cn(
                "w-4 h-4 border border-border/60 rounded-[2px] transition-colors",
                active ? "bg-primary border-primary" : "bg-background hover:bg-accent"
              )}
            />
          );
        })}
      </div>
      <div className="text-xs text-muted-foreground mt-1.5 text-center" aria-hidden>
        {hover ? `${hover.r + 1} × ${hover.c + 1}` : t("pick_size")}
      </div>
    </div>
  );
}

type AltRequest = { src: string } | { pos: number };

/** The image an alt-text request is about: a new one by its src (no alt yet), an existing one by position. */
function findAltTarget(editor: Editor, request: AltRequest | undefined): { pos: number; alt: string | null; src: string } | null {
  if (!request) return null;
  const { doc } = editor.state;
  if ("pos" in request) {
    const node = doc.nodeAt(request.pos);
    return node?.type.name === "image" ? { pos: request.pos, alt: node.attrs.alt, src: node.attrs.src } : null;
  }
  let found: { pos: number; alt: string | null; src: string } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "image" && node.attrs.src === request.src && node.attrs.alt == null) {
      found = { pos, alt: null, src: node.attrs.src };
    }
    return !found;
  });
  return found;
}

export function RichTextEditor({
  content,
  onChange,
  onImageUpload,
  pictureFromWeb = false,
  placeholder,
  className,
  hasError,
  onEditorReady,
  mentionCandidates,
  findMentionContacts,
  mentionAddsTo = 'to',
  onMentionAdd,
  collapseToolbarOnMobile = false,
  toolbarPlacement = 'top',
  toolbar = 'full',
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  defaultTextStyle,
  spellcheck = true,
  lang,
  textCheck: textCheckHandlers,
}: RichTextEditorProps) {
  const rtlEditingSupport = useSettingsStore((st) => st.rtlEditingSupport);
  const tComposer = useTranslations("email_composer");
  const tUx = useTranslations("compose_ux");
  const tQuote = useTranslations("email_viewer");
  const onImageUploadRef = React.useRef(onImageUpload);
  onImageUploadRef.current = onImageUpload;
  const onEditorReadyRef = React.useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  const textCheckRef = React.useRef(textCheckHandlers);
  textCheckRef.current = textCheckHandlers;
  // Built once with the editor; reads the latest handlers.
  const [textCheck] = useState(() => createTextCheckExtension(() => ({
    onOpen: (key, anchor, via) => textCheckRef.current?.onOpen(key, anchor, via),
    onKey: (event) => textCheckRef.current?.onKey?.(event) ?? false,
  })));
  const mentionCandidatesRef = React.useRef<MentionCandidate[]>([]);
  mentionCandidatesRef.current = mentionCandidates ?? [];
  // Read on every keystroke after an "@"; the editor is built only once.
  const mentionContactsRef = React.useRef({ findMentionContacts, mentionAddsTo, onMentionAdd });
  mentionContactsRef.current = { findMentionContacts, mentionAddsTo, onMentionAdd };
  const [mention, setMention] = useState<SuggestionProps<MentionCandidate, MentionCandidate> | null>(null);
  const mentionListRef = useRef<RecipientMentionListHandle>(null);
  // Alt+F10 in the text moves to the toolbar, as in other editors.
  const focusToolbarRef = useRef<(() => boolean) | null>(null);
  // Images waiting for a description, one dialog at a time: a new image is
  // found by its src (it has no alt yet), an existing one by its position.
  const [altQueue, setAltQueue] = useState<AltRequest[]>([]);
  // Insert link, for the key handler set up with the editor.
  const addLinkRef = useRef<(() => void) | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        paragraph: false,
        link: false,
        underline: false,
      }),
      StyledParagraph,
      StyledHeading.configure({ levels: [1, 2] }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: "noopener noreferrer nofollow" },
      }),
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      TextStyle,
      Color,
      BackgroundColor,
      FontSize,
      ResizableImage.configure({
        onEditAlt: (pos: number) => setAltQueue((queue) => [...queue, { pos }]),
        editAltLabel: tComposer("image_alt.edit"),
        addAltLabel: tUx("add_description"),
      }),
      Placeholder.configure({
        placeholder,
      }),
      Table.configure({
        resizable: true,
        HTMLAttributes: {
          border: "1",
          cellpadding: "6",
          cellspacing: "0",
          width: "100%",
          style: "width:100%;border-collapse:collapse;",
        },
      }),
      TableRow,
      TableHeader.configure({
        HTMLAttributes: {
          style: "padding:6px 8px;border:1px solid #ccc;background-color:#f5f5f5;color:#1f2937;text-align:left;",
        },
      }),
      TableCell.configure({
        HTMLAttributes: {
          style: "padding:6px 8px;border:1px solid #ccc;vertical-align:top;",
        },
      }),
      // Quoted/forwarded original email body - held verbatim as an atomic
      // node so layout-heavy HTML survives 1:1 (see quoted-html.ts).
      QuotedHtml,
      ReplyQuoteCollapse.configure({ show: tQuote("show_quoted_text"), hide: tQuote("hide_quoted_text") }),
      // Identity signature - held verbatim as a non-editable atomic node so
      // rich/branded signatures keep their inline styling in the editor and
      // in the sent mail (see signature-block.ts). Double-click unlocks it
      // into editable content (#822).
      SignatureBlock.configure({ editHint: tComposer('signature_edit_hint') }),
      TextDirection,
      PlainTextPaste,
      // "@" offers the recipients and inserts a first name (see
      // recipient-mention.tsx). The editor is built once, so the candidates
      // and the list are reached through refs and a stable state setter.
      RecipientMention.configure({
        getCandidates: (query) => {
          const recipients = mentionCandidatesRef.current;
          const { findMentionContacts: find, mentionAddsTo: addsTo } = mentionContactsRef.current;
          return mentionSuggestions(recipients, query && find ? find(query) : [], query, addsTo);
        },
        onPick: (candidate) => {
          if (candidate.addsTo) mentionContactsRef.current.onMentionAdd?.(candidate);
        },
        render: () => ({
          onStart: (props) => setMention(props),
          // Every keystroke first reports a pending lookup with no items;
          // keeping the last list until the new one is in avoids a flicker.
          onUpdate: (props) => {
            if (!props.loading) setMention(props);
          },
          onKeyDown: ({ event }) => mentionListRef.current?.onKeyDown(event) ?? false,
          onExit: () => setMention(null),
        }),
      }),
      textCheck,
    ],
    // One newline per paragraph when copying out as plain text, the inverse
    // of PlainTextPaste: a blank line is an empty paragraph, so the default
    // "\n\n" separator doubled every line break.
    coreExtensionOptions: {
      clipboardTextSerializer: { blockSeparator: "\n" },
    },
    content,
    editorProps: {
      attributes: editorA11yAttributes({ ariaLabel, ariaInvalid, ariaDescribedBy, defaultTextStyle, spellcheck, lang }),
      handleKeyDown: (_view, event) => {
        if (event.altKey && event.key === "F10" && focusToolbarRef.current?.()) {
          event.preventDefault();
          return true;
        }
        // Ctrl+K inserts a link, as in Gmail, Outlook and Word.
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k" && addLinkRef.current) {
          event.preventDefault();
          addLinkRef.current();
          return true;
        }
        return false;
      },
      handleDrop: (view, event) => {
        if (!event.dataTransfer?.files?.length) return false;
        const upload = onImageUploadRef.current;
        const imageFiles = upload
          ? Array.from(event.dataTransfer.files).filter(f => f.type.startsWith("image/"))
          : [];
        // A file dragged from the desktop also carries its path as text
        // (file:///...), which ProseMirror would insert. Claim the drop but
        // let it bubble so the composer attaches the file.
        if (!upload || imageFiles.length === 0) return true;
        event.preventDefault();
        event.stopPropagation();
        for (const file of imageFiles) {
          upload(file).then((result) => {
            if (result) {
              const { state } = view;
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
              // No alt yet (never the file name).
              const node = state.schema.nodes.image.create({ src: result.src, alt: null, cid: result.cid });
              const tr = state.tr.insert(pos?.pos ?? state.selection.anchor, node);
              view.dispatch(tr);
              // No dialog: the image offers "Add description" itself.
            }
          });
        }
        return true;
      },
      handlePaste: (view, event) => {
        const upload = onImageUploadRef.current;
        if (!upload) return false;
        const imageFiles = pastedImageFiles(event.clipboardData);
        if (imageFiles.length === 0) return false;
        event.preventDefault();
        for (const file of imageFiles) {
          upload(file).then((result) => {
            if (result) {
              const { state } = view;
              const node = state.schema.nodes.image.create({ src: result.src, alt: null, cid: result.cid });
              const tr = state.tr.replaceSelectionWith(node);
              view.dispatch(tr);
              // No dialog: the image offers "Add description" itself.
            }
          });
        }
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      // serializeEditorContent (not getHTML) so the verbatim quoted-original
      // HTML held in the QuotedHtml atom node is emitted intact.
      onChange(serializeEditorContent(editor));
    },
    immediatelyRender: false,
  });

  // Sync external content changes (e.g. template application). Compare against
  // the custom serialization so a doc that only differs inside a QuotedHtml
  // island isn't needlessly re-parsed (which would reset the island DOM).
  // What comes in keeps the paragraph spacing it was written with, so a draft
  // from another client is shown and sent the way it was meant (#1416).
  useEffect(() => {
    if (!editor) return;
    const loaded = keepLoadedParagraphSpacing(content);
    if (loaded !== serializeEditorContent(editor)) {
      const caret = editor.state.selection.from;
      editor.commands.setContent(loaded, { emitUpdate: false });
      restoreCaretAfterContentSync(editor, caret);
    }
  }, [content, editor]);

  // The name and error state change after the editor is built (a failed
  // send marks the body invalid): hand them to the editing area.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: editorA11yAttributes({ ariaLabel, ariaInvalid, ariaDescribedBy, defaultTextStyle, spellcheck, lang }),
      },
    });
  }, [editor, ariaLabel, ariaInvalid, ariaDescribedBy, defaultTextStyle, spellcheck, lang]);

  // Re-render the toolbar when what it shows changes, also on a caret move
  // or an image selection that changes no text (the parent re-renders only
  // on text changes), so aria-pressed and the image button stay true.
  useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) return "";
      const style = ed.getAttributes("textStyle");
      return [
        "bold", "italic", "underline", "strike", "bulletList", "orderedList", "blockquote", "codeBlock", "link", "table", "image",
      ].map((name) => ed.isActive(name)).concat(
        ed.isActive("heading", { level: 1 }), ed.isActive("heading", { level: 2 }),
        ed.isActive({ textAlign: "left" }), ed.isActive({ textAlign: "center" }), ed.isActive({ textAlign: "right" }),
      ).join() + `|${style.fontSize ?? ""}|${style.color ?? ""}|${style.backgroundColor ?? ""}|${ed.getAttributes("paragraph").dir ?? ""}`;
    },
  });

  // A request whose image is gone (deleted meanwhile) gives way to the next.
  useEffect(() => {
    if (editor && altQueue.length > 0 && !findAltTarget(editor, altQueue[0])) setAltQueue((queue) => queue.slice(1));
  }, [editor, altQueue]);

  // Expose the editor instance once it's ready so parents can target
  // specific nodes (e.g. swap the embedded signature on identity change).
  useEffect(() => {
    if (editor) onEditorReadyRef.current?.(editor);
  }, [editor]);

  // Mention chips of anyone not in To or Cc are marked, so a mention
  // doesn't quietly name someone who never gets the message.
  useEffect(() => {
    if (editor) setMentionRecipients(editor, mentionCandidates ? mentionCandidates.map((c) => c.email) : null);
  }, [editor, mentionCandidates]);

  // Insert link asks for the text and the address in the app's own dialog
  // (compose-p2-7); on a link it starts from the link's text and address and
  // offers "Remove link". The range is kept from when the dialog opened: the
  // dialog takes the focus, and with it the editor's selection.
  const [linkDialog, setLinkDialog] = useState<{ href: string; text: string; from: number; to: number } | null>(null);
  const [pictureDialog, setPictureDialog] = useState(false);
  const tPicture = useTranslations("ux_p3_settings.picture");
  const addLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    let { from, to } = editor.state.selection;
    // The caret in a link edits the whole link.
    const linkType = editor.schema.marks.link;
    if (previousUrl && from === to && linkType) {
      const range = getMarkRange(editor.state.doc.resolve(from), linkType);
      if (range) ({ from, to } = range);
    }
    const text = editor.state.doc.textBetween(from, to, " ");
    setLinkDialog({ href: previousUrl ?? "", text, from, to });
  }, [editor]);
  addLinkRef.current = addLink;
  const applyLink = useCallback(({ text, href }: { text: string; href: string }) => {
    if (!editor || !linkDialog) return;
    const label = text.trim() ? text : href;
    const { from, to } = linkDialog;
    const chain = editor.chain().focus();
    if (from === to || label !== linkDialog.text) {
      // Nothing selected, or the text changed: the text goes in as the link.
      chain
        .insertContentAt({ from, to }, { type: "text", text: label, marks: [{ type: "link", attrs: { href } }] })
        .setTextSelection(from + label.length)
        .unsetMark("link")
        .run();
      return;
    }
    chain
      .setTextSelection({ from, to })
      .extendMarkRange("link")
      .setLink({ href })
      .run();
  }, [editor, linkDialog]);
  const removeLink = useCallback(() => {
    if (!editor || !linkDialog) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: linkDialog.from, to: linkDialog.to })
      .extendMarkRange("link")
      .unsetLink()
      .run();
  }, [editor, linkDialog]);

  const tToolbar = useTranslations("email_composer.toolbar");
  const tWindows = useTranslations("compose_windows");
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const colorWrapperRef = useRef<HTMLDivElement>(null);
  const [bgColorMenuOpen, setBgColorMenuOpen] = useState(false);
  const bgColorWrapperRef = useRef<HTMLDivElement>(null);
  const [fontSizeMenuOpen, setFontSizeMenuOpen] = useState(false);
  const fontSizeWrapperRef = useRef<HTMLDivElement>(null);
  const fontSizeButtonRef = useRef<HTMLButtonElement>(null);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const bgColorButtonRef = useRef<HTMLButtonElement>(null);
  const tableButtonRef = useRef<HTMLButtonElement>(null);

  // The format painter: one click copies the formatting at the selection and
  // applies it to the next selection, a double click keeps it armed for every
  // selection after that (a word processor's behaviour). Escape, or another
  // click on the button, puts it down.
  const [painter, setPainter] = useState<PainterState | null>(null);
  const armPainter = useCallback(() => {
    if (!editor) return;
    if (painter) { setPainter(null); return; }
    const style = editor.getAttributes("textStyle");
    setPainter({
      format: {
        bold: editor.isActive("bold"),
        italic: editor.isActive("italic"),
        underline: editor.isActive("underline"),
        strike: editor.isActive("strike"),
        // `|| null`, not `?? null`: the Colour extension's parseHTML reads
        // element.style.color, and the CSSOM returns "" (not null) for a
        // property the span never set. A copied "" made the apply's
        // `color ?? backgroundColor ?? fontSize` pick the "" (not nullish),
        // so painting a font size or background colour with no source colour
        // took the no-textStyle branch and applied nothing at all.
        color: style.color || null,
        backgroundColor: style.backgroundColor || null,
        fontSize: style.fontSize || null,
        heading: editor.isActive("heading", { level: 1 }) ? 1
          : editor.isActive("heading", { level: 2 }) ? 2 : null,
      },
      from: editor.state.selection.from,
      to: editor.state.selection.to,
      sticky: false,
    });
    // For the keyboard: the mouse never leaves the editor focused (the
    // button suppresses the focus grab), but pressing the button with
    // Enter/Space does, so put it back — without scrolling, the toolbar
    // sits right beside the editor.
    editor.commands.focus(null, { scrollIntoView: false });
  }, [editor, painter]);
  // A double click arrives after the click that armed it: just make it sticky.
  const makePainterSticky = useCallback(() => {
    setPainter((current) => (current ? { ...current, sticky: true } : current));
  }, []);
  // Applying is replace semantics, as in a word processor: the marks the
  // source didn't have come off the target too. A selection being dragged or
  // extended with shift+arrows fires selectionUpdate at every step, so the
  // apply waits for it to settle — 250ms of quiet, or the mouse button
  // coming up, whichever comes first.
  useEffect(() => {
    if (!editor || !painter) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      const { from, to, empty } = editor.state.selection;
      // Still the selection it was armed with, or just a caret: keep waiting.
      if (empty || (from === painter.from && to === painter.to)) return;
      const { format } = painter;
      // No focus() here: the selection that triggers an apply was just made
      // in the editor, so it has the focus, and focus()'s rAF would clobber
      // the selection in jsdom tests.
      let chain = editor.chain();
      const toggles: [name: string, on: boolean][] = [
        ["bold", format.bold], ["italic", format.italic],
        ["underline", format.underline], ["strike", format.strike],
      ];
      for (const [name, on] of toggles) chain = on ? chain.setMark(name) : chain.unsetMark(name);
      const { color, backgroundColor, fontSize } = format;
      if (color ?? backgroundColor ?? fontSize) {
        // A null attribute clears just that one (how the extensions unsets work).
        chain = chain.setMark("textStyle", { color, backgroundColor, fontSize }).removeEmptyTextStyle();
      } else {
        chain = chain.unsetMark("textStyle");
      }
      if (format.heading) chain = chain.setHeading({ level: format.heading });
      chain.run();
      if (!painter.sticky) setPainter(null);
    };
    const settle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; apply(); }, 250);
    };
    const onMouseUp = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      apply();
    };
    editor.on("selectionUpdate", settle);
    editor.view.dom.addEventListener("mouseup", onMouseUp);
    return () => {
      editor.off("selectionUpdate", settle);
      editor.view.dom.removeEventListener("mouseup", onMouseUp);
      if (timer) clearTimeout(timer);
    };
  }, [editor, painter]);
  useEffect(() => {
    if (!painter) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPainter(null); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [painter]);

  // The toolbar is one Tab stop (roving tabindex): the button that had the
  // focus last keeps it, the arrows, Home and End move inside.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const rovingItemRef = useRef<string | null>(null);
  // Buttons in the "More formatting" panel are the panel's, with its own keys.
  const inRow = (el: HTMLElement) => !el.closest("[data-toolbar-more-panel]");
  const toolbarItems = () =>
    Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("[data-toolbar-item]") ?? [])
      .filter((el) => !el.disabled && inRow(el));
  const syncToolbarTabStops = (focus?: HTMLButtonElement) => {
    const all = Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("[data-toolbar-item]") ?? []).filter(inRow);
    const enabled = all.filter((el) => !el.disabled);
    const current = focus ?? enabled.find((el) => el.dataset.toolbarItem === rovingItemRef.current) ?? enabled[0];
    if (current) rovingItemRef.current = current.dataset.toolbarItem ?? null;
    for (const el of all) el.tabIndex = el === current ? 0 : -1;
  };
  // After every render: buttons come and go (RTL, undo turning disabled).
  useLayoutEffect(() => {
    syncToolbarTabStops();
  });
  focusToolbarRef.current = () => {
    const toolbar = toolbarRef.current;
    if (!toolbar || getComputedStyle(toolbar).display === "none") return false;
    syncToolbarTabStops();
    const stop = toolbar.querySelector<HTMLButtonElement>('[data-toolbar-item][tabindex="0"]');
    stop?.focus();
    return !!stop && document.activeElement === stop;
  };

  // One row: what doesn't fit goes behind "More formatting" (a wrapped
  // second row took the body's room in a narrow composer).
  const [foldCount, setFoldCount] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreWrapperRef = useRef<HTMLDivElement>(null);
  const hasEditor = !!editor;
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const measure = () => setFoldCount(measureFormattingToolbar(toolbar, !!rtlEditingSupport));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      measure();
      setMoreOpen(false);
    });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [hasEditor, rtlEditingSupport]);

  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      if (moreWrapperRef.current && !moreWrapperRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [moreOpen]);

  useEffect(() => {
    if (!fontSizeMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (fontSizeWrapperRef.current && !fontSizeWrapperRef.current.contains(e.target as Node)) {
        setFontSizeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [fontSizeMenuOpen]);

  useEffect(() => {
    if (!colorMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (colorWrapperRef.current && !colorWrapperRef.current.contains(e.target as Node)) {
        setColorMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [colorMenuOpen]);

  useEffect(() => {
    if (!bgColorMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (bgColorWrapperRef.current && !bgColorWrapperRef.current.contains(e.target as Node)) {
        setBgColorMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [bgColorMenuOpen]);

  useEffect(() => {
    if (!tableMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (tableWrapperRef.current && !tableWrapperRef.current.contains(e.target as Node)) {
        setTableMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tableMenuOpen]);

  if (!editor) {
    return (
      <div className={cn("min-h-[100px]", className)} />
    );
  }

  const currentFontSize: string | null = editor.getAttributes("textStyle").fontSize ?? null;
  const currentColor: string | null = editor.getAttributes("textStyle").color ?? null;
  const currentBgColor: string | null = editor.getAttributes("textStyle").backgroundColor ?? null;

  // The image the alt dialog is about, and where it is now.
  const altRequest = altQueue[0];
  const altTarget = findAltTarget(editor, altRequest);
  const imageSelected = editor.isActive("image");

  // A group that doesn't fit renders in the "More formatting" panel instead, in row order.
  const folded = new Set<FoldableGroup>(FOLDABLE_GROUPS.slice(0, foldCount).map((group) => group.id));
  const overflow: React.ReactNode[] = [];
  const short = toolbar === 'short';
  const place = (group: FoldableGroup, node: React.ReactNode) => {
    if (short) return null;
    if (!folded.has(group)) return node;
    overflow.push(<React.Fragment key={group}>{node}</React.Fragment>);
    return null;
  };

  const onToolbarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Keys inside a popover are the popover's.
    if (!target.hasAttribute("data-toolbar-item")) return;
    const items = toolbarItems();
    const i = items.indexOf(target as HTMLButtonElement);
    if (i < 0) return;
    const rtl = toolbarRef.current ? getComputedStyle(toolbarRef.current).direction === "rtl" : false;
    let next: number;
    if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = (i + 1) % items.length;
    else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    syncToolbarTabStops(items[next]);
    items[next].focus();
  };
  const onToolbarFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLButtonElement && target.hasAttribute("data-toolbar-item") && inRow(target)) syncToolbarTabStops(target);
  };

  const renderPalette = (current: string | null, apply: (color: string) => void, removeLabel: string, remove: () => void) => (
    <>
      <div className="grid gap-0.5" style={{ gridTemplateColumns: "repeat(8, 1fr)" }}>
        {TEXT_COLORS.map((color) => {
          const name = tToolbar(`colors.${TEXT_COLOR_NAMES[color]}`);
          return (
            <button
              key={color}
              type="button"
              role="menuitemradio"
              aria-checked={current === color}
              aria-label={name}
              title={name}
              data-grid-item=""
              onClick={() => apply(color)}
              className={cn(
                "w-4 h-4 border border-border/60 rounded-[2px] transition-transform hover:scale-110 focus-visible:scale-110",
                current === color && "ring-1 ring-ring ring-offset-1"
              )}
              style={{ backgroundColor: color }}
            />
          );
        })}
      </div>
      <div className="h-px bg-border my-1.5" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-accent focus-visible:bg-accent text-start w-full"
        onClick={remove}
      >
        <RemoveFormatting className="w-4 h-4" aria-hidden /> {removeLabel}
      </button>
    </>
  );

  const tableMenuItem = (icon: React.ReactNode, label: string, run: () => void, destructive = false) => (
    <button
      type="button"
      role="menuitem"
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent focus-visible:bg-accent text-start",
        destructive && "text-destructive"
      )}
      onClick={() => { run(); setTableMenuOpen(false); }}
    >
      {icon} {label}
    </button>
  );

  return (
    <div className={cn("flex flex-col", hasError && "ring-2 ring-red-500 dark:ring-red-400 rounded", className)}>
      {/* Toolbar - sticky within the composer's scroll container so it stays
          visible while editing long bodies. Its background is the colour
          bg-muted/30 gives over the page, made opaque: the same at rest, and
          body text scrolling underneath stays hidden instead of showing
          through, which a backdrop blur alone did not guarantee (browsers
          that skip backdrop-filter drew the text sharp under the buttons). */}
      <div
        ref={toolbarRef}
        data-testid="rich-text-toolbar"
        role="toolbar"
        aria-label={tComposer("formatting")}
        onKeyDown={onToolbarKeyDown}
        onFocus={onToolbarFocus}
        className={cn(
          "sticky z-20 flex flex-wrap items-center gap-0.5 px-3 py-1.5 bg-[color-mix(in_oklab,var(--color-muted)_30%,var(--color-background))]",
          toolbarPlacement === 'bottom'
            ? "order-last bottom-0 mx-2 mb-1 rounded-lg border border-border/60 shadow-sm"
            : "top-0 border-b border-border/50",
          toolbarPlacement === 'hidden' && "hidden",
          collapseToolbarOnMobile && "max-md:hidden"
        )}
      >
        {/* Font size - two baseline-aligned A's read as "size" at a glance;
            once a size is chosen the button shows that number instead. */}
        {!short && <>
        <div ref={fontSizeWrapperRef} className="relative">
          <ToolbarButton
            ref={fontSizeButtonRef}
            item="font-size"
            active={fontSizeMenuOpen || !!currentFontSize}
            popup="menu"
            expanded={fontSizeMenuOpen}
            onClick={() => setFontSizeMenuOpen((v) => !v)}
            title={currentFontSize ? `${tToolbar("font_size")}: ${currentFontSize}` : tToolbar("font_size")}
          >
            {currentFontSize ? (
              <span className="text-xs font-semibold min-w-6 text-center leading-4 tabular-nums">
                {currentFontSize.replace("px", "")}
              </span>
            ) : (
              <span className="flex items-baseline justify-center leading-none" aria-hidden>
                <span className="text-sm font-semibold">A</span>
                <span className="text-[0.5625rem] font-semibold">A</span>
              </span>
            )}
          </ToolbarButton>
          {fontSizeMenuOpen && (
            <ToolbarPopover
              label={tToolbar("font_size")}
              role="menu"
              triggerRef={fontSizeButtonRef}
              onClose={() => setFontSizeMenuOpen(false)}
              className="p-1 min-w-[64px]"
            >
              {FONT_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  role="menuitemradio"
                  aria-checked={currentFontSize === size}
                  onClick={() => {
                    editor.chain().focus().setFontSize(size).run();
                    setFontSizeMenuOpen(false);
                  }}
                  className={cn(
                    "block w-full text-start px-2 py-1 rounded hover:bg-accent focus-visible:bg-accent transition-colors",
                    currentFontSize === size && "bg-accent text-accent-foreground"
                  )}
                  style={{ fontSize: size, lineHeight: 1.4 }}
                >
                  {size}
                </button>
              ))}
              <div className="h-px bg-border my-1" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-accent focus-visible:bg-accent text-start w-full"
                onClick={() => {
                  editor.chain().focus().unsetFontSize().run();
                  setFontSizeMenuOpen(false);
                }}
              >
                <RemoveFormatting className="w-4 h-4" aria-hidden /> {tToolbar("font_size_default")}
              </button>
            </ToolbarPopover>
          )}
        </div>

        <ToolbarSeparator />
        </>}

        <ToolbarButton
          item="bold"
          pressed={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title={tToolbar("bold")}
        >
          <Bold className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          item="italic"
          pressed={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title={tToolbar("italic")}
        >
          <Italic className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          item="underline"
          pressed={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          title={tToolbar("underline")}
        >
          <UnderlineIcon className="w-4 h-4" />
        </ToolbarButton>
        {!short && <>
        <ToolbarButton
          item="strike"
          pressed={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title={tToolbar("strikethrough")}
        >
          <Strikethrough className="w-4 h-4" />
        </ToolbarButton>
        <div ref={colorWrapperRef} className="relative">
          <ToolbarButton
            ref={colorButtonRef}
            item="text-color"
            active={!!currentColor}
            popup="menu"
            expanded={colorMenuOpen}
            onClick={() => setColorMenuOpen((v) => !v)}
            title={tToolbar("text_color")}
          >
            {/* The icon itself previews the active colour - no layout shift. */}
            <Baseline className="w-4 h-4" style={{ color: currentColor || undefined }} />
          </ToolbarButton>
          {colorMenuOpen && (
            <ToolbarPopover
              label={tToolbar("text_color")}
              role="menu"
              columns={8}
              triggerRef={colorButtonRef}
              onClose={() => setColorMenuOpen(false)}
              className="p-2"
            >
              {renderPalette(
                currentColor,
                (color) => {
                  editor.chain().focus().setColor(color).run();
                  setColorMenuOpen(false);
                },
                tToolbar("remove_color"),
                () => {
                  editor.chain().focus().unsetColor().run();
                  setColorMenuOpen(false);
                }
              )}
            </ToolbarPopover>
          )}
        </div>
        {/* Background color - same palette, same grid and same swatch
            styling as the text-colour picker above, so the two controls
            read as siblings. The highlighter glyph previews the active
            tint on its little bar. Inline style="background-color: …"
            survives email round-trips like `color` does. */}
        <div ref={bgColorWrapperRef} className="relative">
          <ToolbarButton
            ref={bgColorButtonRef}
            item="background-color"
            active={!!currentBgColor}
            popup="menu"
            expanded={bgColorMenuOpen}
            onClick={() => setBgColorMenuOpen((v) => !v)}
            title={tToolbar("background_color")}
          >
            <span className="relative inline-flex items-center justify-center">
              <Highlighter className="w-4 h-4" />
              <span
                aria-hidden
                className="absolute -bottom-[3px] left-1/2 h-[3px] w-3 -translate-x-1/2 rounded-[1px] border border-border/40"
                style={{ backgroundColor: currentBgColor || undefined }}
              />
            </span>
          </ToolbarButton>
          {bgColorMenuOpen && (
            <ToolbarPopover
              label={tToolbar("background_color")}
              role="menu"
              columns={8}
              triggerRef={bgColorButtonRef}
              onClose={() => setBgColorMenuOpen(false)}
              className="p-2"
            >
              {renderPalette(
                currentBgColor,
                (color) => {
                  editor.chain().focus().setBackgroundColor(color).run();
                  setBgColorMenuOpen(false);
                },
                tToolbar("remove_background_color"),
                () => {
                  editor.chain().focus().unsetBackgroundColor().run();
                  setBgColorMenuOpen(false);
                }
              )}
            </ToolbarPopover>
          )}
        </div>
        </>}

        <ToolbarSeparator />

        {place("headings", <>
        <ToolbarButton
          item="heading-1"
          pressed={editor.isActive("heading", { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title={tToolbar("heading_1")}
        >
          <Heading1 className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          item="heading-2"
          pressed={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title={tToolbar("heading_2")}
        >
          <Heading2 className="w-4 h-4" />
        </ToolbarButton>

        <ToolbarSeparator />
        </>)}

        <ToolbarButton
          item="bullet-list"
          pressed={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title={tToolbar("bullet_list")}
        >
          <List className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          item="ordered-list"
          pressed={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title={tToolbar("ordered_list")}
        >
          <ListOrdered className="w-4 h-4" />
        </ToolbarButton>
        {place("blocks", <>
        <ToolbarButton
          item="quote"
          pressed={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title={tToolbar("quote")}
        >
          <Quote className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          item="code-block"
          pressed={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title={tToolbar("code_block")}
        >
          <Code className="w-4 h-4" />
        </ToolbarButton>
        </>)}

        <ToolbarSeparator />

        {place("align", <>
        <ToolbarButton
          item="align-left"
          pressed={editor.isActive({ textAlign: "left" })}
          onClick={() => editor.chain().focus().setTextAlign("left").run()}
          title={tToolbar("align_left")}
        >
          <AlignLeft className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          item="align-center"
          pressed={editor.isActive({ textAlign: "center" })}
          onClick={() => editor.chain().focus().setTextAlign("center").run()}
          title={tToolbar("align_center")}
        >
          <AlignCenter className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          item="align-right"
          pressed={editor.isActive({ textAlign: "right" })}
          onClick={() => editor.chain().focus().setTextAlign("right").run()}
          title={tToolbar("align_right")}
        >
          <AlignRight className="w-4 h-4" />
        </ToolbarButton>

        {rtlEditingSupport && (
          <ToolbarButton
            item="text-direction"
            pressed={
              (editor.getAttributes("paragraph").dir || editor.getAttributes("heading").dir) === "rtl"
            }
            onClick={() => {
              const cur =
                editor.getAttributes("paragraph").dir || editor.getAttributes("heading").dir;
              editor.chain().focus().setTextDirection(cur === "rtl" ? "ltr" : "rtl").run();
            }}
            title={tToolbar("text_direction")}
          >
            <ArrowLeftRight className="w-4 h-4" />
          </ToolbarButton>
        )}

        <ToolbarSeparator />
        </>)}

        <ToolbarButton
          item="link"
          active={editor.isActive("link")}
          popup="dialog"
          expanded={!!linkDialog}
          onClick={addLink}
          title={tToolbar("link")}
        >
          <LinkIcon className="w-4 h-4" />
        </ToolbarButton>

        {pictureFromWeb && (
          <ToolbarButton
            item="picture"
            popup="dialog"
            expanded={pictureDialog}
            onClick={() => setPictureDialog(true)}
            title={tPicture("button")}
          >
            <ImageIcon className="w-4 h-4" />
          </ToolbarButton>
        )}

        {imageSelected && (
          <ToolbarButton
            item="image-alt"
            popup="dialog"
            expanded={!!altRequest}
            onClick={() => setAltQueue((queue) => [...queue, { pos: editor.state.selection.from }])}
            title={tComposer("image_alt.edit")}
          >
            <ImageIcon className="w-4 h-4" />
          </ToolbarButton>
        )}

        {place("table", <div ref={tableWrapperRef} className="relative">
          <ToolbarButton
            ref={tableButtonRef}
            item="table"
            active={editor.isActive("table")}
            popup={editor.isActive("table") ? "menu" : "dialog"}
            expanded={tableMenuOpen}
            onClick={() => setTableMenuOpen((v) => !v)}
            title={tToolbar("table")}
          >
            <TableIcon className="w-4 h-4" />
          </ToolbarButton>
          {tableMenuOpen && (
            editor.isActive("table") ? (
              <ToolbarPopover
                label={tToolbar("table")}
                role="menu"
                triggerRef={tableButtonRef}
                onClose={() => setTableMenuOpen(false)}
                className="p-2 min-w-[200px]"
              >
                <div className="flex flex-col gap-0.5">
                  {tableMenuItem(<Rows3 className="w-4 h-4" aria-hidden />, tToolbar("add_row_above"), () => editor.chain().focus().addRowBefore().run())}
                  {tableMenuItem(<Rows3 className="w-4 h-4" aria-hidden />, tToolbar("add_row_below"), () => editor.chain().focus().addRowAfter().run())}
                  {tableMenuItem(<Columns3 className="w-4 h-4" aria-hidden />, tToolbar("add_column_before"), () => editor.chain().focus().addColumnBefore().run())}
                  {tableMenuItem(<Columns3 className="w-4 h-4" aria-hidden />, tToolbar("add_column_after"), () => editor.chain().focus().addColumnAfter().run())}
                  <div className="h-px bg-border my-1" role="separator" />
                  {tableMenuItem(<Trash2 className="w-4 h-4" aria-hidden />, tToolbar("delete_row"), () => editor.chain().focus().deleteRow().run())}
                  {tableMenuItem(<Trash2 className="w-4 h-4" aria-hidden />, tToolbar("delete_column"), () => editor.chain().focus().deleteColumn().run())}
                  {tableMenuItem(<Rows3 className="w-4 h-4" aria-hidden />, tToolbar("toggle_header_row"), () => editor.chain().focus().toggleHeaderRow().run())}
                  <div className="h-px bg-border my-1" role="separator" />
                  {tableMenuItem(<Trash2 className="w-4 h-4" aria-hidden />, tToolbar("delete_table"), () => editor.chain().focus().deleteTable().run(), true)}
                </div>
              </ToolbarPopover>
            ) : (
              <ToolbarPopover
                label={tToolbar("table")}
                role="dialog"
                columns={TABLE_PICKER_COLS}
                triggerRef={tableButtonRef}
                onClose={() => setTableMenuOpen(false)}
                className="p-2 min-w-[200px]"
              >
                <TableSizePicker
                  onPick={(rows, cols) => {
                    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
                    setTableMenuOpen(false);
                  }}
                />
              </ToolbarPopover>
            )
          )}
        </div>)}

        {place("history", <>
        <ToolbarSeparator />

        <ToolbarButton
          item="format-painter"
          pressed={painter !== null}
          onClick={armPainter}
          onDoubleClick={makePainterSticky}
          onMouseDown={(event) => event.preventDefault()}
          title={tToolbar("format_painter")}
        >
          <FormatPainter className="w-4 h-4" />
        </ToolbarButton>

        <ToolbarButton
          item="clear-formatting"
          onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
          title={tToolbar("clear_formatting")}
        >
          <RemoveFormatting className="w-4 h-4" />
        </ToolbarButton>

        <ToolbarSeparator />

        <ToolbarButton
          item="undo"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          title={tToolbar("undo")}
        >
          <Undo className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          item="redo"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          title={tToolbar("redo")}
        >
          <Redo className="w-4 h-4" />
        </ToolbarButton>
        </>)}

        {overflow.length > 0 && (
          <div ref={moreWrapperRef} className="relative">
            <ToolbarButton
              ref={moreButtonRef}
              item="more-formatting"
              popup="dialog"
              expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              title={tWindows("more_formatting")}
            >
              <Ellipsis className="w-4 h-4" />
            </ToolbarButton>
            {moreOpen && (
              <ToolbarPopover
                label={tWindows("more_formatting")}
                role="dialog"
                triggerRef={moreButtonRef}
                onClose={() => setMoreOpen(false)}
                className="p-1 flex w-max max-w-[16rem] flex-wrap items-center gap-0.5"
              >
                <div data-toolbar-more-panel="" className="contents">
                  {overflow}
                </div>
              </ToolbarPopover>
            )}
          </div>
        )}
      </div>

      {/* Editor */}
      <EditorContent editor={editor} />

      <MentionChipCard
        editor={editor}
        recipients={mentionCandidates}
        findContacts={findMentionContacts}
        addsTo={mentionAddsTo}
        onAdd={onMentionAdd}
      />

      {mention && mention.items.length > 0 && createPortal(
        <RecipientMentionList
          ref={mentionListRef}
          editor={mention.editor}
          items={mention.items}
          command={mention.command}
          mount={mention.mount}
        />,
        document.body
      )}

      {pictureFromWeb && (
        <ImageUrlDialog
          isOpen={pictureDialog}
          onClose={() => setPictureDialog(false)}
          onSubmit={({ src, alt }) => {
            editor.chain().focus().insertContent({ type: "image", attrs: { src, alt: alt || null } }).run();
          }}
        />
      )}

      <LinkDialog
        isOpen={!!linkDialog}
        onClose={() => setLinkDialog(null)}
        defaultText={linkDialog?.text ?? ""}
        defaultHref={linkDialog?.href ?? ""}
        onSubmit={({ text, href }) => applyLink({ text, href: withLinkScheme(href) })}
        onRemove={linkDialog?.href ? removeLink : undefined}
      />

      <ImageAltDialog
        isOpen={!!altTarget}
        currentAlt={altTarget?.alt ?? null}
        src={altTarget?.src}
        onSave={(alt) => {
          const target = findAltTarget(editor, altRequest);
          if (!target) return;
          editor.chain().command(({ tr }) => {
            const node = tr.doc.nodeAt(target.pos);
            if (!node) return false;
            tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, alt });
            return true;
          }).run();
        }}
        onClose={() => setAltQueue((queue) => queue.slice(1))}
      />
    </div>
  );
}
