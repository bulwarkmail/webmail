"use client";

import { useEffect, useState } from "react";
import type { Email } from "@/lib/jmap/types";
import { renderHooks } from "@/lib/plugin-hooks";
import { toInertBlob } from "@/lib/file-preview";
import { debug } from "@/lib/debug";

export interface PluginRenderedBody {
  /** HTML a crypto plugin (PGP, S/MIME) rendered for the message, unsanitized. */
  html: string | null;
  /** Plain text the plugin rendered, when it gave no HTML. */
  text: string | null;
  /** blob: URLs for the decrypted inline parts, keyed by Content-ID without brackets. */
  cidUrls: Record<string, string>;
  /** The plugin can't vouch for this body: external content stays off, whatever the settings allow. */
  blockExternal: boolean;
}

const EMPTY: PluginRenderedBody = { html: null, text: null, cidUrls: {}, blockExternal: false };

/**
 * What onRenderEmailBody gets to see, for its effect's dependencies. A render can be a
 * key operation (a smart card's PIN dialog, and two cancels in a row lock the key), so
 * it runs once per message, not per object: mark-read replaces the object and changes
 * only keywords. The list row and then the full message do differ here: a row has no
 * headers or body structure, which is what a plugin recognises its mail by. A plugin
 * that wants to render again for another reason has api.ui.rerenderEmail.
 */
export function pluginRenderKey(email: Email | null | undefined): string | null {
  if (!email) return null;
  const contentType = email.headers?.['content-type'] ?? email.headers?.['Content-Type'] ?? '';
  const bodyLengths = Object.values(email.bodyValues ?? {}).map((part) => part.value?.length ?? 0);
  return JSON.stringify([
    email.sourceClientAccountId ?? '',
    email.id,
    email.blobId ?? '',
    contentType,
    email.bodyStructure ? 1 : 0,
    email.bodyValues ? bodyLengths : null,
    email.attachments?.length ?? null,
  ]);
}

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const meta = dataUrl.slice(0, comma);
    const data = dataUrl.slice(comma + 1);
    if (meta.includes(';base64')) {
      const bin = atob(data);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    return new TextEncoder().encode(decodeURIComponent(data));
  } catch {
    return null;
  }
}

/**
 * Asks the onRenderEmailBody hook for a replacement body, the way the single
 * reader does, so a message a PGP or S/MIME plugin decrypts also shows
 * decrypted inside a conversation (#902). Re-runs when a plugin calls
 * api.ui.rerenderEmail, e.g. after the user unlocked a key, and not when only the
 * object changes (see pluginRenderKey).
 */
export function usePluginRenderedBody(email: Email): PluginRenderedBody {
  const [body, setBody] = useState<PluginRenderedBody>(EMPTY);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const bump = () => setNonce((n) => n + 1);
    window.addEventListener('plugin:rerender-email', bump);
    return () => window.removeEventListener('plugin:rerender-email', bump);
  }, []);

  useEffect(() => {
    if (renderHooks.onRenderEmailBody.size === 0) {
      setBody(EMPTY);
      return;
    }
    let cancelled = false;
    const objectUrls: string[] = [];

    (async () => {
      try {
        const rawContentType = email.headers?.['content-type'] || email.headers?.['Content-Type'];
        const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
        const result = await renderHooks.onRenderEmailBody.transform(
          { html: '', text: '', attachments: [] as unknown[] },
          {
            id: email.id,
            contentType,
            bodyStructure: email.bodyStructure,
            bodyValues: email.bodyValues,
            attachments: email.attachments,
            blobId: email.blobId,
            from: email.from,
          },
        ) as {
          html?: string;
          text?: string;
          attachments?: Array<{ name?: string; type?: string; dataUrl?: string; cid?: string }>;
          handledBy?: string;
          blockExternalContent?: boolean;
        };
        if (cancelled) return;
        if (!result || !result.handledBy) {
          setBody(EMPTY);
          return;
        }
        const cidUrls: Record<string, string> = {};
        for (const att of Array.isArray(result.attachments) ? result.attachments : []) {
          if (!att.cid || !att.dataUrl) continue;
          const bytes = dataUrlToBytes(att.dataUrl);
          if (!bytes) continue;
          // Same re-typing as fetched cid parts before they get a blob: URL
          // in our origin (GHSA-xvjh-v9c6-qcvc).
          const url = URL.createObjectURL(toInertBlob(new Blob([bytes as BlobPart], { type: att.type || 'application/octet-stream' })));
          objectUrls.push(url);
          cidUrls[att.cid.replace(/^<|>$/g, '')] = url;
        }
        setBody({
          html: typeof result.html === 'string' && result.html ? result.html : null,
          text: typeof result.text === 'string' && result.text ? result.text : null,
          cidUrls,
          blockExternal: result.blockExternalContent === true,
        });
      } catch (err) {
        if (cancelled) return;
        debug.error('onRenderEmailBody hook failed:', err);
        setBody(EMPTY);
      }
    })();

    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
    // The latest message is read inside; see pluginRenderKey for what should run this again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginRenderKey(email), nonce]);

  return body;
}
