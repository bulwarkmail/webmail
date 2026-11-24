"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { Paperclip, Download, X } from "@/components/icons";
import { IconButton } from "@/components/ui/icon-button";
import { toast } from "@/stores/toast-store";
import { useAuthStore } from "@/stores/auth-store";
import { getClientByLocalAccountId } from "@/stores/client-registry";
import { gateLinkClick } from "@/lib/plugin-hook-result";
import { formatFileSize } from "@/lib/utils";
import type { EventAttachment } from "@/lib/calendar-attachments";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { Calendar, CalendarEvent } from "@/lib/jmap/types";

/** A file picked in the editor, uploaded when the event is saved. */
export interface PendingAttachment {
  id: string;
  file: File;
}

type AccountRef = Pick<CalendarEvent, "accountId" | "isShared" | "localAccountId">;

/**
 * The client and JMAP account an event's (or a calendar's) files live in:
 * the owner's account for a shared one, the login's calendars account
 * otherwise, through the login the event belongs to.
 */
export function attachmentAccount(
  active: IJMAPClient | null,
  ref: AccountRef | Pick<Calendar, "accountId" | "isShared" | "localAccountId"> | null | undefined,
): { client: IJMAPClient; accountId: string } | null {
  const client = ref?.localAccountId ? getClientByLocalAccountId(ref.localAccountId) ?? null : active;
  if (!client) return null;
  const accountId = ref?.isShared && ref.accountId ? ref.accountId : client.getCalendarsAccountId();
  return { client, accountId };
}

/** Downloads a stored attachment of the event through the authenticated blob download. */
export function useEventAttachmentDownload(event: AccountRef | null | undefined) {
  const t = useTranslations("calendar.attachments");
  const active = useAuthStore((s) => s.client);
  return useCallback(async (attachment: EventAttachment) => {
    if (!attachment.blobId) return;
    const target = attachmentAccount(active, event);
    if (!target) return;
    try {
      await target.client.downloadBlob(
        attachment.blobId,
        attachment.name || t("unnamed"),
        attachment.contentType || undefined,
        target.accountId,
      );
    } catch {
      toast.error(t("download_failed"));
    }
  }, [active, event, t]);
}

interface EventAttachmentListProps {
  attachments: EventAttachment[];
  onDownload: (attachment: EventAttachment) => void;
  /** In the editor: removes an attachment the event has. */
  onRemove?: (key: string) => void;
  /** In the editor: files picked but not yet uploaded. */
  pending?: PendingAttachment[];
  onRemovePending?: (id: string) => void;
}

const ROW = "flex items-center gap-2 min-w-0 text-sm";

/**
 * The files attached to an event. One stored on the server downloads, one
 * that points to a web address opens in a new tab; any other address is
 * only named.
 */
export function EventAttachmentList({ attachments, onDownload, onRemove, pending = [], onRemovePending }: EventAttachmentListProps) {
  const t = useTranslations("calendar.attachments");
  if (attachments.length === 0 && pending.length === 0) return null;

  const meta = (size: number | null) => size != null ? (
    <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">{formatFileSize(size)}</span>
  ) : null;

  return (
    <ul className="space-y-1 min-w-0 flex-1" aria-label={t("title")}>
      {attachments.map((a) => {
        const name = a.name || t("unnamed");
        return (
          <li key={a.key} className={ROW}>
            {a.blobId ? (
              <button
                type="button"
                onClick={() => onDownload(a)}
                className="flex items-center gap-1.5 min-w-0 text-primary hover:underline text-start"
                title={t("download", { name })}
              >
                <Download className="w-3.5 h-3.5 flex-shrink-0" />
                <span dir="auto" className="truncate">{name}</span>
              </button>
            ) : a.url ? (
              <a
                href={a.url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={gateLinkClick}
                onAuxClick={gateLinkClick}
                className="min-w-0 text-primary hover:underline truncate"
                dir="auto"
                title={a.url}
              >
                {name}
              </a>
            ) : (
              <span dir="auto" className="min-w-0 truncate text-foreground">{name}</span>
            )}
            {meta(a.size)}
            {onRemove && (
              <IconButton size="icon-sm" label={t("remove", { name })} onClick={() => onRemove(a.key)} className="ms-auto">
                <X className="w-3.5 h-3.5" />
              </IconButton>
            )}
          </li>
        );
      })}
      {pending.map((p) => (
        <li key={p.id} className={ROW}>
          <span dir="auto" className="min-w-0 truncate text-foreground">{p.file.name}</span>
          {meta(p.file.size)}
          {onRemovePending && (
            <IconButton size="icon-sm" label={t("remove", { name: p.file.name })} onClick={() => onRemovePending(p.id)} className="ms-auto">
              <X className="w-3.5 h-3.5" />
            </IconButton>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The paperclip row of the event's detail views. */
export function EventAttachmentsRow({ attachments, onDownload }: { attachments: EventAttachment[]; onDownload: (a: EventAttachment) => void }) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex items-start gap-2.5">
      <Paperclip className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
      <EventAttachmentList attachments={attachments} onDownload={onDownload} />
    </div>
  );
}
