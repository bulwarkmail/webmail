import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';
import { useTemplateStore } from '@/stores/template-store';

// The real composer around the real editor: applying a template to a reply
// the user has already started (#911, follow-up to #540).

const TEMPLATE = vi.hoisted(() => ({
  id: 'tpl-1',
  name: 'Greeting',
  category: '',
  subject: '',
  body: 'Dear reader',
  isHTML: false,
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
// Save as template: what the composer hands the form.
const savedForm = vi.hoisted(() => ({ initialData: null as null | { name?: string; body?: string; isHTML?: boolean } }));
vi.mock('@/components/templates/template-form', () => ({
  TemplateForm: (props: { initialData?: { name?: string; body?: string; isHTML?: boolean } }) => {
    savedForm.initialData = props.initialData ?? null;
    return null;
  },
}));
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
    signatureNewMailEnabled: true,
    signatureReplyForwardEnabled: true,
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

const toastSuccess = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: () => {}, success: (...args: unknown[]) => { toastSuccess.calls.push(args); } },
}));

vi.mock('@/lib/plugin-hooks', () => ({
  identityHooks: {
    onSignatureRender: { size: 0, transform: async (value: unknown) => value },
    onIdentitySelect: { size: 0, emit: async () => {} },
  },
  templateHooks: {
    onTemplateRender: { size: 0, transform: async (value: unknown) => value },
    onTemplateApply: { size: 0, emit: async () => {} },
    onTemplateCreate: { size: 0, emit: async () => {} },
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

const REPLY_TO = {
  from: [{ email: 'bob@example.com', name: 'Bob' }],
  to: [{ email: 'me@example.com', name: 'Me' }],
  subject: 'Lunch',
  htmlBody: '<p>Original message</p>',
  receivedAt: '2026-01-01T10:00:00.000Z',
};

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

async function openReply() {
  render(<EmailComposer mode="reply" replyTo={REPLY_TO} />);
  const dom = await waitFor(() => {
    const el = document.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
    expect(el?.editor).toBeTruthy();
    return el!;
  });
  await nextFrame();
  return dom.editor!;
}

async function applyTemplate() {
  act(() => { fireEvent.keyDown(window, { key: 't' }); });
  const pick = await screen.findByTestId('pick-template');
  // The picker dialog takes the focus.
  act(() => { pick.focus(); });
  fireEvent.click(pick);
  await waitFor(() => expect(screen.queryByTestId('pick-template')).toBeNull());
  await nextFrame();
}

/** Top-level blocks as text, so the order of greeting, template, signature and quote shows. */
const blocks = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'quotedHtml') out.push(`[quote:${new DOMParser().parseFromString(node.attrs.html as string, 'text/html').body.textContent}]`);
    else if (node.type.name === 'signatureBlock') out.push('[signature]');
    else if (node.textContent) out.push(node.textContent);
  });
  return out;
};

describe('applying a template to a reply (#911)', () => {
  const range = Range.prototype as unknown as Record<string, unknown>;
  const doc = document as unknown as Record<string, unknown>;
  beforeAll(() => {
    range.getClientRects = () => [];
    range.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 });
    doc.elementFromPoint = () => null;
  });
  afterAll(() => {
    delete range.getClientRects;
    delete range.getBoundingClientRect;
    delete doc.elementFromPoint;
  });
  afterEach(() => {
    useSettingsStore.setState({ signaturePosition: 'above_quote', plainTextMode: false });
  });

  // The user starts typing right away, at the caret the reply opened with.
  it('keeps the greeting and puts the template after it, above the signature and the quote', async () => {
    const editor = await openReply();
    act(() => { editor.view.dispatch(editor.state.tr.insertText('Hello Mr. X')); });

    await applyTemplate();

    expect(blocks(editor)).toEqual(['Hello Mr. X', 'Dear reader', '[signature]', 'reply_line', '[quote:Original message]']);
  });

  it('does the same when the signature goes below the quote', async () => {
    useSettingsStore.setState({ signaturePosition: 'below_quote' });
    const editor = await openReply();
    act(() => { editor.view.dispatch(editor.state.tr.insertText('Hello Mr. X')); });

    await applyTemplate();

    expect(blocks(editor)).toEqual(['Hello Mr. X', 'Dear reader', 'reply_line', '[quote:Original message]']);
  });

  it('keeps the greeting in a plain text reply', async () => {
    useSettingsStore.setState({ plainTextMode: true });
    render(<EmailComposer mode="reply" replyTo={REPLY_TO} />);
    const textarea = await waitFor(() => {
      const el = document.querySelector('textarea');
      expect(el).toBeTruthy();
      expect(document.activeElement).toBe(el);
      return el as HTMLTextAreaElement;
    });
    const caret = textarea.selectionStart;
    fireEvent.change(textarea, {
      target: { value: textarea.value.slice(0, caret) + 'Hello Mr. X' + textarea.value.slice(caret) },
    });
    textarea.setSelectionRange(caret + 11, caret + 11);

    await applyTemplate();

    expect(textarea.value).toBe('Hello Mr. XDear reader\n\nCheers, Me\n\nreply_line\n> Original message');
  });

  // An HTML template goes into a plain text draft as its text (#1506).
  it('puts an HTML template into a plain text reply as text, not markup', async () => {
    useSettingsStore.setState({ plainTextMode: true });
    Object.assign(TEMPLATE, { body: '<p>Dear <strong>reader</strong></p>', isHTML: true });
    try {
      render(<EmailComposer mode="reply" replyTo={REPLY_TO} />);
      const textarea = await waitFor(() => {
        const el = document.querySelector('textarea');
        expect(el).toBeTruthy();
        return el as HTMLTextAreaElement;
      });

      await applyTemplate();

      expect(textarea.value).toContain('Dear reader');
      expect(textarea.value).not.toContain('<');
    } finally {
      Object.assign(TEMPLATE, { body: 'Dear reader', isHTML: false });
    }
  });

  describe('saving the draft as a template (#1506)', () => {
    afterEach(() => {
      savedForm.initialData = null;
    });

    async function openNameDialog() {
      fireEvent.click(await screen.findByTestId('composer-templates-menu'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'save_as_template' }));
      return screen.findByTestId('quick-save-template');
    }

    // The full editor is behind "Edit details…" (compose-18).
    async function openSaveAsTemplate() {
      fireEvent.click(within(await openNameDialog()).getByText('template_edit_details'));
      await waitFor(() => expect(savedForm.initialData).not.toBeNull());
      return savedForm.initialData!;
    }

    // compose-18: Save as template opened an editor with nine fields.
    it('asks for a name only, starting from the subject, and saves the message', async () => {
      useTemplateStore.setState({ templates: [] });
      await openReply();
      const subject = (screen.getByTestId('composer-subject') as HTMLInputElement).value;
      const dialog = await openNameDialog();
      const name = within(dialog).getByLabelText('template_name') as HTMLInputElement;
      expect(name.value).toBe(subject);
      expect(savedForm.initialData).toBeNull();

      fireEvent.change(name, { target: { value: 'Quick answer' } });
      fireEvent.click(within(dialog).getByText('save'));

      await waitFor(() => expect(useTemplateStore.getState().templates).toHaveLength(1));
      expect(useTemplateStore.getState().templates[0]).toMatchObject({ name: 'Quick answer', subject, isHTML: true });
      expect(screen.queryByTestId('quick-save-template')).not.toBeInTheDocument();
    });

    // compose-p2-15: the dialog closed with no sign the template was kept.
    it('says "Template saved"', async () => {
      useTemplateStore.setState({ templates: [] });
      toastSuccess.calls = [];
      await openReply();
      const dialog = await openNameDialog();
      fireEvent.change(within(dialog).getByLabelText('template_name'), { target: { value: 'Quick answer' } });
      fireEvent.click(within(dialog).getByText('save'));
      await waitFor(() => expect(toastSuccess.calls).toContainEqual(['template_saved']));
    });

    it('carries the name over into the full editor', async () => {
      await openReply();
      const dialog = await openNameDialog();
      fireEvent.change(within(dialog).getByLabelText('template_name'), { target: { value: 'Quick answer' } });
      fireEvent.click(within(dialog).getByText('template_edit_details'));

      await waitFor(() => expect(savedForm.initialData).toMatchObject({ name: 'Quick answer' }));
    });

    it('marks a rich text draft as HTML', async () => {
      await openReply();
      const data = await openSaveAsTemplate();
      expect(data.body).toContain('<');
      expect(data.isHTML).toBe(true);
    });

    it('leaves a plain text draft as plain text', async () => {
      useSettingsStore.setState({ plainTextMode: true });
      render(<EmailComposer mode="reply" replyTo={REPLY_TO} />);
      await waitFor(() => expect(document.querySelector('textarea')).toBeTruthy());
      const data = await openSaveAsTemplate();
      expect(data.isHTML).toBe(false);
    });
  });
});
