'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Identity } from '@/lib/jmap/types';
import { SettingsSection } from './settings-section';
import { SignatureEditor, SIGNATURE_MAX_BYTES, signatureBytes, type SignatureChange } from '@/components/identity/signature-editor';
import { LockedSignature, SharedSignatureNote } from '@/components/identity/identity-form';
import { useOrgSignatureSetup } from '@/hooks/use-org-signature';
import { sanitizeSignatureHtml } from '@/lib/email-sanitization';
import { toUnicodeEmail } from '@/lib/idn';
import { copySignatureToUsers, setSignatureSource, signatureFieldsOf, signatureSourceOf } from '@/lib/shared-signatures';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useIdentityStore, saveIdentityChanges } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';

/** How long typing has to pause before the signature is saved. */
export const SIGNATURE_SAVE_DELAY_MS = 1000;

/** The select's value for an address's own signature. */
const OWN_SIGNATURE = '';

function addressLabel(identity: Pick<Identity, 'name' | 'email'>): string {
  return identity.name ? `${identity.name} <${toUnicodeEmail(identity.email)}>` : toUnicodeEmail(identity.email);
}

/**
 * Settings > Composing > Signatures: every address you send from with its
 * signature editor right there, saved as you type (settings-p2-3). Gmail
 * and Outlook keep the signature on the compose settings; it used to sit
 * four clicks deep in the address editor. An address can also use another
 * address's signature (#1190, lib/shared-signatures.ts).
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
            <AddressSignature key={identity.id} identity={identity} identities={identities} />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

type SaveStatus = 'idle' | 'saved' | 'error';

function AddressSignature({ identity, identities }: { identity: Identity; identities: Identity[] }) {
  const t = useTranslations('uxs2_ident.signatures');
  const client = useAuthStore((s) => s.client);
  const loginId = useAccountStore((s) => s.activeAccountId);
  const signatureSources = useSettingsStore((s) => s.signatureSources);
  // The admin's `signature` restriction, as in the address editor.
  const org = useOrgSignatureSetup({ name: identity.name, email: identity.email });
  const hidden = org.restriction.hidden;
  const locked = org.restriction.locked && !hidden;
  const [status, setStatus] = useState<SaveStatus>('idle');
  const pickId = useId();

  const source = signatureSourceOf(signatureSources, loginId, identity.id, identities);
  // Another address's signature, to use instead of its own: one that has its own.
  const sources = identities.filter((other) => other.id !== identity.id
    && !signatureSourceOf(signatureSources, loginId, other.id, identities));
  const canShare = !!loginId && !locked && sources.length > 0;

  const pickSource = async (sourceId: string) => {
    if (!loginId) return;
    const next = setSignatureSource(useSettingsStore.getState().signatureSources, loginId, identity.id, sourceId || null);
    useSettingsStore.getState().updateSetting('signatureSources', next);
    setStatus('idle');
    if (!sourceId || !client) return;
    // Every address using the chosen signature gets it on the server now,
    // this one and those that used this one's.
    const chosen = signatureSourceOf(next, loginId, identity.id, identities);
    if (!chosen) return;
    try {
      await copySignatureToUsers(client, chosen, signatureFieldsOf(chosen));
      useAuthStore.getState().syncIdentities();
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  };

  if (hidden) return null;

  return (
    <div data-testid="address-signature" data-address={identity.email}>
      {identities.length > 1 && (
        <p className="text-sm font-medium text-foreground mb-2 wrap-anywhere" dir="auto">
          {addressLabel(identity)}
        </p>
      )}
      {canShare && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <label htmlFor={pickId} className="text-sm text-muted-foreground">{t('use_label')}</label>
          <select
            id={pickId}
            data-testid="signature-source"
            value={source?.id ?? OWN_SIGNATURE}
            onChange={(e) => void pickSource(e.target.value)}
            className="min-w-0 max-w-full flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
          >
            <option value={OWN_SIGNATURE}>{t('own')}</option>
            {sources.map((other) => (
              <option key={other.id} value={other.id} dir="auto">{t('same_as', { address: addressLabel(other) })}</option>
            ))}
          </select>
        </div>
      )}
      {locked ? (
        <LockedSignature
          html={org.signature ? org.signature.html : identity.htmlSignature ?? ''}
          text={org.signature ? org.signature.text : identity.textSignature ?? ''}
        />
      ) : source ? (
        <LockedSignature
          html={source.htmlSignature ?? ''}
          text={source.textSignature ?? ''}
          note={<SharedSignatureNote source={source} />}
        />
      ) : (
        <OwnSignatureEditor identity={identity} onStatus={setStatus} />
      )}
      <p className="text-xs mt-1 min-h-4" role="status" aria-live="polite">
        {status === 'saved' && <span className="text-muted-foreground">{t('saved')}</span>}
        {status === 'error' && <span className="text-destructive">{t('error')}</span>}
      </p>
    </div>
  );
}

/** The address's own signature, saved as you type and copied to the addresses that use it. */
function OwnSignatureEditor({ identity, onStatus }: { identity: Identity; onStatus: (status: SaveStatus) => void }) {
  const client = useAuthStore((s) => s.client);
  const plainTextMode = useSettingsStore((s) => s.plainTextMode);

  const [draft, setDraft] = useState({ html: identity.htmlSignature ?? '', text: identity.textSignature ?? '' });
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
      await copySignatureToUsers(client, identity, updates);
      useAuthStore.getState().syncIdentities();
      onStatus('saved');
    } catch {
      savedRef.current = last;
      onStatus('error');
    }
  }, [client, identity, plainTextMode, onStatus]);

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
    onStatus('idle');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flushRef.current(); }, SIGNATURE_SAVE_DELAY_MS);
  };

  return (
    <div
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void flush();
      }}
    >
      <SignatureEditor
        html={draft.html}
        text={draft.text}
        plainOnly={plainTextMode}
        onChange={onChange}
      />
    </div>
  );
}
