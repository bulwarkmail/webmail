"use client";

import React, { useEffect, useCallback, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
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
import { FontSize, FONT_SIZES } from "@/components/email/font-size";
import { tabIndentKeyDown } from "@/components/email/tab-indent";
import { ResizableImage } from "@/components/email/resizable-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { QuotedHtml, serializeEditorContent } from "@/components/email/quoted-html";
import { paragraphStyleWithoutSpacing, trailingParagraphBreakRule } from "@/components/email/paragraph-breaks";
import { SignatureBlock } from "@/components/email/signature-block";
import { styledBlockAttributes } from "@/components/email/styled-block-attributes";
import { RecipientMention, RecipientMentionList, type RecipientMentionListHandle } from "@/components/email/recipient-mention";
import { MentionChipCard, setMentionRecipients } from "@/components/email/mention-chip";
import { mentionSuggestions, type MentionCandidate, type MentionContact } from "@/lib/recipient-mentions";
import { cn } from "@/lib/utils";
import { PromptDialog } from "@/components/ui/prompt-dialog";

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
  Heading1,
  Heading2,
  Table as TableIcon,
  Baseline,
  Highlighter,
  Trash2,
  Rows3,
  Columns3,
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
}

function ToolbarButton({
  active,
  onClick,
  children,
  title,
  disabled,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        // Bigger on a phone, where 28px was hard to hit with a finger.
        "p-1.5 max-md:p-2 rounded hover:bg-accent transition-colors",
        active && "bg-accent text-accent-foreground",
        disabled && "opacity-40 cursor-not-allowed"
      )}
    >
      {children}
    </button>
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
              onMouseEnter={() => setHover({ r, c })}
              onClick={() => onPick(r + 1, c + 1)}
              className={cn(
                "w-4 h-4 border border-border/60 rounded-[2px] transition-colors",
                active ? "bg-primary border-primary" : "bg-background hover:bg-accent"
              )}
            />
          );
        })}
      </div>
      <div className="text-xs text-muted-foreground mt-1.5 text-center">
        {hover ? `${hover.r + 1} × ${hover.c + 1}` : t("pick_size")}
      </div>
    </div>
  );
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
}: RichTextEditorProps) {
  const rtlEditingSupport = useSettingsStore((st) => st.rtlEditingSupport);
  const tComposer = useTranslations("email_composer");
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
      ResizableImage,
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
      attributes: {
        class: "tiptap min-h-[100px] px-4 py-3 text-sm text-foreground",
      },
      // Tab indents instead of leaving the editor (see tab-indent.ts for
      // why it inserts non-breaking spaces and defers inside lists/tables).
      handleKeyDown: tabIndentKeyDown,
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
              const node = state.schema.nodes.image.create({ src: result.src, alt: file.name, cid: result.cid });
              const tr = state.tr.insert(pos?.pos ?? state.selection.anchor, node);
              view.dispatch(tr);
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
              const node = state.schema.nodes.image.create({ src: result.src, alt: file.name, cid: result.cid });
              const tr = state.tr.replaceSelectionWith(node);
              view.dispatch(tr);
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
  useEffect(() => {
    if (editor && content !== serializeEditorContent(editor)) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [content, editor]);

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
  const [fontSizeMenuOpen, setFontSizeMenuOpen] = useState(false);
  const fontSizeWrapperRef = useRef<HTMLDivElement>(null);

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
  const currentBgColor: string | null = editor.getAttributes("textStyle").backgroundColor ?? null;

  return (
    <div className={cn("flex flex-col", hasError && "ring-2 ring-red-500 dark:ring-red-400 rounded", className)}>
      {/* Toolbar - sticky within the composer's scroll container so it stays
          visible while editing long bodies. Its background is the colour
          bg-muted/30 gives over the page, made opaque: the same at rest, and
          body text scrolling underneath stays hidden instead of showing
          through, which a backdrop blur alone did not guarantee (browsers
          that skip backdrop-filter drew the text sharp under the buttons). */}
      <div
        data-testid="rich-text-toolbar"
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
            active={fontSizeMenuOpen || !!currentFontSize}
            onClick={() => setFontSizeMenuOpen((v) => !v)}
            title={tToolbar("font_size")}
          >
            {currentFontSize ? (
              <span className="text-xs font-semibold min-w-6 text-center leading-4 tabular-nums">
                {currentFontSize.replace("px", "")}
              </span>
            ) : (
              <span className="flex items-baseline justify-center leading-none" aria-hidden>
                <span className="text-sm font-semibold">A</span>
                <span className="text-[9px] font-semibold">A</span>
              </span>
            )}
          </ToolbarButton>
          {fontSizeMenuOpen && (
            <div className="absolute z-50 top-full start-0 mt-1 bg-popover border border-border rounded-md shadow-md p-1 min-w-[64px]">
              {FONT_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => {
                    editor.chain().focus().setFontSize(size).run();
                    setFontSizeMenuOpen(false);
                  }}
                  className={cn(
                    "block w-full text-start px-2 py-1 rounded hover:bg-accent transition-colors",
                    currentFontSize === size && "bg-accent text-accent-foreground"
                  )}
                  style={{ fontSize: size, lineHeight: 1.4 }}
                >
                  {size}
                </button>
              ))}
              <div className="h-px bg-border my-1" />
              <button
                type="button"
                className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-accent text-start w-full"
                onClick={() => {
                  editor.chain().focus().unsetFontSize().run();
                  setFontSizeMenuOpen(false);
                }}
              >
                <RemoveFormatting className="w-4 h-4" /> {tToolbar("font_size_default")}
              </button>
            </div>
          )}
        </div>

        <ToolbarSeparator />

        <ToolbarButton
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title={tToolbar("bold")}
        >
          <Bold className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title={tToolbar("italic")}
        >
          <Italic className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          title={tToolbar("underline")}
        >
          <UnderlineIcon className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title={tToolbar("strikethrough")}
        >
          <Strikethrough className="w-4 h-4" />
        </ToolbarButton>
        <div ref={colorWrapperRef} className="relative">
          <ToolbarButton
            active={!!editor.getAttributes("textStyle").color}
            onClick={() => setColorMenuOpen((v) => !v)}
            title={tToolbar("text_color")}
          >
            {/* The icon itself previews the active colour - no layout shift. */}
            <Baseline className="w-4 h-4" style={{ color: editor.getAttributes("textStyle").color || undefined }} />
          </ToolbarButton>
          {colorMenuOpen && (
            <div className="absolute z-50 top-full start-0 mt-1 bg-popover border border-border rounded-md shadow-md p-2">
              <div className="grid gap-0.5" style={{ gridTemplateColumns: "repeat(8, 1fr)" }}>
                {TEXT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    onClick={() => {
                      editor.chain().focus().setColor(color).run();
                      setColorMenuOpen(false);
                    }}
                    className={cn(
                      "w-4 h-4 border border-border/60 rounded-[2px] transition-transform hover:scale-110",
                      editor.getAttributes("textStyle").color === color && "ring-1 ring-ring ring-offset-1"
                    )}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="h-px bg-border my-1.5" />
              <button
                type="button"
                className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-accent text-start w-full"
                onClick={() => {
                  editor.chain().focus().unsetColor().run();
                  setColorMenuOpen(false);
                }}
              >
                <RemoveFormatting className="w-4 h-4" /> {tToolbar("remove_color")}
              </button>
            </div>
          )}
        </div>
        {/* Background color - same palette, same grid and same swatch
            styling as the text-colour picker above, so the two controls
            read as siblings. The highlighter glyph previews the active
            tint on its little bar. Inline style="background-color: …"
            survives email round-trips like `color` does. */}
        <div ref={bgColorWrapperRef} className="relative">
          <ToolbarButton
            active={!!currentBgColor}
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
            <div className="absolute z-50 top-full start-0 mt-1 bg-popover border border-border rounded-md shadow-md p-2">
              <div className="grid gap-0.5" style={{ gridTemplateColumns: "repeat(8, 1fr)" }}>
                {TEXT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    onClick={() => {
                      editor.chain().focus().setBackgroundColor(color).run();
                      setBgColorMenuOpen(false);
                    }}
                    className={cn(
                      "w-4 h-4 border border-border/60 rounded-[2px] transition-transform hover:scale-110",
                      currentBgColor === color && "ring-1 ring-ring ring-offset-1"
                    )}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="h-px bg-border my-1.5" />
              <button
                type="button"
                className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-accent text-start w-full"
                onClick={() => {
                  editor.chain().focus().unsetBackgroundColor().run();
                  setBgColorMenuOpen(false);
                }}
              >
                <RemoveFormatting className="w-4 h-4" /> {tToolbar("remove_background_color")}
              </button>
            </div>
          )}
        </div>

        <ToolbarSeparator />

        <ToolbarButton
          active={editor.isActive("heading", { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title={tToolbar("heading_1")}
        >
          <Heading1 className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title={tToolbar("heading_2")}
        >
          <Heading2 className="w-4 h-4" />
        </ToolbarButton>

        <ToolbarSeparator />

        <ToolbarButton
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title={tToolbar("bullet_list")}
        >
          <List className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title={tToolbar("ordered_list")}
        >
          <ListOrdered className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title={tToolbar("quote")}
        >
          <Quote className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive("codeBlock")}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title={tToolbar("code_block")}
        >
          <Code className="w-4 h-4" />
        </ToolbarButton>

        <ToolbarSeparator />

        <ToolbarButton
          active={editor.isActive({ textAlign: "left" })}
          onClick={() => editor.chain().focus().setTextAlign("left").run()}
          title={tToolbar("align_left")}
        >
          <AlignLeft className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive({ textAlign: "center" })}
          onClick={() => editor.chain().focus().setTextAlign("center").run()}
          title={tToolbar("align_center")}
        >
          <AlignCenter className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive({ textAlign: "right" })}
          onClick={() => editor.chain().focus().setTextAlign("right").run()}
          title={tToolbar("align_right")}
        >
          <AlignRight className="w-4 h-4" />
        </ToolbarButton>

        {rtlEditingSupport && (
          <ToolbarButton
            active={
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
          active={editor.isActive("link")}
          onClick={addLink}
          title={tToolbar("link")}
        >
          <LinkIcon className="w-4 h-4" />
        </ToolbarButton>

        <div ref={tableWrapperRef} className="relative">
          <ToolbarButton
            active={editor.isActive("table")}
            onClick={() => setTableMenuOpen((v) => !v)}
            title={tToolbar("table")}
          >
            <TableIcon className="w-4 h-4" />
          </ToolbarButton>
          {tableMenuOpen && (
            <div className="absolute z-50 top-full start-0 mt-1 bg-popover border border-border rounded-md shadow-md p-2 min-w-[200px]">
              {editor.isActive("table") ? (
                <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-start"
                    onClick={() => { editor.chain().focus().addRowBefore().run(); setTableMenuOpen(false); }}
                  >
                    <Rows3 className="w-4 h-4" /> {tToolbar("add_row_above")}
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-start"
                    onClick={() => { editor.chain().focus().addRowAfter().run(); setTableMenuOpen(false); }}
                  >
                    <Rows3 className="w-4 h-4" /> {tToolbar("add_row_below")}
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-start"
                    onClick={() => { editor.chain().focus().addColumnBefore().run(); setTableMenuOpen(false); }}
                  >
                    <Columns3 className="w-4 h-4" /> {tToolbar("add_column_before")}
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-start"
                    onClick={() => { editor.chain().focus().addColumnAfter().run(); setTableMenuOpen(false); }}
                  >
                    <Columns3 className="w-4 h-4" /> {tToolbar("add_column_after")}
                  </button>
                  <div className="h-px bg-border my-1" />
                  <button
                    type="button"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-start"
                    onClick={() => { editor.chain().focus().deleteRow().run(); setTableMenuOpen(false); }}
                  >
                    <Trash2 className="w-4 h-4" /> {tToolbar("delete_row")}
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-start"
                    onClick={() => { editor.chain().focus().deleteColumn().run(); setTableMenuOpen(false); }}
                  >
                    <Trash2 className="w-4 h-4" /> {tToolbar("delete_column")}
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-start"
                    onClick={() => { editor.chain().focus().toggleHeaderRow().run(); setTableMenuOpen(false); }}
                  >
                    <Rows3 className="w-4 h-4" /> {tToolbar("toggle_header_row")}
                  </button>
                  <div className="h-px bg-border my-1" />
                  <button
                    type="button"
                    className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-accent text-start text-destructive"
                    onClick={() => { editor.chain().focus().deleteTable().run(); setTableMenuOpen(false); }}
                  >
                    <Trash2 className="w-4 h-4" /> {tToolbar("delete_table")}
                  </button>
                </div>
              ) : (
                <TableSizePicker
                  onPick={(rows, cols) => {
                    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
                    setTableMenuOpen(false);
                  }}
                />
              )}
            </div>
          )}
        </div>

        <ToolbarSeparator />

        <ToolbarButton
          onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
          title={tToolbar("clear_formatting")}
        >
          <RemoveFormatting className="w-4 h-4" />
        </ToolbarButton>

        <ToolbarSeparator />

        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          title={tToolbar("undo")}
        >
          <Undo className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
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
    </div>
  );
}
