import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';
import { useIdentityStore } from '@/stores/identity-store';
import type { Identity } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';

// ─── Heavy component mocks (as composer-reply-signature.test.tsx) ─

// A stand-in for the TipTap editor: it hands the composer an editor object
// whose content is whatever the composer last rendered into it, the way the
// real editor reports itself ready from an effect after mounting.
const editorState = vi.hoisted(() => ({ html: '' }));
vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: ({ content, onChange, onEditorReady }: {
    content: string;
    onChange: (html: string) => void;
    onEditorReady?: (editor: unknown) => void;
  }) => {
    editorState.html = content;
    const onChangeRef = React.useRef(onChange);
    onChangeRef.current = onChange;
    React.useEffect(() => {
      onEditorReady?.({
        isDestroyed: false,
        commands: {
          focus: () => {},
          setContent: (html: string) => {
            editorState.html = html;
            onChangeRef.current(html);
          },
        },
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement('div', { 'data-testid': 'rich-text-editor', 'data-html': content });
  },
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
      { id: 'id-team', email: 'team@example.com', name: 'Team', htmlSignature: '', textSignature: '' },
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
    signatureNewMailEnabled: true,
    signatureReplyForwardEnabled: true,
    signatureSeparatorEnabled: true,
    requestReadReceiptDefault: false,
    addTrustedSender: () => {},
    externalContentPolicy: 'block',
    isSenderTrusted: () => false,
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
  buildQuotedHtmlBlock: (html: string) => `<div data-quoted-html="">${html}</div>`,
  serializeEditorContent: () => editorState.html,
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

/**
 * A Reply or Forward opened and closed again, with nothing typed or changed,
 * leaves no draft: the quote and the signature it starts with are no edit,
 * nor is a signature that follows the identity the reply resolves to later.
 */

const ME = { id: 'id-me', email: 'me@example.com', name: 'Me', htmlSignature: '<b>Alice</b>', textSignature: 'Alice' };
const SALES = { id: 'id-sales', email: 'sales@example.com', name: 'Sales', htmlSignature: '<i>Sales team</i>', textSignature: 'Sales team' };
const REPLY_TO = {
  from: [{ name: 'Bob', email: 'bob@example.com' }],
  to: [{ email: 'sales@example.com' }],
  subject: 'Question',
  body: 'Original text',
  htmlBody: '<p>Original text</p>',
  receivedAt: '2026-08-01T10:00:00Z',
};

function savingClient() {
  const createDraft = vi.fn().mockResolvedValue('draft-9');
  useAuthStore.setState({
    client: { createDraft, getEmail: vi.fn(), hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never,
  });
  return createDraft;
}

function renderReply(mode: 'reply' | 'replyAll' | 'forward') {
  const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
  const onClose = vi.fn();
  render(<EmailComposer mode={mode} replyTo={REPLY_TO} requestCloseRef={requestCloseRef} onClose={onClose} />);
  return { requestCloseRef, onClose };
}

const pastAutosave = () => act(async () => { await new Promise((r) => setTimeout(r, 2600)); });

describe('an untouched reply or forward', () => {
  afterEach(() => {
    useAuthStore.setState({ client: null });
    useSettingsStore.setState({ signaturePosition: 'below_quote' });
    useIdentityStore.setState({ identities: [ME] as Identity[] });
  });

  for (const mode of ['reply', 'replyAll', 'forward'] as const) {
    it(`saves nothing, also not by autosave, and closes without asking (${mode})`, async () => {
      const createDraft = savingClient();
      const { requestCloseRef, onClose } = renderReply(mode);

      await pastAutosave();
      expect(createDraft).not.toHaveBeenCalled();

      act(() => requestCloseRef.current!());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(createDraft).not.toHaveBeenCalled();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  }

  // The host builds the quote header after the composer opened (a plugin
  // may rewrite it), so the body changes once by itself.
  it('stays untouched when the quote header arrives after it opened', async () => {
    const createDraft = savingClient();
    const requestCloseRef = { current: null } as React.MutableRefObject<((afterClose?: () => void) => void) | null>;
    const onClose = vi.fn();
    const props = { mode: 'reply' as const, requestCloseRef, onClose };
    const view = render(<EmailComposer {...props} replyTo={REPLY_TO} />);
    view.rerender(<EmailComposer {...props} replyTo={{ ...REPLY_TO, quoteHeaderHtml: '<p>Bob wrote:</p>', quoteHeaderText: 'Bob wrote:' }} />);

    await pastAutosave();
    expect(createDraft).not.toHaveBeenCalled();
    act(() => requestCloseRef.current!());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('stays untouched when its signature follows the identity it resolves to', async () => {
    useSettingsStore.setState({ signaturePosition: 'above_quote' });
    useIdentityStore.setState({ identities: [ME, SALES] as Identity[] });
    const createDraft = savingClient();
    const { requestCloseRef, onClose } = renderReply('reply');

    await pastAutosave();
    act(() => requestCloseRef.current!());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('saves once the user changes something', async () => {
    const createDraft = savingClient();
    const { requestCloseRef, onClose } = renderReply('reply');
    fireEvent.change(screen.getByDisplayValue(/Question/), { target: { value: 'Question, answered' } });

    act(() => requestCloseRef.current!());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(createDraft).toHaveBeenCalledTimes(1);
  });
});
