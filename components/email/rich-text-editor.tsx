"use client";

import React, { useEffect, useCallback, useLayoutEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import type { SuggestionProps } from "@tiptap/suggestion";
import { Slice, DOMParser as EditorDOMParser } from '@tiptap/pm/model';
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import Heading from "@tiptap/extension-heading";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextDirection } from "@/components/email/text-direction";
import { normalizeComposeHtml, markdownToComposeHtml, looksLikeMarkdown, COMPOSE_FONTS } from '@/.memail/compose-content';
import { clearComposeFormatting, setComposeLineHeight, composeLineHeightValue } from '@/.memail/compose-formatting';
import { paragraphSpacingValue, setParagraphSpacing } from '@/.memail/paragraph-spacing';
import { ComposeImportDialog } from '@/.memail/compose-import-dialog';
import { PlainTextPaste } from "@/components/email/plain-text-paste";
import { pastedImageFiles } from "@/components/email/paste-images";
import { TextStyle, BackgroundColor, FontFamily, LineHeight } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { FontSize, FONT_SIZES, composeTextStyleCss, type ComposeTextStyle } from "@/components/email/font-size";
import { ResizableImage } from "@/components/email/resizable-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { ReplyQuoteCollapse } from "@/components/email/reply-quote-collapse";
import { QuotedHtml, serializeEditorContent } from "@/components/email/quoted-html";
import { keepLoadedParagraphSpacing, paragraphStyleWithoutSpacing, trailingParagraphBreakRule } from "@/components/email/paragraph-breaks";
import { SignatureBlock } from "@/components/email/signature-block";
import { styledBlockAttributes } from "@/components/email/styled-block-attributes";
import { RecipientMention, RecipientMentionList, type RecipientMentionListHandle } from "@/components/email/recipient-mention";
import { MentionChipCard, setMentionRecipients } from "@/components/email/mention-chip";
import { mentionSuggestions, type MentionCandidate, type MentionContact } from "@/lib/recipient-mentions";
import { cn } from "@/lib/utils";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { ImageAltDialog } from "@/components/email/image-alt-dialog";

/** A typed address without a scheme ("example.com") becomes a web link. */
export function withLinkScheme(value: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("#") || value.startsWith("/")
    ? value
    : `https://${value}`;
}
import { useSettingsStore } from "@/stores/settings-store";
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
  Table as TableIcon,
  Baseline,
  Highlighter,
  Trash2,
  Rows3,
  Columns3,
  ImageIcon,
} from "@/components/icons";

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

const StyledTableCell = TableCell.extend({
  addAttributes() { return {...this.parent?.(), style:styledBlockAttributes.style}; },
});
const StyledTableHeader = TableHeader.extend({
  addAttributes() { return {...this.parent?.(), style:styledBlockAttributes.style}; },
});

/** Menu choices share the formatting toolbar's keyboard and focus behavior. */
function ToolbarChoice({item,label,value,choices,onSelect,buttonLabel}: {
  item:string; label:string; value:string; buttonLabel?:string;
  choices:{value:string;label:string}[]; onSelect:(value:string)=>void;
}) {
  const [open,setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event:PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown',dismiss);
    return () => document.removeEventListener('pointerdown',dismiss);
  },[open]);
  return <div ref={wrapper} className="relative">
    <ToolbarButton ref={trigger} item={item} title={label} popup="menu" expanded={open} active={open} onClick={()=>setOpen(v=>!v)}>
      <span className="px-1 text-xs">{buttonLabel ?? choices.find(choice=>choice.value===value)?.label ?? label}</span>
    </ToolbarButton>
    {open && <ToolbarPopover label={label} role="menu" triggerRef={trigger} onClose={()=>setOpen(false)} className="min-w-40 p-1">
      {choices.map(choice=><button key={choice.value} type="button" role="menuitemradio" aria-checked={choice.value===value}
        className="block w-full rounded px-3 py-2 text-start text-sm hover:bg-accent focus-visible:bg-accent"
        onClick={()=>{onSelect(choice.value);setOpen(false);}}>{choice.label}</button>)}
    </ToolbarPopover>}
  </div>;
}

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
  /** The editing area's accessible name ("Message"). */
  ariaLabel?: string;
  /** The body failed validation: exposed as aria-invalid on the editing area. */
  ariaInvalid?: boolean;
  /** The id of the text that explains the error. */
  ariaDescribedBy?: string;
  /** The font and size the text starts in (the sent mail carries them too). */
  defaultTextStyle?: ComposeTextStyle;
}

/** What the editing area tells assistive technology, besides TipTap's role=textbox. */
export function editorA11yAttributes({ ariaLabel, ariaInvalid, ariaDescribedBy, defaultTextStyle }: Pick<RichTextEditorProps, 'ariaLabel' | 'ariaInvalid' | 'ariaDescribedBy' | 'defaultTextStyle'>): Record<string, string> {
  const style = defaultTextStyle ? composeTextStyleCss(defaultTextStyle) : "";
  return {
    class: "tiptap min-h-[100px] px-4 py-3 text-sm text-foreground",
    ...(style ? { style } : {}),
    role: "textbox",
    "aria-multiline": "true",
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
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
}>(function ToolbarButton({ item, active, pressed, popup, expanded, onClick, children, title, disabled }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-toolbar-item={item}
      onClick={onClick}
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
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
  defaultTextStyle,
}: RichTextEditorProps) {
  const rtlEditingSupport = useSettingsStore((st) => st.rtlEditingSupport);
  const tComposer = useTranslations("email_composer");
  const tQuote = useTranslations("email_viewer");
  const plainPasteRequested = useRef(false);
  const onImageUploadRef = React.useRef(onImageUpload);
  onImageUploadRef.current = onImageUpload;
  const onEditorReadyRef = React.useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
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

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        paragraph: false,
        link: false,
        underline: false,
      }),
      StyledParagraph,
      StyledHeading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: "noopener noreferrer nofollow" },
      }),
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
      TextStyle,
      FontFamily,
      LineHeight,
      Color,
      BackgroundColor,
      FontSize,
      ResizableImage.configure({
        onEditAlt: (pos: number) => setAltQueue((queue) => [...queue, { pos }]),
        editAltLabel: tComposer("image_alt.edit"),
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
      StyledTableHeader.configure({
        HTMLAttributes: {
          style: "padding:6px 8px;border:1px solid #ccc;background-color:#f5f5f5;color:#1f2937;text-align:left;",
        },
      }),
      StyledTableCell.configure({
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
    ],
    // One newline per paragraph when copying out as plain text, the inverse
    // of PlainTextPaste: a blank line is an empty paragraph, so the default
    // "\n\n" separator doubled every line break.
    coreExtensionOptions: {
      clipboardTextSerializer: { blockSeparator: "\n" },
    },
    content,
    editorProps: {
      transformPastedHTML: normalizeComposeHtml,
      transformPasted: (slice, view) => view.state.selection.$from.parent.content.size === 0 && slice.content.firstChild?.isBlock
        ? new Slice(slice.content, 0, 0) : slice,
      attributes: editorA11yAttributes({ ariaLabel, ariaInvalid, ariaDescribedBy, defaultTextStyle }),
      handleDOMEvents: { keydown: (_view, event) => {
        if (event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey)) plainPasteRequested.current = event.shiftKey;
        else if (!['Shift','Control','Meta'].includes(event.key)) plainPasteRequested.current = false;
        return false;
      } },
      handleKeyDown: (_view, event) => {
        if (event.altKey && event.key === "F10" && focusToolbarRef.current?.()) {
          event.preventDefault();
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
              // No alt yet (never the file name): the user is asked next.
              const node = state.schema.nodes.image.create({ src: result.src, alt: null, cid: result.cid });
              const tr = state.tr.insert(pos?.pos ?? state.selection.anchor, node);
              view.dispatch(tr);
              setAltQueue((queue) => [...queue, { src: result.src }]);
            }
          });
        }
        return true;
      },
      handlePaste: (view, event) => {
        if (plainPasteRequested.current) {
          plainPasteRequested.current = false;
          const text = event.clipboardData?.getData('text/plain');
          if (text === undefined) return false;
          event.preventDefault();
          if (view.state.selection.$from.parent.type.spec.code) {
            view.dispatch(view.state.tr.insertText(text).scrollIntoView());
          } else {
            const container = document.createElement('div');
            for (const line of text.split(/\r\n?|\n/)) {
              const paragraph = document.createElement('p');
              paragraph.textContent = line;
              container.append(paragraph);
            }
            view.dispatch(view.state.tr.replaceSelection(EditorDOMParser.fromSchema(view.state.schema).parseSlice(container)).scrollIntoView());
          }
          return true;
        }
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const html = event.clipboardData?.getData('text/html') ?? '';
        // Rich HTML wins when supplied by Docs/Word/chat apps. Plain Markdown
        // is converted only when recognizable, and never inside code blocks.
        if (!html && !view.state.selection.$from.parent.type.spec.code && looksLikeMarkdown(text)) {
          event.preventDefault();
          const container = document.createElement('div');
          container.innerHTML = markdownToComposeHtml(text);
          view.dispatch(view.state.tr.replaceSelection(EditorDOMParser.fromSchema(view.state.schema).parseSlice(container)).scrollIntoView());
          return true;
        }
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
              setAltQueue((queue) => [...queue, { src: result.src }]);
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
      editor.commands.setContent(loaded, { emitUpdate: false });
    }
  }, [content, editor]);

  // The name and error state change after the editor is built (a failed
  // send marks the body invalid): hand them to the editing area.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: editorA11yAttributes({ ariaLabel, ariaInvalid, ariaDescribedBy, defaultTextStyle }),
      },
    });
  }, [editor, ariaLabel, ariaInvalid, ariaDescribedBy, defaultTextStyle]);

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
      ).join() + `|${ed.getAttributes("heading").style ?? ""}|${ed.getAttributes("heading").level ?? ""}|${style.fontFamily ?? ""}|${style.fontSize ?? ""}|${style.color ?? ""}|${style.backgroundColor ?? ""}|${ed.getAttributes("paragraph").style ?? ""}|${ed.getAttributes("paragraph").dir ?? ""}`;
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

  // Insert link asks for the address in the app's own dialog; on a link it
  // starts from the current address and offers "Remove link".
  // The selection is kept from when the dialog opened: the dialog takes the
  // focus, and with it the editor's selection.
  const [linkDialog, setLinkDialog] = useState<{ href: string; from: number; to: number } | null>(null);
  const addLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    const { from, to } = editor.state.selection;
    setLinkDialog({ href: previousUrl ?? "", from, to });
  }, [editor]);
  const applyLink = useCallback((url: string) => {
    if (!editor || !linkDialog) return;
    editor
      .chain()
      .focus()
      .setTextSelection({ from: linkDialog.from, to: linkDialog.to })
      .extendMarkRange("link")
      .setLink({ href: url })
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
  const tCommon = useTranslations("common");
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  const tableWrapperRef = useRef<HTMLDivElement>(null);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const colorWrapperRef = useRef<HTMLDivElement>(null);
  const [bgColorMenuOpen, setBgColorMenuOpen] = useState(false);
  const bgColorWrapperRef = useRef<HTMLDivElement>(null);
  const [fontFamilyOpen, setFontFamilyOpen] = useState(false);
  const fontFamilyButtonRef = useRef<HTMLButtonElement>(null);
  const fontFamilyWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fontFamilyOpen) return;
    const dismiss = (event:MouseEvent) => { if (event.target instanceof Node && !fontFamilyWrapperRef.current?.contains(event.target)) setFontFamilyOpen(false); };
    document.addEventListener('mousedown',dismiss);
    return () => document.removeEventListener('mousedown',dismiss);
  },[fontFamilyOpen]);
  const [importOpen, setImportOpen] = useState(false);
  const [fontSizeMenuOpen, setFontSizeMenuOpen] = useState(false);
  const fontSizeWrapperRef = useRef<HTMLDivElement>(null);
  const fontSizeButtonRef = useRef<HTMLButtonElement>(null);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const bgColorButtonRef = useRef<HTMLButtonElement>(null);
  const tableButtonRef = useRef<HTMLButtonElement>(null);

  // The toolbar is one Tab stop (roving tabindex): the button that had the
  // focus last keeps it, the arrows, Home and End move inside.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const rovingItemRef = useRef<string | null>(null);
  const toolbarItems = () =>
    Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("[data-toolbar-item]") ?? [])
      .filter((el) => !el.disabled);
  const syncToolbarTabStops = (focus?: HTMLButtonElement) => {
    const all = Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("[data-toolbar-item]") ?? []);
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
    if (target instanceof HTMLButtonElement && target.hasAttribute("data-toolbar-item")) syncToolbarTabStops(target);
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

        <ToolbarSeparator />

        <ToolbarChoice
          item="text-style" label="Text style"
          value={String(editor.getAttributes('heading').level ?? 0)}
          choices={[
            {value:'0',label:'Normal text'},
            ...([1,2,3,4,5,6] as const).map(level => ({value:String(level),label:`Heading ${level}`})),
          ]}
          onSelect={value => {
            if (value === '0') editor.chain().focus().setParagraph().run();
            else editor.chain().focus().setHeading({level:Number(value) as 1|2|3|4|5|6}).run();
          }}
        />

        <ToolbarSeparator />

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

        <ToolbarSeparator />

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

        <div ref={tableWrapperRef} className="relative">
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
        </div>

        <ToolbarSeparator />

        <div ref={fontFamilyWrapperRef} className="relative">
          <ToolbarButton ref={fontFamilyButtonRef} item="font-family" title="Font family" popup="menu" expanded={fontFamilyOpen} active={fontFamilyOpen} onClick={()=>setFontFamilyOpen(v=>!v)}><span className="px-1 text-xs">Font</span></ToolbarButton>
          {fontFamilyOpen && <ToolbarPopover label="Font family" role="menu" triggerRef={fontFamilyButtonRef} onClose={()=>setFontFamilyOpen(false)} className="min-w-48 p-1">
            {([['Default font',''],...COMPOSE_FONTS] as const).map(([name,value])=><button key={name} type="button" role="menuitemradio" aria-checked={(editor.getAttributes('textStyle').fontFamily ?? '')===value} className="block w-full rounded px-3 py-2 text-start text-sm hover:bg-accent focus-visible:bg-accent" style={{fontFamily:value || undefined}} onClick={()=>{if(value) editor.chain().focus().setFontFamily(value).run(); else editor.chain().focus().unsetFontFamily().run(); setFontFamilyOpen(false);}}>{name}</button>)}
          </ToolbarPopover>}
        </div>
        <ToolbarChoice item="paragraph-spacing" label="Paragraph spacing" buttonLabel="Spacing"
          value={paragraphSpacingValue(editor.getAttributes('paragraph').style)}
          choices={[{value:'4px',label:'Compact'},{value:'1em',label:'Comfortable'},{value:'1.5em',label:'Spacious'}]}
          onSelect={value=>{setParagraphSpacing(editor,value);}} />
        <ToolbarChoice item="line-height" label="Line height" buttonLabel="Line height"
          value={composeLineHeightValue(editor)}
          choices={[{value:'',label:'Default line height'},{value:'1.15',label:'1.15 lines'},{value:'1.5',label:'1.5 lines'},{value:'1.75',label:'1.75 lines'},{value:'2',label:'Double spaced'}]}
          onSelect={value=>{setComposeLineHeight(editor,value);}} />
        <ToolbarButton item="insert-source" title="Insert Markdown or HTML" onClick={()=>setImportOpen(true)}><Code className="size-4" /></ToolbarButton>
        <ToolbarButton
          item="clear-formatting"
          onClick={() => clearComposeFormatting(editor)}
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

      {importOpen && <ComposeImportDialog onClose={()=>setImportOpen(false)} onInsert={html=>editor.chain().focus().insertContent(html).run()} />}
      <PromptDialog
        isOpen={!!linkDialog}
        onClose={() => setLinkDialog(null)}
        title={linkDialog?.href ? tToolbar("edit_link") : tToolbar("insert_link")}
        placeholder={tToolbar("link_address")}
        defaultValue={linkDialog?.href ?? ""}
        confirmText={tCommon("save")}
        validate={(value) => (/\s/.test(value) ? tToolbar("link_invalid") : null)}
        onSubmit={(value) => applyLink(withLinkScheme(value))}
        extraAction={linkDialog?.href ? { label: tToolbar("remove_link"), onClick: removeLink } : undefined}
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
