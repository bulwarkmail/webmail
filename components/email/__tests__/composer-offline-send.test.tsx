import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// Writing offline. The footer says "Offline" next to Send. With "Keep mail on
// this device" on, Send puts the message in the outbox as before. Without it
// nothing can keep the message safely for later: Send says so, keeps the
// text, and points at the setting. It used to fail with "Failed to send".

const offline = vi.hoisted(() => ({ active: false, allowed: true }));
vi.mock('@/lib/offline/offline-mode', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  offlineActive: () => offline.active,
  offlineAllowed: () => offline.allowed,
}));

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ collapseToolbarOnMobile }: { collapseToolbarOnMobile?: boolean }) =>
    React.createElement('div', { 'data-testid': 'rich-text-editor', 'data-collapsed': String(!!collapseToolbarOnMobile) }),
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
  toast: { info: () => {}, error: () => {}, success: () => {}, warning: () => {} },
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

const DATA = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Lunch',
  body: '<p>Hello there</p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

let online = true;
beforeEach(() => {
  online = true;
  offline.active = false;
  offline.allowed = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
});
afterEach(() => {
  online = true;
});

function goOffline() {
  online = false;
  act(() => { window.dispatchEvent(new Event('offline')); });
}
function goOnline() {
  online = true;
  act(() => { window.dispatchEvent(new Event('online')); });
}

const footer = () => document.querySelector<HTMLElement>('[data-composer-footer]')!;

describe('the composer while offline', () => {
  it('says "Offline" next to Send, and stops once the network is back', () => {
    render(<EmailComposer initialData={DATA} ownWindow={{}} />);
    expect(screen.queryByTestId('composer-offline')).toBeNull();
    goOffline();
    const label = screen.getByTestId('composer-offline');
    expect(footer()).toContainElement(label);
    expect(label.textContent).toContain('offline');
    expect(label.textContent).toContain('offline_hint');
    goOnline();
    expect(screen.queryByTestId('composer-offline')).toBeNull();
  });

  it('without offline mode, Send keeps the message and says why, with the way to the setting', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DATA} ownWindow={{}} onSend={onSend} />);
    goOffline();
    fireEvent.click(screen.getByTestId('composer-send'));
    const notice = await screen.findByTestId('composer-offline-notice');
    expect(notice.textContent).toContain('offline_send_unsaved');
    const link = screen.getByRole('link', { name: 'settings.keep_label' });
    expect(link.getAttribute('href')).toMatch(/\/settings\/backup\/offline$/);
    expect(link).toHaveAttribute('target', '_blank');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('email-composer')).toBeInTheDocument();

    goOnline();
    expect(screen.queryByTestId('composer-offline-notice')).toBeNull();
  });

  it('says the message is in Drafts only when the server has it', async () => {
    render(<EmailComposer initialData={{ ...DATA, draftId: 'd1' }} ownWindow={{}} onSend={vi.fn()} />);
    goOffline();
    fireEvent.click(screen.getByTestId('composer-send'));
    expect((await screen.findByTestId('composer-offline-notice')).textContent).toContain('offline_send_saved');
  });

  it('Ctrl+Enter takes the same way', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DATA} ownWindow={{}} onSend={onSend} />);
    goOffline();
    fireEvent.keyDown(screen.getByTestId('composer-send'), { key: 'Enter', ctrlKey: true });
    await screen.findByTestId('composer-offline-notice');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('leaves out the link where this device may not keep mail', async () => {
    offline.allowed = false;
    render(<EmailComposer initialData={DATA} ownWindow={{}} onSend={vi.fn()} />);
    goOffline();
    fireEvent.click(screen.getByTestId('composer-send'));
    await screen.findByTestId('composer-offline-notice');
    expect(screen.queryByRole('link', { name: 'settings.keep_label' })).toBeNull();
  });

  it('with offline mode on, Send goes ahead: the outbox keeps it until the network is back', async () => {
    offline.active = true;
    const onSend = vi.fn();
    render(<EmailComposer initialData={DATA} ownWindow={{}} onSend={onSend} />);
    goOffline();
    expect(screen.getByTestId('composer-offline').textContent).toContain('offline_hint_outbox');
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(screen.queryByTestId('composer-offline-notice')).toBeNull();
  });
});
