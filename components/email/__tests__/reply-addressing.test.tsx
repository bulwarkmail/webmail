import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// ─── Heavy component mocks (mirrors recipient-paste.test.tsx) ─────────────────

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-focus-trap', () => ({
  useFocusTrap: () => ({ ref: { current: null } }),
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
      { id: 'id-info', email: 'info@example.com', name: 'Info' },
    ],
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
    sendDelaySeconds: 0,
    signaturePosition: 'above_quote',
    signatureSeparatorEnabled: false,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
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
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onSend: { call: async () => [] },
    beforeSend: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
  },
  contactHooks: {
    search: { call: async () => [] },
  },
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/signature-utils', () => ({
  appendPlainTextSignature: (body: string) => body,
  getPlainTextSignature: () => '',
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: () => {} }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

const RECEIVED = {
  from: [{ email: 'bob@other.com', name: 'Bob' }],
  to: [{ email: 'me@example.com', name: 'Me' }, { email: 'carol@other.com', name: 'Carol' }],
  cc: [{ email: 'dave@other.com', name: 'Dave' }],
  subject: 'Hello',
};

/** The same conversation, but the message opened is the one we sent back. */
const SELF_SENT = {
  from: [{ email: 'me@example.com', name: 'Me' }],
  to: [{ email: 'bob@other.com', name: 'Bob' }],
  cc: [{ email: 'carol@other.com', name: 'Carol' }],
  subject: 'Re: Hello',
};

/** Chip labels currently shown in a recipient row, in order. Chips are the
 *  draggable spans inside the row; next-intl is mocked to return the key, so
 *  the Cc row is found via its "cc_label" caption. */
const chipsIn = (row: HTMLElement) =>
  Array.from(row.querySelectorAll('[draggable]')).map((el) => el.textContent?.trim());

const toChips = () => chipsIn(screen.getByTestId('composer-to'));
const ccChips = () => chipsIn(screen.getByText('cc_label').parentElement as HTMLElement);

const identitySelect = () => screen.getByTestId('composer-from') as HTMLSelectElement;

describe('composer reply addressing', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('addresses a reply to the sender of a received message', () => {
    render(<EmailComposer mode="reply" replyTo={RECEIVED} />);
    expect(toChips()).toEqual(['Bob (bob@other.com)']);
  });

  it('reply-all keeps the other recipients but not our own address', () => {
    render(<EmailComposer mode="replyAll" replyTo={RECEIVED} />);
    expect(toChips()).toEqual(['Bob (bob@other.com)', 'Carol (carol@other.com)']);
    expect(ccChips()).toEqual(['Dave (dave@other.com)']);
  });

  // #703: replying to our own message inside a thread used to address the
  // reply back to ourselves instead of continuing the conversation.
  it('addresses a reply to our own message to the original recipient', () => {
    render(<EmailComposer mode="reply" replyTo={SELF_SENT} />);
    expect(toChips()).toEqual(['Bob (bob@other.com)']);
  });

  it('reply-all on our own message restores the original To and Cc', () => {
    render(<EmailComposer mode="replyAll" replyTo={SELF_SENT} />);
    expect(toChips()).toEqual(['Bob (bob@other.com)']);
    expect(ccChips()).toEqual(['Carol (carol@other.com)']);
  });

  it('sends the reply to our own message from the identity that sent it', () => {
    render(<EmailComposer mode="reply" replyTo={{ ...SELF_SENT, from: [{ email: 'info@example.com', name: 'Info' }] }} />);
    expect(identitySelect().value).toBe('id-info');
  });
});
