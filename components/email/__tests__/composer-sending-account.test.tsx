import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';

// #1666: with several accounts the From row names the account the message
// leaves from, and a reply from another account than the one the original
// came to asks before it goes out.

// Show the values next to the key, so the names in a text can be checked.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join(' ')}` : key,
  useLocale: () => 'en',
  useFormatter: () => ({
    dateTime: (d: Date | string) => String(d),
    relativeTime: (d: Date | string) => String(d),
    number: (n: number) => String(n),
  }),
}));

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

const HOME_ME = { id: 'login-home::id-me', email: 'me@home.example', name: 'Jo' };
const WORK_ME = { id: 'login-work::id-me', email: 'jo@work.example', name: 'Jo' };

const proIdentities = vi.hoisted(() => ({
  enabled: false,
  groups: [] as unknown[],
  allIdentities: [] as { id: string; email: string; name: string }[],
}));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => proIdentities,
  cachedIdentitiesForAccount: () => undefined,
  cachedRemoteIdentities: () => [],
  stripCrossAccountIdentityPrefix: (id: string) => {
    const at = id.indexOf('::');
    return at === -1
      ? { localAccountId: null, rawId: id }
      : { localAccountId: id.slice(0, at), rawId: id.slice(at + 2) };
  },
}));

vi.mock('@/stores/auth-store', () => {
  const login = { hasDelayedSend: () => false, getMaxDelayedSend: () => 0 };
  const state = {
    client: null,
    identities: [],
    primaryIdentity: null,
    isAuthenticated: false,
    isDemoMode: false,
    activeAccountId: null as string | null,
    connectionLost: false,
    getClientForAccount: (id: string) => (id.startsWith('login-') ? login : undefined),
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
    identities: [{ id: 'id-me', email: 'me@home.example', name: 'Jo' }],
    defaultIdentityId: 'id-me',
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useIdentityStore: hook, notifyIdentitySelected: () => {} };
});

vi.mock('@/stores/account-store', () => {
  const state = {
    accounts: [] as Array<Record<string, unknown>>,
    getAccountById: (id: string) => state.accounts.find((a) => a.id === id),
  };
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
    autoSelectReplyIdentity: false,
    replyIdentityMatch: 'exact',
    attachmentReminderEnabled: false,
    attachmentReminderKeywords: [],
    emptySubjectWarningEnabled: true,
    sendDelaySeconds: 0,
    signaturePosition: 'above_quote',
    signatureSeparatorEnabled: false,
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

// One person on two mailboxes, both called "Jo".
const HOME = { id: 'login-home', label: 'Jo', displayName: 'Jo', email: 'me@home.example', username: 'me@home.example', avatarColor: '#2563eb', isConnected: true };
const WORK = { id: 'login-work', label: 'Jo', displayName: 'Jo', email: 'jo@work.example', username: 'jo@work.example', avatarColor: '#ea580c', isConnected: true };

/** The original came to the work account. */
const FROM_WORK = {
  from: [{ email: 'bob@client.example', name: 'Bob' }],
  to: [{ email: 'jo@work.example' }],
  subject: 'Offer',
  accountId: 'login-work',
};

const draft = (identityId: string, mode: 'reply' | 'forward' = 'reply') => ({
  to: 'bob@client.example',
  cc: '',
  bcc: '',
  subject: mode === 'reply' ? 'Re: Offer' : 'Fwd: Offer',
  body: '<p>Sounds good.</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: identityId,
  subAddressTag: '',
  mode,
  draftId: null,
});

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;
const accountChip = () => document.querySelector('[data-composer-from-account]') as HTMLElement | null;

describe('sending account in the composer', () => {
  const accountStore = useAccountStore as unknown as { setState: (p: Record<string, unknown>) => void };
  const authStore = useAuthStore as unknown as { setState: (p: Record<string, unknown>) => void };

  beforeEach(() => {
    proIdentities.enabled = true;
    proIdentities.allIdentities = [HOME_ME, WORK_ME];
    authStore.setState({ activeAccountId: 'login-home' });
    accountStore.setState({ accounts: [HOME, WORK] });
  });

  afterEach(() => {
    proIdentities.enabled = false;
    proIdentities.allIdentities = [];
    authStore.setState({ activeAccountId: null });
    accountStore.setState({ accounts: [] });
  });

  it('names the account the message leaves from, in its colour', () => {
    render(<EmailComposer mode="reply" replyTo={FROM_WORK} initialData={draft(WORK_ME.id)} />);
    const chip = accountChip()!;
    expect(chip).not.toBeNull();
    expect(chip.getAttribute('data-composer-from-account')).toBe('login-work');
    // Both accounts are called "Jo", so the address tells them apart.
    expect(chip).toHaveTextContent('jo@work.example');
    expect((chip.firstElementChild as HTMLElement).style.backgroundColor).toBe('rgb(234, 88, 12)');
  });

  it('follows the From when an address of another account is picked', () => {
    render(<EmailComposer mode="reply" replyTo={FROM_WORK} initialData={draft(WORK_ME.id)} />);
    fireEvent.change(screen.getByTestId('composer-from'), { target: { value: HOME_ME.id } });
    expect(accountChip()!.getAttribute('data-composer-from-account')).toBe('login-home');
    expect(accountChip()).toHaveTextContent('me@home.example');
  });

  it('shows no account with a single account', () => {
    proIdentities.enabled = false;
    accountStore.setState({ accounts: [HOME] });
    render(<EmailComposer mode="reply" replyTo={FROM_WORK} initialData={draft('id-me')} />);
    expect(accountChip()).toBeNull();
  });

  it('asks before a reply leaves from another account than the one the original came to', async () => {
    const onSend = vi.fn();
    render(<EmailComposer mode="reply" replyTo={FROM_WORK} initialData={draft(HOME_ME.id)} onSend={onSend} />);

    fireEvent.click(sendButton());

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('account_warning_title');
    expect(dialog).toHaveTextContent('received=jo@work.example');
    expect(dialog).toHaveTextContent('sending=me@home.example');
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByText('send_anyway'));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('goes back to the From field to change the sender', async () => {
    const onSend = vi.fn();
    render(<EmailComposer mode="reply" replyTo={FROM_WORK} initialData={draft(HOME_ME.id)} onSend={onSend} />);

    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByText('account_warning_back'));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('composer-from')));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends a reply from the account the original came to without asking', async () => {
    // Opened in the work account, which the original came to.
    authStore.setState({ activeAccountId: 'login-work' });
    const onSend = vi.fn();
    render(<EmailComposer mode="reply" replyTo={FROM_WORK} initialData={draft(WORK_ME.id)} onSend={onSend} />);

    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not ask on a forward from another account', async () => {
    const onSend = vi.fn();
    render(<EmailComposer mode="forward" replyTo={FROM_WORK} initialData={draft(HOME_ME.id, 'forward')} onSend={onSend} />);

    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
