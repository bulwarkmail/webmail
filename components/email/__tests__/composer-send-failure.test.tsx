import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { RecipientsRejectedError, SubmissionQuotaError } from '@/lib/jmap/client';
import { useSettingsStore } from '@/stores/settings-store';

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

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: toastError, success: () => {}, warning: () => {} },
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
    onComposeSend: { intercept: async () => true, takeOver: async () => 'default' },
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

// Stalwart 1.0 refuses new submissions once an account holds `maxSubmissions`
// records. Its description asks the user to "delete some", which nobody can
// act on in a mail client, so the composer explains it instead.

const DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Hello',
  body: '<p>Hi</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

async function sendAndFail(error: unknown) {
  const onSend = vi.fn().mockRejectedValue(error);
  render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
  fireEvent.click(screen.getAllByTestId('composer-send')[0]);
  await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  const [title, options] = toastError.mock.calls[0] as [string, { message?: string } | undefined];
  return { title, message: options?.message };
}

describe('composer send failures', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('explains a full submission quota on Stalwart 1.0', async () => {
    const { title } = await sendAndFail(new SubmissionQuotaError('There are too many email submissions, please delete some before adding a new one.', true));

    expect(title).toBe('submission_quota');
  });

  it("shows another server's own reason for its overQuota, not Stalwart's explanation", async () => {
    const { title } = await sendAndFail(new SubmissionQuotaError('Daily sending limit exceeded', false));

    // The i18n test mock renders the key; the reason goes in as a value.
    expect(title).toBe('submission_limit');
  });

  it("shows the server's reason for other failures", async () => {
    const { title, message } = await sendAndFail(new Error('Envelope mailFrom does not match identity email address. [forbiddenFrom]'));

    expect(title).toBe('send_failed');
    expect(message).toBe('Envelope mailFrom does not match identity email address. [forbiddenFrom]');
  });

  // Stalwart 0.16 and 1.0 take the submission but refuse the recipient at
  // RCPT; the send fails and the composer keeps the message.
  it('says the message was not sent when the server refused every recipient', async () => {
    const { title, message } = await sendAndFail(new RecipientsRejectedError([{ email: 'nobody@example.net', smtpReply: '550 5.1.2 Relay not allowed.' }]));

    expect(title).toBe('send_recipients_rejected');
    expect(message).toBe('nobody@example.net (550 5.1.2 Relay not allowed.)');
    expect(screen.getByDisplayValue('Hello')).toBeInTheDocument();
  });

  // An account without send delay asks in the app's own dialog, not
  // window.confirm, before the message goes out at once.
  it('asks in a dialog before sending without the delay the account lacks', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    useSettingsStore.setState({ sendDelaySeconds: 10, explicitSettings: ['sendDelaySeconds'] } as never);
    try {
      const onSend = vi.fn().mockResolvedValue(undefined);
      render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
      fireEvent.click(screen.getAllByTestId('composer-send')[0]);
      const dialog = await screen.findByRole('alertdialog', { name: 'send_delay_unsupported_title' });
      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'send' }));
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    } finally {
      useSettingsStore.setState({ sendDelaySeconds: 0, explicitSettings: [] } as never);
    }
  });

  // Undo send is on by default: an account that can't delay just sends.
  it('sends at once, without asking, when the delay is only the default', async () => {
    useSettingsStore.setState({ sendDelaySeconds: 5, explicitSettings: [] } as never);
    try {
      const onSend = vi.fn().mockResolvedValue(undefined);
      render(<EmailComposer initialData={DRAFT} onSend={onSend} />);
      fireEvent.click(screen.getAllByTestId('composer-send')[0]);
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0][0].delayedUntil).toBeUndefined();
      expect(screen.queryByRole('alertdialog', { name: 'send_delay_unsupported_title' })).toBeNull();
    } finally {
      useSettingsStore.setState({ sendDelaySeconds: 0 } as never);
    }
  });
});
