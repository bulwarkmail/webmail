import { useEffect, useMemo, useState } from 'react';
import type { Identity } from '@/lib/jmap/types';
import { identityHooks } from '@/lib/plugin-hooks';
import { getPlainTextSignature, signatureAsHtml } from '@/lib/signature-utils';

interface RenderedSignature {
  identityId: string;
  source: string;
  html: string;
  text: string;
}

const sourceKey = (identity: Identity) => JSON.stringify([identity.htmlSignature ?? '', identity.textSignature ?? '']);

/**
 * The signature the composer inserts for `identity`, after plugins had their
 * say through onSignatureRender. Returns the identity unchanged while no
 * plugin listens, and until a plugin's result arrives; after that, a copy
 * with the plugin's htmlSignature and textSignature. Every place that builds
 * a signature (the initial body, the identity swap, drafts, the send path)
 * reads the identity this returns, so they all insert the same text. The HTML
 * goes through the composer's signature sanitizer like any other signature.
 *
 * `revision` changes each time a plugin result is applied, so the composer
 * can swap the signature already in the body.
 *
 * With `locked` (an organisation signature the admin locked or hid) plugins
 * aren't asked and the identity comes back as it is.
 */
export function usePluginSignature(identity: Identity | null | undefined, options: { locked?: boolean } = {}): {
  identity: Identity | null | undefined;
  revision: number;
} {
  const [rendered, setRendered] = useState<RenderedSignature | null>(null);
  const [revision, setRevision] = useState(0);
  const id = identity?.id;
  const source = identity ? sourceKey(identity) : '';
  const locked = options.locked === true;

  useEffect(() => {
    if (locked || !identity || !id || identityHooks.onSignatureRender.size === 0) return;
    let cancelled = false;
    const initial = { html: identity.htmlSignature ?? '', text: identity.textSignature ?? '' };
    void identityHooks.onSignatureRender.transform(initial, { identityId: id }).then((result: unknown) => {
      if (cancelled) return;
      const r = result as { html?: unknown; text?: unknown } | null;
      let html = typeof r?.html === 'string' ? r.html : initial.html;
      let text = typeof r?.text === 'string' ? r.text : initial.text;
      if (html === initial.html && text === initial.text) return;
      // A plugin that changed one form only: the composer's other mode reads
      // the other form, which would still be the old signature. An empty one
      // needs nothing, as the composer falls back to the form that is set.
      if (text === initial.text && initial.text) text = getPlainTextSignature({ htmlSignature: html });
      else if (html === initial.html && initial.html) html = signatureAsHtml({ textSignature: text });
      setRendered({ identityId: id, source, html, text });
      setRevision((n) => n + 1);
    });
    return () => { cancelled = true; };
    // Keyed to the identity and its signature text, not the object, which is
    // rebuilt on unrelated store updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, source, locked]);

  const result = useMemo(() => {
    if (locked || !identity || !rendered || rendered.identityId !== identity.id || rendered.source !== sourceKey(identity)) {
      return identity;
    }
    return { ...identity, htmlSignature: rendered.html, textSignature: rendered.text };
  }, [identity, rendered, locked]);

  return { identity: result, revision };
}
