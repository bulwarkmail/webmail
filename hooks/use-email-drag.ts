"use client";

import { useCallback, useEffect, useMemo, useRef, DragEvent } from "react";
import { Email } from "@/lib/jmap/types";
import { IJMAPClient } from "@/lib/jmap/client-interface";
import { emailLinkSource, resolveEmailBlobContext, resolveSelectedEmails, useEmailStore } from "@/stores/email-store";
import { emailKeyFor } from "@/lib/thread-utils";
import { useAuthStore } from "@/stores/auth-store";
import { useDragDropContext } from "@/contexts/drag-drop-context";
import { useUIStore } from "@/stores/ui-store";
import { isDragOutSupported } from "@/hooks/use-attachment-drag";
import { appUrl, buildMailPath } from "@/lib/deep-links";
import {
  bundleExportFilename,
  DEFAULT_BUNDLE_TEMPLATE,
  DEFAULT_EMAIL_TEMPLATE,
  emailExportFilename,
  uniqueFilename,
  type EmailFilenameOptions,
} from "@/lib/download-filename";
import { useSettingsStore } from "@/stores/settings-store";
import { useTranslations } from "next-intl";
import { toast } from "@/stores/toast-store";

interface UseEmailDragOptions {
  email: Email;
  sourceMailboxId: string;
  threadEmails?: Email[];
}

interface UseEmailDragReturn {
  dragHandlers: {
    draggable: boolean;
    onPointerEnter?: () => void;
    onDragStart: (e: DragEvent<HTMLDivElement>) => void;
    onDragEnd: (e: DragEvent<HTMLDivElement>) => void;
  };
  isDragging: boolean;
}

function createDragPreview(count: number): HTMLElement {
  const preview = document.createElement("div");
  preview.className = "drag-preview";
  preview.style.cssText = `
    position: fixed;
    top: -9999px;
    left: 0;
    padding: 8px 16px;
    background-color: var(--color-primary, #3b82f6);
    color: var(--color-primary-foreground, #ffffff);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    font-size: 14px;
    font-weight: 500;
    z-index: 9999;
    white-space: nowrap;
    pointer-events: none;
  `;
  preview.textContent = count === 1 ? "1 email" : `${count} emails`;
  document.body.appendChild(preview);
  return preview;
}

function bundleFilename(count: number, options: EmailFilenameOptions): string {
  return bundleExportFilename(count, options);
}

// Rows in the same selection share a bundle. Scope cached bytes to the actual
// authenticated client, owner and message, since raw email/blob IDs can collide.
type BundleEntry = {
  key: string;
  name: string;
  url: string | null;
  promise: Promise<string | null> | null;
};

type EmailBundleEntry = BundleEntry & { onError?: () => void };

let currentBundle: EmailBundleEntry | null = null;

// Object identity also distinguishes a reconnected/replaced client for the same login.
const clientKeys = new WeakMap<IJMAPClient, number>();
let nextClientKey = 0;

function routeEmail(email: Email, options: EmailFilenameOptions) {
  const { client, accountId: owner, clientAccountId } = resolveEmailBlobContext(email, useAuthStore.getState().client);
  const accountId = owner ?? client?.getAccountId();
  if (client && !clientKeys.has(client)) clientKeys.set(client, ++nextClientKey);
  const name = emailExportFilename(email, options);
  const key = JSON.stringify([
    client ? clientKeys.get(client) : null, clientAccountId,
    accountId, emailKeyFor(email), email.blobId, name,
  ]);
  return { email, client, accountId, name, key };
}

type RoutedEmail = ReturnType<typeof routeEmail>;

function selectionKey(emails: RoutedEmail[], bundleOptions: EmailFilenameOptions): string {
  return JSON.stringify([emails.map((entry) => entry.key).sort(), bundleOptions]);
}

function revokeLater(url: string): void {
  // Chromium may read the URL asynchronously after the drop completes.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function buildEmailZip(emails: RoutedEmail[]): Promise<string> {
  if (emails.length === 0 || emails.some(({ email, client }) => !email.blobId || !client)) {
    throw new Error("Every selected message must have a blob and source client to export a ZIP");
  }
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Set<string>();
  await Promise.all(
    emails.map(async ({ email: em, client, accountId, name: filename }) => {
      const base = filename.replace(/\.eml$/, "");
      // Full id, not a prefix: messages in one thread share their leading
      // characters (Stalwart packs the thread id into the high bits), and a
      // prefix collision here used to spin the main thread forever (#1039).
      const name = uniqueFilename(used, base, ".eml", em.id);
      used.add(name);
      const blob = await client!.fetchBlob(em.blobId!, name, "message/rfc822", accountId);
      zip.file(name, blob);
    }),
  );
  const zipBlob = await zip.generateAsync({ type: "blob", mimeType: "application/zip" });
  return URL.createObjectURL(zipBlob);
}

function prefetchEmailBundle(
  emails: RoutedEmail[],
  bundleOptions: EmailFilenameOptions,
  onError?: () => void,
): void {
  const key = selectionKey(emails, bundleOptions);
  if (currentBundle?.key === key && (currentBundle.url || currentBundle.promise)) {
    // Hover is silent. The first drag joining this build owns its one error
    // notification, even when several selected rows join the same promise.
    currentBundle.onError ??= onError;
    return;
  }
  if (currentBundle?.url) {
    const old = currentBundle.url;
    revokeLater(old);
  }
  const entry: EmailBundleEntry = {
    key,
    name: bundleFilename(emails.length, bundleOptions),
    url: null,
    promise: null,
    onError,
  };
  entry.promise = buildEmailZip(emails)
    .then((url) => {
      if (currentBundle === entry) entry.url = url;
      else revokeLater(url);
      return url;
    })
    .catch(() => {
      // An obsolete failure must not retire a newer build or notify over it.
      // Clearing this entry lets the next pointer/drag event really retry.
      if (currentBundle === entry) {
        currentBundle = null;
        entry.onError?.();
      }
      return null;
    })
    .finally(() => { entry.promise = null; });
  currentBundle = entry;
}

function getReadyBundle(emails: RoutedEmail[], bundleOptions: EmailFilenameOptions): { url: string; name: string } | null {
  const key = selectionKey(emails, bundleOptions);
  if (currentBundle && currentBundle.key === key && currentBundle.url) {
    return { url: currentBundle.url, name: currentBundle.name };
  }
  return null;
}

export function useEmailDrag({ email, sourceMailboxId, threadEmails }: UseEmailDragOptions): UseEmailDragReturn {
  const tNotifications = useTranslations("notifications");
  // The selection and the list are read when a drag starts, not subscribed
  // to: every message row runs this hook, and a subscription to the list
  // re-rendered every row on each list update (new results, a snippet, a
  // read flag elsewhere), however memoised the rows were.
  const { startDrag, endDrag, isDragging, draggedEmails } = useDragDropContext();
  const isMobile = useUIStore((state) => state.isMobile);
  const client = useAuthStore((state) => state.client);
  const template = useSettingsStore((s) => s.emailDownloadTemplate) || DEFAULT_EMAIL_TEMPLATE;
  const bundleTemplate = useSettingsStore((s) => s.bundleDownloadTemplate) || DEFAULT_BUNDLE_TEMPLATE;
  const spaceReplacement = useSettingsStore((s) => s.filenameSpaceReplacement);
  const lowercase = useSettingsStore((s) => s.filenameLowercase);
  const stripDiacritics = useSettingsStore((s) => s.filenameStripDiacritics);
  const collapseSeparators = useSettingsStore((s) => s.filenameCollapseSeparators);
  const filenameOptions: EmailFilenameOptions = useMemo(
    () => ({ template, spaceReplacement, lowercase, stripDiacritics, collapseSeparators }),
    [template, spaceReplacement, lowercase, stripDiacritics, collapseSeparators],
  );
  const bundleOptions: EmailFilenameOptions = useMemo(
    () => ({ template: bundleTemplate, spaceReplacement, lowercase, stripDiacritics, collapseSeparators }),
    [bundleTemplate, spaceReplacement, lowercase, stripDiacritics, collapseSeparators],
  );

  const dragOutEnabled = !isMobile && isDragOutSupported() && !!client;
  const singleRef = useRef<BundleEntry | null>(null);

  useEffect(() => {
    return () => {
      if (singleRef.current?.url) revokeLater(singleRef.current.url);
      // A late completion must not repopulate a retired row's cache.
      singleRef.current = null;
    };
  }, [email.id, email.blobId, email.sourceClientAccountId, email.sourceAccountId, client, filenameOptions]);

  const prefetchSingle = useCallback((target: Email) => {
    if (!dragOutEnabled || !target.blobId) return;
    const route = routeEmail(target, filenameOptions);
    if (!route.client) return;
    const previous = singleRef.current;
    if (previous?.key === route.key && (previous.url || previous.promise)) return;
    if (previous?.url) revokeLater(previous.url);
    const entry: BundleEntry = { key: route.key, name: route.name, url: null, promise: null };
    singleRef.current = entry;
    entry.promise = route.client
      .fetchBlobAsObjectUrl(target.blobId, route.name, "message/rfc822", route.accountId)
      .then((url) => {
        if (url) {
          if (singleRef.current === entry && routeEmail(target, filenameOptions).key === entry.key) entry.url = url;
          else revokeLater(url);
        }
        return url;
      })
      .catch(() => null)
      .finally(() => { entry.promise = null; });
  }, [dragOutEnabled, filenameOptions]);

  const handlePointerEnter = useCallback(() => {
    const state = useEmailStore.getState();
    if (!dragOutEnabled) return;
    const selected = state.selectedEmailKeys.has(emailKeyFor(email))
      ? resolveSelectedEmails(state)
      : threadEmails || [email];
    if (selected.length > 1) {
      if (selected.some((em) => em.blobId)) {
        prefetchEmailBundle(selected.map((em) => routeEmail(em, filenameOptions)), bundleOptions);
      }
    } else if (selected[0]) {
      prefetchSingle(selected[0]);
    }
  }, [dragOutEnabled, email, threadEmails, prefetchSingle, filenameOptions, bundleOptions]);

  const handleDragStart = useCallback((e: DragEvent<HTMLDivElement>) => {
    const state = useEmailStore.getState();
    const { selectedEmailKeys } = state;
    // Determine which emails to drag:
    // - If current email is selected, drag all selected
    // - If threadEmails provided (thread header), drag all thread emails
    // - Otherwise, drag only this email
    const isSelected = selectedEmailKeys.has(emailKeyFor(email));
    const emailsToDrag = isSelected
      ? resolveSelectedEmails(state)
      : threadEmails || [email];

    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(
      "application/x-email-ids",
      JSON.stringify(emailsToDrag.map(em => em.id))
    );
    e.dataTransfer.setData(
      "text/plain",
      emailsToDrag.map(em => em.subject || "(no subject)").join(", ")
    );
    // Dropped on the browser's tab strip or address bar, text/uri-list wins
    // over text/plain - the message permalink opens instead of a search for
    // the subject text. One URL per message (RFC 2483 CRLF-separated);
    // browsers open the first on a tab-strip drop. In-app drop targets key on
    // application/x-email-ids and ignore this entry. `view=fullscreen` opens
    // the message alone, without the folder sidebar and list.
    e.dataTransfer.setData(
      "text/uri-list",
      emailsToDrag
        .map(em => appUrl(buildMailPath({ mailboxId: null, emailId: em.id, threadId: null, ...emailLinkSource(em), fullscreen: true })))
        .join("\r\n")
    );

    // Drag-out to file explorer.
    if (dragOutEnabled && client) {
      if (emailsToDrag.length === 1 && emailsToDrag[0].blobId) {
        const route = routeEmail(emailsToDrag[0], filenameOptions);
        const url = singleRef.current?.key === route.key ? singleRef.current.url : null;
        if (url) {
          const name = emailExportFilename(emailsToDrag[0], filenameOptions);
          // `DownloadURL` format: <mime>:<filename>:<url>. Chromium expects
          // the filename raw - URL-encoding it ends up literally on disk
          // (e.g. `%20` instead of a space). The sanitiser already removed
          // `:` and other reserved chars, so embedding the name as-is is
          // safe. Firefox/Safari ignore this entry entirely.
          e.dataTransfer.setData(
            "DownloadURL",
            `message/rfc822:${name}:${url}`,
          );
        } else {
          // Not warmed up yet â€” kick off so the next attempt works. Don't
          // preventDefault: in-app drop still has to function.
          prefetchSingle(emailsToDrag[0]);
        }
      } else if (emailsToDrag.length > 1) {
        const routed = emailsToDrag.map((em) => routeEmail(em, filenameOptions));
        const ready = getReadyBundle(routed, bundleOptions);
        if (ready) {
          e.dataTransfer.setData(
            "DownloadURL",
            `application/zip:${ready.name}:${ready.url}`,
          );
        } else {
          // Kick off the bundle build for the next attempt.
          prefetchEmailBundle(routed, bundleOptions, () => toast.error(tNotifications("export_email_error")));
        }
      }
    }

    // Create custom drag image
    const dragPreview = createDragPreview(emailsToDrag.length);
    e.dataTransfer.setDragImage(dragPreview, 0, 0);

    // Clean up preview after drag starts (browser keeps a snapshot)
    requestAnimationFrame(() => {
      dragPreview.remove();
    });

    startDrag(emailsToDrag, sourceMailboxId);
  }, [email, sourceMailboxId, startDrag, threadEmails, dragOutEnabled, client, prefetchSingle, filenameOptions, bundleOptions, tNotifications]);

  const handleDragEnd = useCallback(() => {
    endDrag();
    // Defer-revoke the per-row single .eml URL. The shared bundle URL stays
    // cached until the selection changes - revoking it here would break a
    // subsequent drag of the same selection.
    if (singleRef.current?.url) {
      revokeLater(singleRef.current.url);
      singleRef.current = null;
    }
    // A cold drag has no DownloadURL. Keep its pending fetch so a retry can
    // use the completed bytes, provided the originating context is still valid.
  }, [endDrag]);

  // Check if this specific email is being dragged
  const isThisEmailDragging = isDragging && draggedEmails.some(em => em.id === email.id);

  return {
    dragHandlers: isMobile
      ? { draggable: false, onDragStart: () => {}, onDragEnd: () => {} }
      : {
          draggable: true,
          onPointerEnter: dragOutEnabled ? handlePointerEnter : undefined,
          onDragStart: handleDragStart,
          onDragEnd: handleDragEnd,
        },
    isDragging: isThisEmailDragging,
  };
}
