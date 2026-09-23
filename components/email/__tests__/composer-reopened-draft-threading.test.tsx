import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

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
  emailHooks: {
    onComposerOpen: { call: async () => [] },
    onRecipientChange: { call: async () => [] },
    getRecipientSuggestions: { call: async () => [] },
    onRecipientChipsChange: { transform: async (chips: unknown) => chips },
    onDraftChange: { emit: () => {} },
    onBeforeDraftAutoSave: { transform: async (draft: unknown) => draft },
    onBeforeEmailSend: { intercept: async () => true },
    onComposeSend: { intercept: async () => true },
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

vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

/**
 * A draft is always re-opened in `compose` mode with no `replyTo`, and the
 * composer only computed In-Reply-To/References in reply mode. createDraft
 * could not store them either. So a reply saved as a draft - by the autosave,
 * or by anything else that writes drafts over JMAP - lost its place in the
 * thread: every later save stored it without the headers, and sending it
 * started a new conversation at the recipient.
 *
 * The draft now hands its headers in through initialData, and both the save
 * and the send path carry them over.
 */

const REOPENED_REPLY_DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Re: Quarterly numbers',
  body: '<p>Thanks, looks good.</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: 'draft-v1',
  inReplyTo: ['parent@example.com'],
  references: ['root@example.com', 'parent@example.com'],
};

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;

function mockClient() {
  const createDraft = vi.fn().mockResolvedValue('draft-v2');
  const client = {
    createDraft,
    getEmail: vi.fn().mockResolvedValue(null),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
  };
  useAuthStore.setState({ client: client as never });
  return { createDraft };
}

/** Edit the subject so the autosave debounce arms, then let it fire. */
async function editAndAutosave() {
  // Matched loosely: a reply's subject carries the (translated) reply prefix.
  const subject = screen.getByDisplayValue(/Quarterly numbers/) as HTMLInputElement;
  fireEvent.change(subject, { target: { value: `${subject.value} (edited)` } });
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
}

describe('re-opened reply draft threading', () => {
  afterEach(() => {
    useAuthStore.setState({ client: null });
    vi.clearAllMocks();
  });

  describe('saving', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stores In-Reply-To and References again when a re-opened reply draft is saved', async () => {
      const { createDraft } = mockClient();
      render(<EmailComposer initialData={REOPENED_REPLY_DRAFT} onClose={vi.fn()} />);

      await editAndAutosave();

      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(createDraft.mock.calls[0][11]).toEqual(['parent@example.com']);
      expect(createDraft.mock.calls[0][12]).toEqual(['root@example.com', 'parent@example.com']);
    });

    it('stores the headers of a reply while it is still being written', async () => {
      const { createDraft } = mockClient();
      render(
        <EmailComposer
          mode="reply"
          replyTo={{
            from: [{ email: 'bob@example.com', name: 'Bob' }],
            subject: 'Quarterly numbers',
            body: 'original mail',
            messageId: '<parent@example.com>',
            references: ['<root@example.com>'],
          }}
          onClose={vi.fn()}
        />,
      );

      await editAndAutosave();

      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(createDraft.mock.calls[0][11]).toEqual(['parent@example.com']);
      expect(createDraft.mock.calls[0][12]).toEqual(['root@example.com', 'parent@example.com']);
    });

    it('stores no threading headers for a draft that answers nothing', async () => {
      const { createDraft } = mockClient();
      const { inReplyTo: _i, references: _r, ...newMessage } = REOPENED_REPLY_DRAFT;
      render(<EmailComposer initialData={{ ...newMessage, subject: 'Quarterly numbers' }} onClose={vi.fn()} />);

      await editAndAutosave();

      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(createDraft.mock.calls[0][11]).toBeUndefined();
      expect(createDraft.mock.calls[0][12]).toBeUndefined();
    });
  });

  describe('sending', () => {
    it('sends a re-opened reply draft with its In-Reply-To and References', async () => {
      const onSend = vi.fn();
      render(<EmailComposer initialData={REOPENED_REPLY_DRAFT} onSend={onSend} />);

      fireEvent.click(sendButton());
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

      const sent = onSend.mock.calls[0][0] as { inReplyTo?: string[]; references?: string[] };
      expect(sent.inReplyTo).toEqual(['parent@example.com']);
      expect(sent.references).toEqual(['root@example.com', 'parent@example.com']);
    });

    it('sends a re-opened draft that answers nothing without threading headers', async () => {
      const onSend = vi.fn();
      const { inReplyTo: _i, references: _r, ...newMessage } = REOPENED_REPLY_DRAFT;
      render(<EmailComposer initialData={newMessage} onSend={onSend} />);

      fireEvent.click(sendButton());
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

      const sent = onSend.mock.calls[0][0] as { inReplyTo?: string[]; references?: string[] };
      expect(sent.inReplyTo).toBeUndefined();
      expect(sent.references).toBeUndefined();
    });
  });
});
