import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { resetSendPipeline } from '@/lib/outgoing/send-pipeline';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { LABEL_PRESETS } from '@/lib/classification/presets';

// The composer's classification label: a required label blocks sending
// (fail closed) until one is picked, the label goes on after the plugins'
// onTransformOutgoingEmail so none can drop it, a reply starts with the
// original's label, and a crypto takeover gets the labelled subject.

const hooks = vi.hoisted(() => ({
  transform: vi.fn(async (email: unknown) => email),
  takeOver: vi.fn(async (..._args: unknown[]) => 'default'),
  toastError: vi.fn(),
}));

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
  hook.subscribe = () => () => {};
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
    attachmentReminderEnabled: false, attachmentReminderKeywords: [], emptySubjectWarningEnabled: false,
    sendDelaySeconds: 0, signaturePosition: 'below_quote', signatureSeparatorEnabled: true,
    requestReadReceiptDefault: false, externalContentPolicy: 'ask',
    addTrustedSender: () => {}, isSenderTrusted: () => false,
    trustedSendersAddressBook: null, updateSetting: () => {},
  }),
}));
vi.mock('@/stores/contact-store', () => ({
  useContactStore: storeMock({
    contacts: [], addressBooks: [], trustedSendersBookId: null, getAutocomplete: async () => [],
    addToTrustedSendersBook: async () => {},
  }),
}));
vi.mock('@/stores/template-store', () => ({ useTemplateStore: storeMock({ templates: [], addTemplate: async () => {} }) }));
vi.mock('@/stores/toast-store', () => ({ toast: { info: () => {}, error: hooks.toastError, success: () => {}, warning: () => {} } }));
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
    onComposeSend: { takeOver: hooks.takeOver },
    onTransformOutgoingEmail: { transform: hooks.transform },
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

const generic = LABEL_PRESETS[0];

function useLabels(labels: Partial<typeof DEFAULT_ORGANISATION_POLICY.labels>) {
  usePolicyStore.setState({
    loaded: true,
    policy: {
      ...DEFAULT_POLICY,
      organisation: { ...DEFAULT_ORGANISATION_POLICY, labels: { ...DEFAULT_ORGANISATION_POLICY.labels, list: generic.list, extraHeader: 'X-Classification', ...labels } },
    },
  });
}

const DRAFT = {
  to: 'bob@example.org', cc: '', bcc: '', subject: 'Budget', body: '<p>Numbers</p>',
  showCc: false, showBcc: false, selectedIdentityId: 'id-me', subAddressTag: '', mode: 'compose' as const, draftId: null,
};

type SendData = { subject: string; headers?: Record<string, string>; labelHeaders?: Record<string, string> };

function renderComposer(props: Partial<React.ComponentProps<typeof EmailComposer>> = {}) {
  const onSend = vi.fn<(data: SendData) => void>();
  render(<EmailComposer mode="compose" initialData={DRAFT} onSend={onSend} {...props} />);
  return onSend;
}

const send = async () => {
  await act(async () => { fireEvent.click(screen.getAllByTestId('composer-send')[0]); });
};

afterEach(() => {
  cleanup();
  resetSendPipeline();
  usePolicyStore.setState({ policy: DEFAULT_POLICY });
  vi.clearAllMocks();
  hooks.transform.mockImplementation(async (email: unknown) => email);
  hooks.takeOver.mockImplementation(async () => 'default');
});

describe('composer: classification label', () => {
  it('shows no picker and changes nothing while the organisation has no labels', async () => {
    const onSend = renderComposer();
    expect(screen.queryByTestId('composer-classification')).toBeNull();
    await send();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0].subject).toBe('Budget');
    expect(onSend.mock.calls[0][0].labelHeaders).toBeUndefined();
  });

  it('blocks sending until a required label is picked, then stamps it', async () => {
    useLabels({ required: true, defaultId: '' });
    const onSend = renderComposer();
    await send();
    expect(onSend).not.toHaveBeenCalled();
    expect(hooks.toastError).toHaveBeenCalledWith('required_toast');
    // The picker opened, as a radio group without "No label".
    expect(screen.queryByTestId('composer-classification-option-none')).toBeNull();
    fireEvent.click(screen.getByTestId('composer-classification-option-confidential'));
    await send();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const data = onSend.mock.calls[0][0];
    expect(data.subject).toBe('[Confidential] Budget');
    expect(data.labelHeaders?.['header:SIO-Label:asRaw']).toContain('marking="CONFIDENTIAL"');
    expect(data.labelHeaders?.['header:Sensitivity:asText']).toBe('Company-Confidential');
    expect(data.labelHeaders?.['header:X-Classification:asText']).toBe('Confidential');
  });

  it('labels after the plugins: a plugin can neither drop the prefix nor set the label headers', async () => {
    useLabels({ defaultId: 'strictly-confidential' });
    hooks.transform.mockImplementation(async (email: unknown) => ({
      ...(email as object),
      subject: 'Budget (rewritten)',
      headers: { 'SIO-Label': 'marking="PUBLIC"', Sensitivity: 'Personal', 'X-Classification': 'Public', 'X-Other': '1' },
    }));
    const onSend = renderComposer();
    await send();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const data = onSend.mock.calls[0][0];
    expect(data.subject).toBe('[Strictly confidential] Budget (rewritten)');
    expect(data.headers).toEqual({ 'X-Other': '1' });
    expect(data.labelHeaders?.['header:SIO-Label:asRaw']).toContain('STRICTLY CONFIDENTIAL');
  });

  it('starts a reply with the original’s label', async () => {
    useLabels({ defaultId: 'public' });
    const onSend = renderComposer({
      mode: 'reply',
      initialData: { ...DRAFT, mode: 'reply', subject: 'Re: [Confidential] Budget' },
      replyTo: { subject: '[Confidential] Budget', from: [{ email: 'boss@example.com' }], headers: { 'SIO-Label': ' marking="CONFIDENTIAL"; bgcolor=#d97706' } },
    });
    expect(screen.getByTestId('composer-classification-trigger').textContent).toContain('Confidential');
    await send();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0].subject).toBe('[Confidential] Re: Budget');
  });

  it('ignores a label an outside sender wrote, and starts with the default', async () => {
    useLabels({ defaultId: 'internal' });
    renderComposer({
      mode: 'reply',
      initialData: { ...DRAFT, mode: 'reply', subject: 'Re: Offer' },
      replyTo: { subject: 'Offer', from: [{ email: 'shop@outside.example' }], headers: { 'SIO-Label': ' marking="PUBLIC"' } },
    });
    expect(screen.getByTestId('composer-classification-trigger').textContent).toContain('Internal');
  });

  it('lets the user take the label off when none is required', async () => {
    useLabels({ defaultId: 'confidential' });
    const onSend = renderComposer();
    fireEvent.click(screen.getByTestId('composer-classification-trigger'));
    fireEvent.keyDown(screen.getByTestId('composer-classification-option-confidential'), { key: 'Home' });
    fireEvent.keyDown(screen.getByTestId('composer-classification-option-none'), { key: 'Enter' });
    expect(screen.queryByTestId('composer-classification-options')).toBeNull();
    await send();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0].subject).toBe('Budget');
    expect(onSend.mock.calls[0][0].labelHeaders).toBeUndefined();
  });

  it('hands a crypto takeover the labelled subject', async () => {
    useLabels({ defaultId: 'confidential' });
    hooks.takeOver.mockImplementation(async () => 'handled');
    const onSend = renderComposer();
    await send();
    await waitFor(() => expect(hooks.takeOver).toHaveBeenCalledTimes(1));
    expect((hooks.takeOver.mock.calls[0][0] as { subject: string }).subject).toBe('[Confidential] Budget');
    expect(onSend).not.toHaveBeenCalled();
  });
});
