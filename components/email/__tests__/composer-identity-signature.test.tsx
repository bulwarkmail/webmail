import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';

// ─── Heavy component mocks (mirrors composer-format-toggle.test.tsx) ─

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
      { id: 'id-team', email: 'team@example.com', name: 'Team', htmlSignature: '', textSignature: '' },
    ] as Array<Record<string, unknown>>,
    defaultIdentityId: 'id-me',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook, notifyIdentitySelected: () => {} };
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
 * Switching From to an identity without a signature kept the previous
 * identity's signature, so a mail from a team address went out with the
 * personal signature. An identity the composer picks itself (a reply to an
 * alias) still borrows the primary signature.
 */

const DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Hello',
  body: '<p>Draft text</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

const fromSelect = () => screen.getByTestId('composer-from') as HTMLSelectElement;
const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;
const textarea = () => document.querySelector('textarea') as HTMLTextAreaElement;

async function send(onSend: ReturnType<typeof vi.fn>) {
  fireEvent.click(sendButton());
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0] as { body: string; htmlBody?: string };
}

describe('composer signature follows the picked identity', () => {
  afterEach(() => {
    useSettingsStore.setState({ plainTextMode: false });
    vi.clearAllMocks();
  });

  it('sends a reply from a hand-picked identity without the previous signature', async () => {
    const onSend = vi.fn();
    render(<EmailComposer mode="reply" initialData={{ ...DRAFT, mode: 'reply' }} onSend={onSend} />);
    fireEvent.change(fromSelect(), { target: { value: 'id-team' } });

    const sent = await send(onSend);
    expect(sent.htmlBody).not.toContain('Alice');
    expect(sent.body).not.toContain('Alice');
  });

  it('still borrows the primary signature for an identity it did not let the user pick', async () => {
    const onSend = vi.fn();
    render(<EmailComposer mode="reply" initialData={{ ...DRAFT, mode: 'reply', selectedIdentityId: 'id-team' }} onSend={onSend} />);

    const sent = await send(onSend);
    expect(sent.htmlBody).toContain('<b>Alice</b>');
  });

  it('swaps the signature in a plain-text message and brings it back', async () => {
    const SIGNED = 'Plain draft\n\n-- \nAlice';
    useSettingsStore.setState({ plainTextMode: true });
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT, body: SIGNED }} onSend={onSend} />);

    fireEvent.change(fromSelect(), { target: { value: 'id-team' } });
    await waitFor(() => expect(textarea().value).toBe('Plain draft'));

    fireEvent.change(fromSelect(), { target: { value: 'id-me' } });
    await waitFor(() => expect(textarea().value).toBe(SIGNED));

    fireEvent.change(fromSelect(), { target: { value: 'id-team' } });
    await waitFor(() => expect(textarea().value).toBe('Plain draft'));
    const sent = await send(onSend);
    expect(sent.body).toBe('Plain draft');
  });
});

describe('signature auto-insert toggles', () => {
  afterEach(() => {
    useSettingsStore.setState({
      plainTextMode: false,
      signatureNewMailEnabled: true,
      signatureReplyForwardEnabled: true,
    });
    vi.clearAllMocks();
  });

  it('keeps a new message free of the signature when the new-mail toggle is off', async () => {
    useSettingsStore.setState({ plainTextMode: true, signatureNewMailEnabled: false });
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT, body: 'Draft text' }} onSend={onSend} />);

    // Not embedded into the editable body…
    await waitFor(() => expect(textarea().value).toBe('Draft text'));
    // …and not appended at send time either.
    const sent = await send(onSend);
    expect(sent.body).toBe('Draft text');
  });

  it('sends a reply without appending the signature when the reply toggle is off', async () => {
    useSettingsStore.setState({ signatureReplyForwardEnabled: false });
    const onSend = vi.fn();
    render(<EmailComposer mode="reply" initialData={{ ...DRAFT, mode: 'reply' }} onSend={onSend} />);

    // No read-only signature preview under the editor: it would promise a
    // signature that never goes out.
    expect(document.body.textContent).not.toContain('Alice');

    const sent = await send(onSend);
    expect(sent.htmlBody).not.toContain('Alice');
    expect(sent.body).not.toContain('Alice');
  });
});
