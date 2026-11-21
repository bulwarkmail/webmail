import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { resetSendPipeline } from '@/lib/outgoing/send-pipeline';
import { ExternalRecipientConfirmHost } from '../external-recipient-confirm';
import { useExternalRecipientConfirmStore } from '@/stores/external-recipient-confirm-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';

// ─── Heavy component mocks (mirrors composer-reopened-draft-signature.test.tsx) ─

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
      { id: 'id-me', email: 'me@example.com', name: 'Me' },
      { id: 'id-sales', email: 'sales@example.com', name: 'Sales' },
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
    addressBooks: [],
    trustedSendersBookId: null,
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
    onSelectReplyIdentity: { size: 0 },
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

// The external-recipient confirm in the real composer: the check is
// registered by the dialog host, asks only about the recipients outside the
// organisation, and the composer sends or not by the user's answer.

const DRAFT = {
  to: 'bob@example.com, dave@org-two.test',
  cc: 'carol@example.com',
  bcc: '',
  subject: 'Hello',
  body: '<p>Hi</p>',
  showCc: true,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

function setExternalMail(patch: Partial<typeof DEFAULT_ORGANISATION_POLICY.externalMail>) {
  usePolicyStore.setState({
    policy: {
      ...DEFAULT_POLICY,
      organisation: { ...DEFAULT_ORGANISATION_POLICY, externalMail: { ...DEFAULT_ORGANISATION_POLICY.externalMail, ...patch } },
    },
  });
}

function clickSend() {
  fireEvent.click(screen.getAllByTestId('composer-send')[0]);
}

function renderComposer(onSend: () => void) {
  return render(
    <>
      <EmailComposer initialData={DRAFT} onSend={onSend} />
      <ExternalRecipientConfirmHost />
    </>,
  );
}

describe('composer: confirm before sending outside the organisation', () => {
  beforeEach(() => {
    resetSendPipeline();
    useExternalRecipientConfirmStore.setState({ pending: null, queue: [] });
    setExternalMail({ recipientWarning: true });
    // The user's identities, as the auth store holds them after sign-in:
    // example.com is internal because of them.
    const identities = [
      { id: 'id-me', email: 'me@example.com', name: 'Me' },
      { id: 'id-sales', email: 'sales@example.com', name: 'Sales' },
    ];
    useAuthStore.setState({ identities } as never);
    useIdentityStore.setState({ identities } as never);
  });
  afterEach(() => {
    cleanup();
    resetSendPipeline();
    vi.clearAllMocks();
  });

  it('lists only the external recipient and sends nothing on Back', async () => {
    const onSend = vi.fn();
    const { container } = renderComposer(onSend);
    clickSend();
    const list = await waitFor(() => {
      const el = container.querySelector('[data-external-recipients]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(list.textContent).toContain('dave@org-two.test');
    expect(list.textContent).not.toContain('bob@example.com');
    expect(list.textContent).not.toContain('carol@example.com');
    fireEvent.click(container.querySelector('[data-external-recipient-back]')!);
    await waitFor(() => expect(container.querySelector('[data-external-recipient-confirm]')).toBeNull());
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends after Send anyway', async () => {
    const onSend = vi.fn();
    const { container } = renderComposer(onSend);
    clickSend();
    await waitFor(() => expect(container.querySelector('[data-external-recipient-send]')).not.toBeNull());
    fireEvent.click(container.querySelector('[data-external-recipient-send]')!);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it('leaves the identity\'s automatic Bcc out of the question', async () => {
    useIdentityStore.setState({
      identities: [
        { id: 'id-me', email: 'me@example.com', name: 'Me', bcc: [{ name: '', email: 'archive@archive-service.example' }] },
        { id: 'id-sales', email: 'sales@example.com', name: 'Sales' },
      ],
    } as never);
    const { container } = renderComposer(vi.fn());
    clickSend();
    const list = await waitFor(() => {
      const el = container.querySelector('[data-external-recipients]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(list.textContent).toContain('dave@org-two.test');
    expect(list.textContent).not.toContain('archive@archive-service.example');
  });

  it('sends without asking while the warning is off', async () => {
    setExternalMail({ recipientWarning: false, senderLabel: true });
    const onSend = vi.fn();
    const { container } = renderComposer(onSend);
    clickSend();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-external-recipient-confirm]')).toBeNull();
  });
});
