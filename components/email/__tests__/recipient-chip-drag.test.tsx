import { render, screen, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// ─── Heavy component mocks ────────────────────────────────────────────────────

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
// vi.mock factories are hoisted, so all values must be defined inline.

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

vi.mock('@/stores/smime-store', () => {
  const state = {
    certs: [],
    signingEnabled: false,
    encryptionEnabled: false,
    defaultSigningCertId: null,
    defaultEncryptionCertId: null,
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useSmimeStore: hook };
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
vi.mock('@/lib/smime/smime-sign', () => ({ smimeSign: async () => null }));
vi.mock('@/lib/smime/smime-encrypt', () => ({ smimeEncrypt: async () => null }));
vi.mock('@/lib/smime/mime-builder', () => ({
  buildMimeMessage: () => null,
  wrapCmsAsSmimeMessage: () => null,
}));
vi.mock('@/lib/debug', () => ({ debug: () => {} }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── DataTransfer polyfill ────────────────────────────────────────────────────

/** jsdom's built-in DataTransfer doesn't fully support setData/getData in synthetic drag events. */
class MockDataTransfer {
  private _data: Record<string, string> = {};
  types: string[] = [];
  effectAllowed = '';
  dropEffect = '';

  setData(type: string, data: string) {
    this._data[type] = data;
    if (!this.types.includes(type)) this.types.push(type);
  }

  getData(type: string): string {
    return this._data[type] ?? '';
  }
}

// ─── Shared test data ─────────────────────────────────────────────────────────

const BASE_DATA = {
  to: 'alice@example.com, ',
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RecipientChipInput drag and drop', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders recipient chips with draggable="true"', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);

    const chipText = await screen.findByText('alice@example.com');
    const chipSpan = chipText.closest('[draggable]');
    expect(chipSpan).not.toBeNull();
    expect(chipSpan).toHaveAttribute('draggable', 'true');
  });

  it('onDragStart encodes chip value and source field into dataTransfer', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);

    const chipText = await screen.findByText('alice@example.com');
    const chipSpan = chipText.closest('[draggable]') as HTMLElement;

    const dt = new MockDataTransfer();
    fireEvent.dragStart(chipSpan, { dataTransfer: dt });

    const payload = JSON.parse(dt.getData('application/x-recipient-chip'));
    expect(payload).toEqual({ chip: 'alice@example.com', fromField: 'to' });
  });

  it('onDragEnd clears the opacity class on the chip', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);

    const chipText = await screen.findByText('alice@example.com');
    const chipSpan = chipText.closest('[draggable]') as HTMLElement;

    fireEvent.dragStart(chipSpan, { dataTransfer: new MockDataTransfer() });
    expect(chipSpan.className).toContain('opacity-50');

    fireEvent.dragEnd(chipSpan);
    expect(chipSpan.className).not.toContain('opacity-50');
  });

  it('dragOver on a different field container adds ring indicator; dragLeave removes it', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);

    await screen.findByText('alice@example.com');

    // The flex-wrap containers are the actual drop zones
    const allContainers = Array.from(document.querySelectorAll('[class*="flex-wrap"]'));
    // To-container has the draggable chip; cc-container doesn't
    const toContainer = allContainers.find(el => el.querySelector('[draggable]')) as HTMLElement;
    const ccContainer = allContainers.find(el => el !== toContainer) as HTMLElement;

    if (!ccContainer) return;

    const dt = new MockDataTransfer();
    dt.setData('application/x-recipient-chip', JSON.stringify({ chip: 'alice@example.com', fromField: 'to' }));

    fireEvent.dragOver(ccContainer, { dataTransfer: dt });
    expect(ccContainer.className).toContain('ring-primary');

    fireEvent.dragLeave(ccContainer, { relatedTarget: null });
    expect(ccContainer.className).not.toContain('ring-primary');
  });

  it('drop on a different field container moves the chip', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);
    await screen.findByText('alice@example.com');

    const allContainers = Array.from(document.querySelectorAll('[class*="flex-wrap"]'));
    const toContainer = allContainers.find(el => el.querySelector('[draggable]')) as HTMLElement;
    const ccContainer = allContainers.find(el => el !== toContainer) as HTMLElement;

    if (!toContainer || !ccContainer) return;

    const dt = new MockDataTransfer();
    dt.setData('application/x-recipient-chip', JSON.stringify({ chip: 'alice@example.com', fromField: 'to' }));
    fireEvent.dragOver(ccContainer, { dataTransfer: dt });
    act(() => {
      fireEvent.drop(ccContainer, { dataTransfer: dt });
    });

    // Chip should still appear exactly once (moved, not duplicated or lost)
    await screen.findByText('alice@example.com');
    expect(screen.getAllByText('alice@example.com')).toHaveLength(1);

    // The To container must now be empty
    expect(toContainer.querySelectorAll('[draggable]')).toHaveLength(0);
  });

  it('drop on the same field container is a no-op', async () => {
    render(<EmailComposer initialData={BASE_DATA} />);
    await screen.findByText('alice@example.com');

    const allContainers = Array.from(document.querySelectorAll('[class*="flex-wrap"]'));
    const toContainer = allContainers.find(el => el.querySelector('[draggable]')) as HTMLElement;

    const dt = new MockDataTransfer();
    dt.setData('application/x-recipient-chip', JSON.stringify({ chip: 'alice@example.com', fromField: 'to' }));
    fireEvent.dragOver(toContainer, { dataTransfer: dt });
    act(() => {
      fireEvent.drop(toContainer, { dataTransfer: dt });
    });

    // Chip stays present exactly once
    expect(screen.getAllByText('alice@example.com')).toHaveLength(1);
  });

  it('dropping a chip onto the hidden Cc button shows the CC field', async () => {
    render(<EmailComposer initialData={{ ...BASE_DATA, showCc: false, showBcc: false }} />);
    await screen.findByText('alice@example.com');

    const ccButton = screen.getByRole('button', { name: 'Cc' });

    const dt = new MockDataTransfer();
    dt.setData('application/x-recipient-chip', JSON.stringify({ chip: 'alice@example.com', fromField: 'to' }));
    fireEvent.dragOver(ccButton, { dataTransfer: dt });
    act(() => {
      fireEvent.drop(ccButton, { dataTransfer: dt });
    });

    // cc_label is rendered by the mock translation as its key string
    const ccLabel = await screen.findByText('cc_label');
    expect(ccLabel).toBeInTheDocument();
  });
});
