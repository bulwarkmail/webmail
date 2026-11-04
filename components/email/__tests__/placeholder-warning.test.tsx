import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';

// The UI language whose fill-in words t.raw hands the composer.
const ui = vi.hoisted(() => ({ locale: 'en' }));

vi.mock('next-intl', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const messages = (locale: string) =>
    JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../locales', locale, 'common.json'), 'utf-8'));
  return {
    useTranslations: (namespace?: string) => {
      const t = (key: string) => key;
      t.raw = (key: string) => (namespace ? messages(ui.locale)[namespace] : messages(ui.locale))[key];
      return t;
    },
    useLocale: () => ui.locale,
    useFormatter: () => ({
      dateTime: (d: Date | string) => String(d),
      relativeTime: (d: Date | string) => String(d),
      number: (n: number) => String(n),
    }),
  };
});

// ─── Heavy component mocks (mirrors empty-subject-warning.test.tsx) ──────────

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
    placeholderWarningEnabled: true,
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
  sanitizeEmailHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/signature-utils', () => ({
  appendPlainTextSignature: (body: string) => body,
  getPlainTextSignature: () => '',
  plainTextBodyWithoutSignature: (body: string) => body,
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

/** A ready-to-send draft whose body still has a fill-in. */
const DRAFT_WITH_PLACEHOLDER = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Lunch',
  body: '<p>See you at [TIME] in TODO.</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;

describe('composer placeholder warning', () => {
  beforeEach(() => {
    updateSetting.mockClear();
  });

  afterEach(() => {
    ui.locale = 'en';
    useSettingsStore.setState({
      placeholderWarningEnabled: true,
      attachmentReminderEnabled: false,
      attachmentReminderKeywords: [],
      sendConfirmation: false,
    } as never);
  });

  it('asks before sending and lists the placeholders', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITH_PLACEHOLDER} onSend={onSend} />);

    fireEvent.click(sendButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('placeholder_warning.title')).toBeInTheDocument();
    const found = within(dialog).getAllByRole('listitem').map((li) => li.textContent);
    expect(found).toEqual(['[TIME]', 'TODO']);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends once confirmed', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITH_PLACEHOLDER} onSend={onSend} />);

    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByText('placeholder_warning.send_anyway'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(updateSetting).not.toHaveBeenCalled();
  });

  it('turns the warning off when "don\'t ask again" is checked', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITH_PLACEHOLDER} onSend={onSend} />);

    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByText('placeholder_warning.dont_ask_again'));
    fireEvent.click(screen.getByText('placeholder_warning.send_anyway'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(updateSetting).toHaveBeenCalledWith('placeholderWarningEnabled', false);
  });

  it('goes back to editing with the placeholder selected', async () => {
    const onSend = vi.fn();
    render(
      <EmailComposer
        initialData={{ ...DRAFT_WITH_PLACEHOLDER, subject: 'Hi {{name}}', body: '<p>Hello</p>' }}
        onSend={onSend}
      />
    );

    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByText('placeholder_warning.back'));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const subject = screen.getByDisplayValue('Hi {{name}}') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(subject));
    expect([subject.selectionStart, subject.selectionEnd]).toEqual([3, 11]);
    expect(onSend).not.toHaveBeenCalled();
  });

  // Send anyway, then "Send this message?" answered with Cancel: the
  // placeholders were confirmed, the message is still here.
  const confirmThenCancel = async () => {
    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByText('placeholder_warning.send_anyway'));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('send_confirm.title');
    fireEvent.click(within(confirm).getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  };

  it('does not ask again after Send anyway and a cancelled send', async () => {
    useSettingsStore.setState({ sendConfirmation: true } as never);
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITH_PLACEHOLDER} onSend={onSend} />);
    await confirmThenCancel();

    fireEvent.click(sendButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('send_confirm.title');
    expect(screen.queryByText('placeholder_warning.title')).not.toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('asks again when a new placeholder shows up', async () => {
    useSettingsStore.setState({ sendConfirmation: true } as never);
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITH_PLACEHOLDER} onSend={onSend} />);
    await confirmThenCancel();

    fireEvent.change(screen.getByDisplayValue('Lunch'), { target: { value: 'Lunch with {{name}}' } });
    fireEvent.click(sendButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('placeholder_warning.title')).toBeInTheDocument();
    expect(within(dialog).getByText('{{name}}')).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  // compose-27: one question for everything the checks found.
  it('lists the placeholders and the missing attachment in one dialog', async () => {
    useSettingsStore.setState({ attachmentReminderEnabled: true, attachmentReminderKeywords: ['see you'] } as never);
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITH_PLACEHOLDER} onSend={onSend} />);

    fireEvent.click(sendButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('warnings_title');
    expect(dialog).toHaveTextContent('warning_placeholders');
    expect(dialog).toHaveTextContent('warning_attachment');
    expect(within(dialog).getByText('[TIME]')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByText('send_anyway'));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('ignores placeholders in quoted text and in the signature', async () => {
    const onSend = vi.fn();
    const body = '<p>Thanks!</p>'
      + '<div data-signature-block-node="">[COMPANY]</div>'
      + '<blockquote><p>Meet at [TIME]? TODO</p></blockquote>';
    render(<EmailComposer initialData={{ ...DRAFT_WITH_PLACEHOLDER, body }} onSend={onSend} />);

    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('placeholder_warning.title')).not.toBeInTheDocument();
  });

  it('uses the fill-in words of the UI language', async () => {
    ui.locale = 'de';
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT_WITH_PLACEHOLDER, body: '<p>Viele Grüße, [Ihr Name]</p>' }} onSend={onSend} />);

    fireEvent.click(sendButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('[Ihr Name]')).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps the English fill-in words in another UI language', async () => {
    ui.locale = 'de';
    const onSend = vi.fn();
    render(<EmailComposer initialData={{ ...DRAFT_WITH_PLACEHOLDER, body: '<p>Thanks, [Your Name]</p>' }} onSend={onSend} />);

    fireEvent.click(sendButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('[Your Name]')).toBeInTheDocument();
  });

  it('sends without asking when the warning is off', async () => {
    useSettingsStore.setState({ placeholderWarningEnabled: false } as never);
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT_WITH_PLACEHOLDER} onSend={onSend} />);

    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('placeholder_warning.title')).not.toBeInTheDocument();
  });
});
