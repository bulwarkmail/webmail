"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, X } from "@/components/icons";
import { getActiveAccountSlotHeaders } from "@/lib/auth/active-account-slot";

/** What the overlay opens: a Files node, or a mail attachment (read-only, #1047). */
export type WopiDocument =
  | { kind: "file"; id: string; name: string }
  | { kind: "attachment"; blobId: string; name: string; type?: string; size?: number };

interface WopiEditorProps {
  target: WopiDocument;
  /** JMAP account holding the node/blob (multi-account and shared contexts). */
  accountId?: string | null;
  /**
   * Cookie slot of the login that owns the document. Defaults to the active
   * account; the unified inbox passes the slot of the message's own login.
   */
  slot?: number | null;
  onClose: () => void;
}

interface LaunchData {
  url: string;
  accessToken: string;
  accessTokenTtl: number;
  readOnly: boolean;
}

/**
 * Full-screen WOPI editor overlay (#425). The editor (Collabora Online,
 * OnlyOffice/EuroOffice, ...) is launched the way the WOPI spec prescribes:
 * a form POST of the access token to the editor URL, targeted at an iframe.
 * Mail attachments open in the same overlay as a read-only viewer (#1047).
 */
export function WopiEditor({ target, accountId, slot, onClose }: WopiEditorProps) {
  const t = useTranslations("files");
  const [launch, setLaunch] = useState<LaunchData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const submittedRef = useRef(false);
  // Launch once per document; the object itself is rebuilt on every render.
  const launchBody = JSON.stringify(
    target.kind === "attachment"
      ? { blobId: target.blobId, name: target.name, type: target.type, size: target.size, accountId: accountId || undefined }
      : { fileId: target.id, accountId: accountId || undefined },
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const slotHeaders: Record<string, string> =
          typeof slot === "number" ? { "X-JMAP-Cookie-Slot": String(slot) } : getActiveAccountSlotHeaders();
        const res = await fetch("/api/wopi/launch", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...slotHeaders },
          body: launchBody,
        });
        if (!res.ok) throw new Error(`launch failed (${res.status})`);
        const data = (await res.json()) as LaunchData;
        if (!cancelled) setLaunch(data);
      } catch {
        if (!cancelled) setError(t("office_error"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [launchBody, slot, t]);

  // Submit the launch form exactly once, after it is in the DOM.
  useEffect(() => {
    if (launch && formRef.current && !submittedRef.current) {
      submittedRef.current = true;
      formRef.current.submit();
    }
  }, [launch]);

  // Close on Escape and when the editor posts a close message
  // (Collabora sends {"MessageId":"close"} / UI_Close via postMessage).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onMessage = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      try {
        const msg = JSON.parse(e.data) as { MessageId?: string };
        if (msg.MessageId === "close" || msg.MessageId === "UI_Close") onClose();
      } catch {
        // Not a WOPI post message - ignore.
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] bg-background flex flex-col">
      <div className="flex items-center justify-between gap-3 px-4 h-12 border-b border-border shrink-0">
        <span className="text-sm font-medium text-foreground truncate">{target.name}</span>
        <button
          onClick={onClose}
          aria-label={t("office_close")}
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {error}
          </div>
        ) : (
          <>
            {!frameLoaded && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t("office_loading")}
              </div>
            )}
            <iframe
              name="wopi-editor-frame"
              title={target.name}
              className="w-full h-full border-0"
              onLoad={() => setFrameLoaded(true)}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
              referrerPolicy="no-referrer"
              allow="clipboard-read; clipboard-write"
            />
            {launch && (
              <form
                ref={formRef}
                action={launch.url}
                method="POST"
                target="wopi-editor-frame"
                hidden
              >
                <input name="access_token" value={launch.accessToken} type="hidden" readOnly />
                <input name="access_token_ttl" value={String(launch.accessTokenTtl)} type="hidden" readOnly />
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
