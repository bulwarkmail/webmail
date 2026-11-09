import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { resetSendPipeline } from '@/lib/outgoing/send-pipeline';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';

// Sending a reply trusts its recipients for remote content. While the
// organisation blocks remote content that trust has no effect, but it would
// the moment the block is lifted, with senders nobody chose to trust. So
// nothing is added while the block is on.

const trust = vi.hoisted(() => ({ addTrustedSender: vi.fn(), addToTrustedSendersBook: vi.fn(async () => {}) }));

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({ useFocusTrap: () => ({ current: null }) }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

function storeMock<T extends object>(state: T) {
  const hook = (sel?: (s: T) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  hook.setState = (p: Partial<T>) => Object.assign(state, p);
  return hook;
}

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: storeMock({
    client: null, identities: [{ id: 'id-me', email: 'me@example.com', name: 'Me' }], primaryIdentity: null,
    isAuthenticated: false, isDemoMode: false, activeAccountId: null, connectionLost: false,
    getClientForAccount: () => undefined, getAllConnectedClients: () => new Map(),
    syncIdentities: () => {}, refreshIdentities: async () => {},
  }),
}));
vi.mock('@/stores/identity-store', () => ({
  useIdentityStore: storeMock({ identities: [{ id: 'id-me', email: 'me@example.com', name: 'Me' }], defaultIdentityId: 'id-me' }),
}));
vi.mock('@/stores/account-store', () => ({ useAccountStore: storeMock({ accounts: [], getAccountById: () => undefined }) }));
vi.mock('@/stores/email-store', () => ({ useEmailStore: storeMock({ draftSaveEnabled: false, sendRawEmail: async () => ({ sent: true }) }) }));
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: storeMock({
    timeFormat: '24h', plainTextMode: false, subAddressDelimiter: '+', autoSelectReplyIdentity: true,
    attachmentReminderEnabled: false, attachmentReminderKeywords: [], emptySubjectWarningEnabled: true,
    sendDelaySeconds: 0, signaturePosition: 'below_quote', signatureSeparatorEnabled: true,
    requestReadReceiptDefault: false, externalContentPolicy: 'block',
    addTrustedSender: trust.addTrustedSender, isSenderTrusted: () => false,
    trustedSendersAddressBook: null, updateSetting: () => {},
  }),
}));
vi.mock('@/stores/contact-store', () => ({
  useContactStore: storeMock({
    contacts: [], addressBooks: [], trustedSendersBookId: null, getAutocomplete: async () => [],
    addToTrustedSendersBook: trust.addToTrustedSendersBook,
  }),
}));
vi.mock('@/stores/template-store', () => ({ useTemplateStore: storeMock({ templates: [], addTemplate: async () => {} }) }));
vi.mock('@/stores/toast-store', () => ({ toast: { info: () => {}, error: () => {}, success: () => {} } }));
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
vi.mock('@/lib/email-threading', () => ({ computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }) }));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({ buildQuotedHtmlBlock: () => '', serializeEditorContent: () => '' }));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

const DRAFT = {
  to: 'news@shop.example', cc: '', bcc: '', subject: 'Re: Offer', body: '<p>Thanks</p>',
  showCc: false, showBcc: false, selectedIdentityId: 'id-me', subAddressTag: '', mode: 'reply' as const, draftId: null,
};

function lockToBlock(locked: boolean) {
  usePolicyStore.setState({
    policy: { ...DEFAULT_POLICY, restrictions: locked ? { externalContentPolicy: { locked: true, value: 'block' } } : {} },
  });
}

async function sendReply() {
  const onSend = vi.fn();
  render(<EmailComposer mode="reply" initialData={DRAFT} onSend={onSend} />);
  fireEvent.click(screen.getAllByTestId('composer-send')[0]);
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
}

describe('composer: replies and trusted senders', () => {
  afterEach(() => {
    cleanup();
    resetSendPipeline();
    usePolicyStore.setState({ policy: DEFAULT_POLICY });
    vi.clearAllMocks();
  });

  it('trusts the recipients of a reply when nothing blocks remote content', async () => {
    lockToBlock(false);
    await sendReply();
    await waitFor(() => expect(trust.addTrustedSender).toHaveBeenCalledWith('news@shop.example'));
  });

  it('adds no trusted senders while the organisation locks remote content to block', async () => {
    lockToBlock(true);
    await sendReply();
    await new Promise((r) => setTimeout(r, 20));
    expect(trust.addTrustedSender).not.toHaveBeenCalled();
    expect(trust.addToTrustedSendersBook).not.toHaveBeenCalled();
  });
});
