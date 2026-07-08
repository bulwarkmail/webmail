import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// ─── Heavy component mocks (mirrors recipient-chip-drag.test.tsx) ──────────────

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ onChange }: { onChange?: (html: string) => void }) => (
    React.createElement('div', { 'data-testid': 'rich-text-editor', onClick: () => onChange?.('') })
  ),
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
  const state = { identities: [], defaultIdentityId: null };
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

vi.mock('@/lib/reply-identity', () => ({ resolveReplyFrom: () => null }));
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

// ─── Shared test data ─────────────────────────────────────────────────────────

const EMPTY_DATA = {
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  body: '',
  showCc: true,
  showBcc: true,
  selectedIdentityId: null,
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

/** next-intl is mocked to return the key, so the To placeholder is "to_placeholder". */
const toInput = () => screen.getByPlaceholderText('to_placeholder') as HTMLInputElement;
const ccInput = () => screen.getByPlaceholderText('cc_placeholder') as HTMLInputElement;

const paste = (input: HTMLElement, text: string) =>
  fireEvent.paste(input, { clipboardData: { getData: () => text } });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RecipientChipInput paste', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('splits a pasted list (comma / semicolon / whitespace) into one chip per address', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    const input = toInput(); // capture once — placeholder disappears once chips exist
    paste(input, 'a@x.com b@y.com; c@z.com');

    expect(screen.getByText('a@x.com')).toBeInTheDocument();
    expect(screen.getByText('b@y.com')).toBeInTheDocument();
    expect(screen.getByText('c@z.com')).toBeInTheDocument();
    // all consumed → input cleared
    expect(input.value).toBe('');
  });

  it('chips the valid addresses and leaves invalid text in the input', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    const input = toInput();
    paste(input, 'foo bar a@x.com');

    expect(screen.getByText('a@x.com')).toBeInTheDocument();
    expect(input.value).toBe('foo bar');
  });

  it('does not pre-empt a single-address paste (no delimiter → normal editing)', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    paste(toInput(), 'single@x.com');

    // The handler bailed out, so no chip was created from the single token.
    expect(screen.queryByText('single@x.com')).not.toBeInTheDocument();
  });

  it('keeps display names from a fully-quoted "Name <email>" list', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    const input = toInput();
    paste(input, '"Alice Smith <alice@x.com>", "Alex Smith <alex@x.com>"');

    // Chips render as "Name (email)" when a display name is present.
    expect(screen.getByText('Alice Smith (alice@x.com)')).toBeInTheDocument();
    expect(screen.getByText('Alex Smith (alex@x.com)')).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('keeps a `Name <email>` pair as a single named chip', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    const input = toInput();
    paste(input, 'John Doe <j@x.com>, jane@y.com');

    expect(screen.getByText('John Doe (j@x.com)')).toBeInTheDocument();
    expect(screen.getByText('jane@y.com')).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('keeps a comma inside a quoted display name intact', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    const input = toInput();
    paste(input, '"Doe, John" <j@x.com>; bob@z.com');

    expect(screen.getByText('Doe, John (j@x.com)')).toBeInTheDocument();
    expect(screen.getByText('bob@z.com')).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('splits a newline-separated block (e.g. a spreadsheet column)', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    const input = toInput();
    paste(input, 'a@x.com\nb@y.com\nc@z.com');

    expect(screen.getByText('a@x.com')).toBeInTheDocument();
    expect(screen.getByText('b@y.com')).toBeInTheDocument();
    expect(screen.getByText('c@z.com')).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('dedupes case-insensitively within the paste and against existing chips', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    const input = toInput(); // DOM node persists across pastes (placeholder just clears)
    paste(input, 'a@x.com, A@X.com, b@y.com'); // within-paste dup collapses
    paste(input, 'A@X.COM, c@z.com'); // dup of an existing chip is dropped

    expect(screen.getByText('b@y.com')).toBeInTheDocument();
    expect(screen.getByText('c@z.com')).toBeInTheDocument();
    // a@x.com appears exactly once despite three case variants across two pastes.
    expect(screen.getAllByText('a@x.com')).toHaveLength(1);
    expect(screen.queryByText('A@X.COM')).not.toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('chips the valid (named) entries and leaves a non-address token behind', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    const input = toInput();
    paste(input, '"VIP" <vip@x.com>, not-an-email, b@y.com');

    expect(screen.getByText('VIP (vip@x.com)')).toBeInTheDocument();
    expect(screen.getByText('b@y.com')).toBeInTheDocument();
    expect(input.value).toBe('not-an-email');
  });

  it('works on the Cc field (shared handler)', () => {
    render(<EmailComposer initialData={EMPTY_DATA} />);
    paste(ccInput(), 'x@a.com; y@b.com');

    expect(screen.getByText('x@a.com')).toBeInTheDocument();
    expect(screen.getByText('y@b.com')).toBeInTheDocument();
  });
});
