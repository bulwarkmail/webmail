"use client";

// Plugin surfaces of the open message that need more than a one-line mount:
// the attachment menu, plugin entries in the phone "More" panel, and the
// frame between a reply's own text and the quote under it.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuietState } from "@/hooks/use-quiet-state";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { iconForName, MoreVertical, Puzzle } from "@/components/icons";
import { ContextMenu } from "@/components/ui/context-menu";
import { PluginActions, usePluginActions, type MessageActionTarget } from "@/components/plugins/plugin-actions";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { usePluginSlotOffers } from "@/hooks/use-plugin-slot-offers";
import { useContextMenu } from "@/hooks/use-context-menu";
import { runAction } from "@/lib/plugin-sandbox/actions";
import { QUOTE_TOGGLE_ATTR } from "@/lib/quote-collapse";
import { cn } from "@/lib/utils";
import type { AttachmentInfo } from "@/lib/plugin-types";

// ─── attachment-menu ─────────────────────────────────────────

export interface AttachmentMenuTarget {
  /** Parts without a blob (decrypted, unpacked from TNEF) get no menu: a plugin couldn't fetch them. */
  blobId?: string;
  name?: string | null;
  type: string;
  size: number;
}

/**
 * A "more" button on an attachment that opens the entries plugins declared
 * for `attachment-menu`, filtered by the attachment's MIME type. Nothing is
 * drawn when no plugin has an entry for this type, or the part has no blob.
 */
export function AttachmentPluginMenu({
  emailId,
  attachment,
  className,
  iconClassName = "w-4 h-4",
}: {
  emailId: string | undefined;
  attachment: AttachmentMenuTarget;
  className?: string;
  iconClassName?: string;
}) {
  const t = useTranslations("email_viewer");
  const actions = usePluginActions("attachment-menu", { mimeType: attachment.type });
  const { contextMenu, openContextMenu, closeContextMenu, menuRef } = useContextMenu<true>();
  const context = useMemo(() => ({
    emailId,
    blobId: attachment.blobId,
    name: attachment.name || "",
    type: attachment.type,
    size: attachment.size,
  }), [emailId, attachment.blobId, attachment.name, attachment.type, attachment.size]);

  if (actions.length === 0 || !emailId || !attachment.blobId) return null;
  return (
    <>
      <button
        type="button"
        className={cn("p-1 hover:bg-accent rounded transition-colors", className)}
        title={t("more_actions")}
        aria-label={t("more_actions")}
        aria-haspopup="menu"
        aria-expanded={contextMenu.isOpen}
        data-attachment-plugin-menu=""
        onClick={(e) => openContextMenu(e, true)}
      >
        <MoreVertical className={cn(iconClassName, "text-foreground")} />
      </button>
      <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
        <PluginActions
          surface="attachment-menu"
          variant="menu"
          context={context}
          mimeType={attachment.type}
          onRan={closeContextMenu}
        />
      </ContextMenu>
    </>
  );
}

// ─── attachment-actions ──────────────────────────────────────

/**
 * The `attachment-actions` frames of one attachment, drawn next to its chip.
 * They used to sit in the chip's hover overlay, where a wide frame was cut
 * off and covered the name, and on phones (no hover) lay invisible over the
 * chip and swallowed taps meant for its menu button.
 */
export function AttachmentPluginFrames({
  emailId,
  attachment,
  className,
}: {
  emailId: string | undefined;
  attachment: AttachmentMenuTarget;
  className?: string;
}) {
  const extraProps = useMemo(() => ({
    attachment: {
      name: attachment.name || "",
      type: attachment.type,
      size: attachment.size,
      blobId: attachment.blobId,
      emailId,
    } satisfies AttachmentInfo,
  }), [emailId, attachment.name, attachment.type, attachment.size, attachment.blobId]);
  return (
    <PluginSlot
      name="attachment-actions"
      className={cn("max-w-full flex-shrink-0", className)}
      extraProps={extraProps}
    />
  );
}

// ─── Entries in a phone slide-in panel ───────────────────────

/**
 * Plugin actions as rows of a full-height phone menu panel (the reader's
 * "More" panel), drawn like the panel's own rows. A separator leads them.
 */
export function PluginPanelEntries({
  surface,
  context,
  mailboxRole,
  target,
  onRan,
}: {
  surface: string;
  context: Record<string, unknown>;
  mailboxRole?: string | null;
  /** The open message (useMessageActionTarget). */
  target?: MessageActionTarget;
  onRan?: () => void;
}) {
  const actions = usePluginActions(surface, { mailboxRole, accountKind: target?.accountKind ?? null, keywords: target?.keywords ?? null });
  const clickContext = target?.accountId ? { ...context, accountId: target.accountId } : context;
  if (actions.length === 0) return null;
  return (
    <>
      <div className="h-px bg-border my-1" />
      {actions.map((action) => {
        const Icon = iconForName(action.icon) ?? Puzzle;
        return (
          <button
            key={`${action.pluginId}:${action.id}`}
            role="menuitem"
            title={action.pluginName}
            onClick={() => { onRan?.(); void runAction(action, surface, clickContext); }}
            className={cn(
              "w-full px-4 py-3 min-h-[44px] text-sm text-start hover:bg-muted flex items-center gap-3",
              action.danger ? "text-destructive" : "text-foreground",
            )}
          >
            <Icon className="w-5 h-5" />
            {action.label}
          </button>
        );
      })}
    </>
  );
}

// ─── reader-above-quote ──────────────────────────────────────

export const QUOTE_ANCHOR_ATTR = "data-plugin-quote-anchor";

/**
 * Puts an empty block right before the collapsed quote of a rendered body
 * and returns it: before the "•••" toggle setupQuoteCollapse added (HTML
 * body in its iframe), or before the <details> collapsePlainTextQuotes
 * wrapped the quote in (plain-text body). Null when the body has no quote
 * the viewer recognised.
 */
export function insertQuoteAnchor(root: HTMLElement): HTMLElement | null {
  const existing = root.querySelector<HTMLElement>(`[${QUOTE_ANCHOR_ATTR}]`);
  if (existing) return existing;
  const toggle = root.querySelector(`[${QUOTE_TOGGLE_ATTR}]`)
    ?? root.querySelector(":scope > details");
  if (!toggle?.parentNode) return null;
  const anchor = root.ownerDocument.createElement("div");
  anchor.setAttribute(QUOTE_ANCHOR_ATTR, "");
  // No fixed height: in a plain-text body the frame renders inside the anchor
  // and must push the quote toggle down, not lie over it. QuoteOverlay sets
  // the height itself for an HTML body.
  anchor.style.cssText = "display:block;margin:0;padding:0;border:0;white-space:normal;";
  toggle.parentNode.insertBefore(anchor, toggle);
  return anchor;
}

/**
 * The `reader-above-quote` frame. In a plain-text body (same document) it
 * renders into the anchor. In an HTML body the anchor lives in the mail's
 * sandboxed iframe, which can't host a plugin frame, so the frame is laid
 * over the iframe at the anchor's place and the anchor is grown to the
 * frame's height to make room for it.
 *
 * `root` is the body element the quote was collapsed in (null while the body
 * isn't ready); `version` changes whenever that body is rendered anew.
 */
export function ReaderAboveQuoteSlot({
  root,
  frame,
  extraProps,
  version,
}: {
  root: HTMLElement | null;
  /** The iframe holding `root`, for an HTML body. */
  frame?: HTMLIFrameElement | null;
  extraProps: Record<string, unknown>;
  version?: unknown;
}) {
  const offered = usePluginSlotOffers("reader-above-quote").length > 0;
  // Without a plugin for the slot the anchor stays null on every open: no draw for it.
  const [anchor, setAnchor] = useQuietState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!offered || !root) {
      setAnchor(null);
      return;
    }
    const next = insertQuoteAnchor(root);
    setAnchor(next);
    return () => {
      next?.remove();
    };
  }, [offered, root, version, setAnchor]);

  if (!anchor) return null;
  const slot = <PluginSlot name="reader-above-quote" className="w-full" extraProps={extraProps} />;
  if (!frame || anchor.ownerDocument === document) {
    return createPortal(slot, anchor);
  }
  return <QuoteOverlay anchor={anchor} frame={frame}>{slot}</QuoteOverlay>;
}

function QuoteOverlay({ anchor, frame, children }: { anchor: HTMLElement; frame: HTMLIFrameElement; children: React.ReactNode }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    const host = overlay?.offsetParent as HTMLElement | null;
    if (!overlay) return;
    const place = () => {
      // The anchor's box is in the iframe's viewport; the iframe doesn't
      // scroll (it is as tall as the mail), so frame top + anchor top is
      // where the anchor sits on the page.
      const frameRect = frame.getBoundingClientRect();
      const hostRect = host?.getBoundingClientRect() ?? { top: 0, left: 0 };
      const anchorRect = anchor.getBoundingClientRect();
      const next = {
        top: frameRect.top - hostRect.top + frame.clientTop + anchorRect.top,
        left: frameRect.left - hostRect.left + frame.clientLeft,
        width: frame.clientWidth,
      };
      setBox((prev) => (prev && prev.top === next.top && prev.left === next.left && prev.width === next.width ? prev : next));
    };
    const fit = () => {
      // Make room in the mail for the frame. A mail scaled down to fit a
      // phone is drawn smaller than its layout, so undo that scale.
      const scale = anchor.offsetWidth > 0 ? anchor.getBoundingClientRect().width / anchor.offsetWidth : 1;
      const height = overlay.offsetHeight / (scale || 1);
      anchor.style.height = `${Math.ceil(height)}px`;
      place();
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(overlay);
    observer.observe(frame);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      anchor.style.height = "0px";
    };
  }, [anchor, frame]);

  return (
    <div
      ref={overlayRef}
      data-plugin-quote-overlay=""
      className="absolute z-[1]"
      style={box ? { top: box.top, left: box.left, width: box.width } : { top: 0, left: 0, right: 0, visibility: "hidden" }}
    >
      {children}
    </div>
  );
}
