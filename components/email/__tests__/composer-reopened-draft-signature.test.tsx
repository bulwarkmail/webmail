import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';
import { useIdentityStore } from '@/stores/identity-store';
import { SIGNATURE_BLOCK_MARKER, SIGNATURE_RANGE_MARKER, buildSignatureBlock } from '../signature-block';

// ─── Heavy component mocks (mirrors composer-draft-attachments.test.tsx) ─────

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ current: null }),
}));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

// ─── Store mocks ──────────────────────────────────────────────────────────────

vi.mock('@/stores/auth-store', () => {
  const state = {
    client: null,
    identities: [],
    primaryIdentity: null,
    isAuthenticated: false,
    isDemoMode: false,
    activeAccountId: null,
    connectionLost: false,
    getClientForAccount: () => undefined,
    getAllConnectedClients: () => new Map(),
    syncIdentities: () => {},
    refreshIdentities: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAuthStore: hook };
});

vi.mock('@/stores/identity-store', () => {
  const state = {
    identities: [
      { id: 'id-me', email: 'me@example.com', name: 'Me', htmlSignature: '<b>Alice</b>', textSignature: 'Alice' },
    ] as Array<Record<string, unknown>>,
    defaultIdentityId: 'id-me',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook };
});

vi.mock('@/stores/account-store', () => {
  const state = { accounts: [], getAccountById: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useAccountStore: hook };
});

vi.mock('@/stores/email-store', () => {
  const state = {
    draftSaveEnabled: false,
    sendRawEmail: async () => ({ sent: true }),
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

vi.mock('@/stores/settings-store', () => {
  const state = {
    timeFormat: '24h',
    plainTextMode: false,
    subAddressDelimiter: '+',
    autoSelectReplyIdentity: true,
    attachmentReminderEnabled: false,
    attachmentReminderKeywords: [],
    emptySubjectWarningEnabled: true,
    sendDelaySeconds: 0,
    // The default position: replies/forwards get the signature appended at
    // send time rather than embedded above the quote.
    signaturePosition: 'below_quote',
    signatureNewMailEnabled: true,
    signatureReplyForwardEnabled: true,
    signatureSeparatorEnabled: true,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
    updateSetting: () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useSettingsStore: hook };
});

vi.mock('@/stores/contact-store', () => {
  const state = {
    contacts: [],
    getAutocomplete: async () => [],
    addToTrustedSendersBook: async () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useContactStore: hook };
});

vi.mock('@/stores/template-store', () => {
  const state = { templates: [], addTemplate: async () => {} };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useTemplateStore: hook };
});

// ─── Misc dependency mocks ────────────────────────────────────────────────────

vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: () => {}, success: () => {} },
}));

vi.mock('@/lib/plugin-hooks', () => ({
  identityHooks: {
    onSignatureRender: { size: 0, transform: async (value: unknown) => value },
    onIdentitySelect: { size: 0, emit: async () => {} },
  },
  templateHooks: {
    onTemplateRender: { size: 0, transform: async (value: unknown) => value },
    onTemplateApply: { size: 0, emit: async () => {} },
  },
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: () => {} },
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: { intercept: async () => true, interceptOutcome: async () => 'allowed' },
    onComposeSend: { takeOver: async () => 'default' },
    onTransformOutgoingEmail: { transform: async (email: unknown) => email },
  },
  contactHooks: {
    search: { call: async () => [] },
    onProvideRecipientSuggestions: { transform: async (initial: unknown) => initial },
  },
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeSignatureHtmlForDisplay: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  sanitizePluginBodyHtml: (v: string) => v,
  escapeHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

/**
 * #848: a draft is always re-opened in `compose` mode with its body handed in
 * through initialData - so getInitialBody, the only place that embeds the
 * signature into a compose body, never runs. The send path nevertheless
 * treated every compose body as already carrying the signature and skipped
 * the append, so a "below quote" reply draft (whose body has no signature)
 * went out without one, with the preview hidden and no hint to the user.
 *
 * The body now gets the signature embedded when it is mounted from
 * initialData and does not carry it yet - keeping the compose-mode invariant
 * (#329: the signature lives in the editor, editable) true instead of assumed.
 */

const REOPENED_REPLY_DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Re: Quarterly numbers',
  // What a "below quote" reply draft saved before #823 looks like: the user's
  // text plus the quote, and no signature anywhere.
  body: '<p>Thanks, looks good.</p><blockquote>original mail</blockquote>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: 'draft-v1',
};

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;
const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

async function sendAndCapture(initialData: typeof REOPENED_REPLY_DRAFT) {
  const onSend = vi.fn();
  render(<EmailComposer initialData={initialData} onSend={onSend} />);
  fireEvent.click(sendButton());
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0] as { body: string; htmlBody?: string };
}

describe('re-opened draft signature (#848)', () => {
  afterEach(() => {
    useSettingsStore.setState({ plainTextMode: false });
    vi.clearAllMocks();
  });

  it('sends a re-opened reply draft with exactly one signature', async () => {
    const sent = await sendAndCapture(REOPENED_REPLY_DRAFT);

    expect(sent.htmlBody).toContain('<b>Alice</b>');
    expect(countOf(sent.htmlBody!, SIGNATURE_BLOCK_MARKER)).toBe(1);
    // Embedded after the quote - where the "below quote" position puts it and
    // where a #823-saved draft carries it.
    expect(sent.htmlBody!.indexOf('original mail')).toBeLessThan(sent.htmlBody!.indexOf('<b>Alice</b>'));
    expect(sent.body).toContain('Alice');
  });

  it('does not show the read-only preview as a second copy of the embedded signature', () => {
    render(<EmailComposer initialData={REOPENED_REPLY_DRAFT} />);
    // The editor is mocked, so the only way "Alice" could appear is the
    // below-editor preview - and the signature is in the body now.
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('leaves a draft that already carries the embedded signature alone', async () => {
    const body = `<p>Thanks.</p><blockquote>original mail</blockquote>`
      + `<p ${SIGNATURE_RANGE_MARKER}="separator">-- </p>${buildSignatureBlock('<b>Alice</b>')}<p ${SIGNATURE_RANGE_MARKER}="end"></p>`;
    const sent = await sendAndCapture({ ...REOPENED_REPLY_DRAFT, body });

    expect(countOf(sent.htmlBody!, SIGNATURE_BLOCK_MARKER)).toBe(1);
    expect(countOf(sent.htmlBody!, '<b>Alice</b>')).toBe(1);
  });

  it('leaves the body untouched when the identity has no signature', async () => {
    const identities = useIdentityStore.getState().identities;
    useIdentityStore.setState({ identities: [{ id: 'id-me', email: 'me@example.com', name: 'Me', mayDelete: true }] });
    try {
      const sent = await sendAndCapture(REOPENED_REPLY_DRAFT);
      expect(sent.htmlBody).not.toContain(SIGNATURE_RANGE_MARKER);
      expect(sent.htmlBody).not.toContain('Alice');
    } finally {
      useIdentityStore.setState({ identities });
    }
  });

  describe('plain text mode', () => {
    it('appends the text signature to a re-opened draft that lacks it', async () => {
      useSettingsStore.setState({ plainTextMode: true });
      const sent = await sendAndCapture({
        ...REOPENED_REPLY_DRAFT,
        body: 'Thanks, looks good.\n\n> original mail',
      });

      expect(sent.body).toBe('Thanks, looks good.\n\n> original mail\n\n-- \nAlice');
    });

    it('does not duplicate a text signature the draft already ends with', async () => {
      useSettingsStore.setState({ plainTextMode: true });
      const sent = await sendAndCapture({
        ...REOPENED_REPLY_DRAFT,
        body: 'Thanks.\n\n> original mail\n\n-- \nAlice',
      });

      expect(sent.body).toBe('Thanks.\n\n> original mail\n\n-- \nAlice');
    });
  });
});
