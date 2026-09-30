"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "@/components/icons";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { Mailbox, MailboxRights } from "@/lib/jmap/types";
import { ShareCollectionDialog } from "@/components/settings/share-collection-dialog";
import { toast } from "@/stores/toast-store";
import { useTranslations } from "next-intl";

interface MailboxShareDialogProps {
  client: IJMAPClient;
  mailbox: Mailbox;
  onClose: () => void;
}

/**
 * Share a mail folder with other principals (urn:ietf:params:jmap:mail:share).
 * The folder's current `shareWith` is loaded on open - it is not part of the
 * regular folder list - and re-read after every change so the dialog always
 * reflects what the server holds.
 */
export function MailboxShareDialog({ client, mailbox, onClose }: MailboxShareDialogProps) {
  const t = useTranslations("sharing");
  const [shareWith, setShareWith] = useState<Record<string, MailboxRights> | null | undefined>(undefined);

  // A folder of a delegated account lives under its owner's accountId with
  // the owner's (un-namespaced) mailbox id.
  const accountId = mailbox.isShared ? mailbox.accountId : undefined;
  const jmapMailboxId = mailbox.originalId || mailbox.id;

  const load = useCallback(async () => {
    if (!client.getMailboxShareWith) {
      setShareWith(null);
      return;
    }
    try {
      setShareWith(await client.getMailboxShareWith(jmapMailboxId, accountId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("share_failed"));
      onClose();
    }
  }, [client, jmapMailboxId, accountId, onClose, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (shareWith === undefined) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
        <div className="relative rounded-lg border border-border bg-background px-6 py-4 shadow-xl">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("loading_principals")} />
        </div>
      </div>
    );
  }

  return (
    <ShareCollectionDialog
      client={client}
      kind="mailbox"
      collectionName={mailbox.name}
      shareWith={shareWith}
      ownAccountId={mailbox.accountId || client.getAccountId()}
      onShare={async (principalId, rights) => {
        if (!client.setMailboxShare) return;
        await client.setMailboxShare(jmapMailboxId, principalId, rights as MailboxRights | null, accountId);
        await load();
      }}
      onClose={onClose}
    />
  );
}
