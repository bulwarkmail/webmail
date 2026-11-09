import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';

// The real composer around the real editor: a template's data: image goes
// out as an inline cid: part, not as a data: URI (#1490).

// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const TEMPLATE = vi.hoisted(() => ({
  id: 'tpl-1',
  name: 'Offer',
  category: '',
  subject: 'Your offer',
  body: '<p>Your apartment</p><p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" alt="Floor plan"></p>',
  isHTML: true,
  isFavorite: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}));

vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
// The picker hands the composer a template, as choosing one does. It takes
// the focus away from the editor first, as the real dialog does.
vi.mock('@/components/templates/template-picker', () => ({
  TemplatePicker: ({ onSelect }: { onSelect: (t: unknown, v: Record<string, string>) => void }) =>
    React.createElement('button', { 'data-testid': 'pick-template', onClick: () => onSelect(TEMPLATE, {}) }, 'pick'),
}));
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
    identities: [{ id: 'id-me', email: 'me@example.com', name: 'Me', htmlSignature: '<p>Cheers, Me</p>' }],
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
    recipientMentionsEnabled: false,
    sendDelaySeconds: 0,
    signaturePosition: 'above_quote',
    signatureSeparatorEnabled: false,
    requestReadReceiptDefault: false,
    externalContentPolicy: 'block',
    isSenderTrusted: () => false,
    addTrustedSender: () => {},
    trustedSendersAddressBook: null,
    updateSetting: () => {},
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useSettingsStore: hook, registerTemplateSyncBridge: () => {} };
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

vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));

// ─── Tests ────────────────────────────────────────────────────────────────────

const DRAFT = {
  to: 'guest@example.com',
  cc: '',
  bcc: '',
  subject: '',
  body: '<p></p>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe('applying a template with a data: image (#1490)', () => {
  const range = Range.prototype as unknown as Record<string, unknown>;
  const doc = document as unknown as Record<string, unknown>;
  const client = {
    uploadBlob: vi.fn(async (_file: File) => ({ blobId: 'blob-plan' })),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
  };
  beforeAll(() => {
    range.getClientRects = () => [];
    range.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 });
    doc.elementFromPoint = () => null;
    useAuthStore.setState({ client: client as never });
  });
  afterAll(() => {
    delete range.getClientRects;
    delete range.getBoundingClientRect;
    delete doc.elementFromPoint;
    useAuthStore.setState({ client: null });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uploads the image and sends it as an inline part shown by cid', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={DRAFT} onSend={onSend} onClose={() => {}} />);
    await waitFor(() => {
      const el = document.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
      expect(el?.editor).toBeTruthy();
    });
    await nextFrame();

    act(() => { fireEvent.keyDown(window, { key: 't' }); });
    fireEvent.click(await screen.findByTestId('pick-template'));
    await waitFor(() => expect(screen.queryByTestId('pick-template')).toBeNull());
    await waitFor(() => expect(document.querySelector('.ProseMirror img')).not.toBeNull());

    expect(client.uploadBlob).toHaveBeenCalledTimes(1);
    const file = client.uploadBlob.mock.calls[0][0];
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0)));

    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const { htmlBody, attachments } = onSend.mock.calls[0][0];
    const inline = attachments?.find((a: { disposition?: string }) => a.disposition === 'inline');
    expect(inline).toMatchObject({ blobId: 'blob-plan', type: 'image/png' });
    expect(htmlBody).toContain(`src="cid:${inline.cid}"`);
    expect(htmlBody).not.toContain('data:image');
  });
});
