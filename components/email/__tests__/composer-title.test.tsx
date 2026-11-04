import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// ─── Heavy component mocks (mirrors reply-addressing.test.tsx) ────────────────

const editorKeyDown = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', {
    'data-testid': 'rich-text-editor',
    onKeyDown: (event: React.KeyboardEvent) => {
      if (!event.defaultPrevented) editorKeyDown();
    },
  }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
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
    identities: [{ id: 'id-me', email: 'me@example.com', name: 'Me' }],
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

const updateSetting = vi.fn();

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
    signaturePosition: 'above_quote',
    signatureSeparatorEnabled: false,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
    updateSetting: (...args: unknown[]) => updateSetting(...args),
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
  toast: { info: () => {}, error: toastError, success: () => {} },
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
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

// The title said "New Message" for replies and forwards too.

const DATA = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Re: Lunch',
  body: '<p>Hello there</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  draftId: null,
};

describe('composer title', () => {
  beforeEach(() => {
    toastError.mockClear();
    updateSetting.mockClear();
    editorKeyDown.mockClear();
  });

  it.each([
    ['compose', 'new_message'],
    ['reply', 'reply'],
    ['replyAll', 'reply_all'],
    ['forward', 'forward'],
  ] as const)('names a %s composer %s', (mode, title) => {
    render(<EmailComposer initialData={{ ...DATA, mode }} mode={mode} />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(title);
  });

  // compose-p3-6: a re-opened reply draft is in "compose" mode and was called "New message".
  it('names a re-opened reply draft a reply', () => {
    render(<EmailComposer initialData={{ ...DATA, mode: 'compose', inReplyTo: ['m1@example.org'] }} mode="compose" />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('reply');
  });

  it('names a reply draft resumed with Reply all a reply to all', () => {
    render(<EmailComposer initialData={{ ...DATA, mode: 'compose', inReplyTo: ['m1@example.org'], kind: 'replyAll' }} mode="compose" />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('reply_all');
  });

  it('names the close button for screen readers', () => {
    render(<EmailComposer initialData={{ ...DATA, mode: 'compose' }} />);
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();
  });

  // R4: Close at the top end. On a phone it moves to the start (Send is at the end there).
  it('puts Close at the end of the header, and at the start only on a phone', () => {
    render(<EmailComposer initialData={{ ...DATA, mode: 'compose' }} />);
    const close = screen.getByRole('button', { name: 'close' });
    expect(close.parentElement!.lastElementChild).toBe(close);
    expect(close.className).toContain('max-md:order-first');
  });
});
