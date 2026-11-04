'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Identity } from '@/lib/jmap/types';
import { SettingsSection } from './settings-section';
import { SignatureEditor, SIGNATURE_MAX_BYTES, signatureBytes, type SignatureChange } from '@/components/identity/signature-editor';
import { LockedSignature } from '@/components/identity/identity-form';
import { useOrgSignatureSetup } from '@/hooks/use-org-signature';
import { sanitizeSignatureHtml } from '@/lib/email-sanitization';
import { toUnicodeEmail } from '@/lib/idn';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore, saveIdentityChanges } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';

/** How long typing has to pause before the signature is saved. */
export const SIGNATURE_SAVE_DELAY_MS = 1000;

/**
 * Settings > Composing > Signatures: every address you send from with its
 * signature editor right there, saved as you type (settings-p2-3). Gmail
 * and Outlook keep the signature on the compose settings; it used to sit
 * four clicks deep in the address editor.
 */
export function SignaturesSection() {
  const t = useTranslations('uxs2_ident.signatures');
  const identities = useIdentityStore((s) => s.identities);

  return (
    <SettingsSection id="signatures" title={t('title')} description={t('description')}>
      {identities.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('no_addresses')}</p>
      ) : (
        <div className="space-y-6">
          {identities.map((identity) => (
            <AddressSignature key={identity.id} identity={identity} showAddress={identities.length > 1} />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

function AddressSignature({ identity, showAddress }: { identity: Identity; showAddress: boolean }) {
  const t = useTranslations('uxs2_ident.signatures');
  const client = useAuthStore((s) => s.client);
  const plainTextMode = useSettingsStore((s) => s.plainTextMode);
  // The admin's `signature` restriction, as in the address editor.
  const org = useOrgSignatureSetup({ name: identity.name, email: identity.email });
  const hidden = org.restriction.hidden;
  const locked = org.restriction.locked && !hidden;

  const [draft, setDraft] = useState({ html: identity.htmlSignature ?? '', text: identity.textSignature ?? '' });
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedRef = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const next = draftRef.current;
    const last = savedRef.current;
    if (next.html === last.html && next.text === last.text) return;
    // Too long: the editor says so under the field, and nothing is cut off.
    if (signatureBytes(next.html, next.text, plainTextMode) > SIGNATURE_MAX_BYTES) return;
    if (!client) return;
    // JMAP clears a field with null, as the address editor sends it.
    const updates = {
      htmlSignature: next.html.trim() ? sanitizeSignatureHtml(next.html) : null,
      textSignature: next.text.trim() ? next.text : null,
    };
    savedRef.current = next;
    try {
      if (!(await saveIdentityChanges(client, identity, updates))) {
        savedRef.current = last;
        return;
      }
      useAuthStore.getState().syncIdentities();
      setStatus('saved');
    } catch {
      savedRef.current = last;
      setStatus('error');
    }
  }, [client, identity, plainTextMode]);

  // Leaving the page saves what is still waiting for its pause.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => { void flushRef.current(); }, []);

  const onChange = (change: SignatureChange) => {
    setDraft((prev) => {
      const next = { html: change.htmlSignature ?? prev.html, text: change.textSignature ?? prev.text };
      draftRef.current = next;
      return next;
    });
    setStatus('idle');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flushRef.current(); }, SIGNATURE_SAVE_DELAY_MS);
  };

  if (hidden) return null;

  return (
    <div
      data-testid="address-signature"
      data-address={identity.email}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void flush();
      }}
    >
      {showAddress && (
        <p className="text-sm font-medium text-foreground mb-2 wrap-anywhere" dir="auto">
          {identity.name ? `${identity.name} <${toUnicodeEmail(identity.email)}>` : toUnicodeEmail(identity.email)}
        </p>
      )}
      {locked ? (
        <LockedSignature
          html={org.signature ? org.signature.html : draft.html}
          text={org.signature ? org.signature.text : draft.text}
        />
      ) : (
        <SignatureEditor
          html={draft.html}
          text={draft.text}
          plainOnly={plainTextMode}
          onChange={onChange}
        />
      )}
      <p className="text-xs mt-1 min-h-4" role="status" aria-live="polite">
        {status === 'saved' && <span className="text-muted-foreground">{t('saved')}</span>}
        {status === 'error' && <span className="text-destructive">{t('error')}</span>}
      </p>
    </div>
  );
}
