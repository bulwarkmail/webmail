import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { EmailComposer, type ComposerDraftData } from '../email-composer';
import { buildSignatureBlock } from '../signature-block';
import { buildQuotedHtmlBlock, serializeEditorContent } from '../quoted-html';
import { composerHandle } from '@/lib/plugin-sandbox/composer-registry';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';
import { useAuthStore } from '@/stores/auth-store';

// The real composer around the real editor, worked on by a plugin through
// the handle it registers for api.composer: what the plugin reads as the
// message, and that each change is one step in the editor's history that
// leaves the signature, the quoted reply and inline images alone.

vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));

// ─── Composer dependency mocks (as in composer-close-guard.test.tsx) ──────────

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
    recipientMentionsEnabled: true,
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
    onBeforeAttachmentUpload: { intercept: async () => true },
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

vi.mock('@/lib/email-sanitization', async (orig) => ({
  ...(await orig<typeof import('@/lib/email-sanitization')>()),
  sanitizeSignatureHtml: (v: string) => v,
  sanitizePluginBodyHtml: (v: string) => v,
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
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

const SIGNATURE = buildSignatureBlock('<p>Alice Example<br>ACME Ltd.</p>');
const QUOTE = buildQuotedHtmlBlock('<p>Can you send the photo?</p>');
const BODY =
  '<p>Hello Bob,</p><p>here it is <img src="cid:photo1" data-cid="photo1" alt="photo"></p><p></p>'
  + SIGNATURE
  + '<p>On Monday, Bob wrote:</p>'
  + QUOTE;

const DRAFT = {
  to: 'Bob Builder <bob@example.com>',
  cc: '',
  bcc: '',
  subject: 'Re: Photo',
  body: BODY,
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: null,
};

const PLUGIN = 'assistant';

/** The real composer; its id comes from a click on a plugin's toolbar button, as for a plugin. */
async function renderComposer(body = BODY, initialData: Partial<ComposerDraftData> = {}) {
  const clicks: Record<string, unknown>[] = [];
  setActionDispatcher(async (_plugin, _surface, _id, context) => { clicks.push(context); });
  setPluginActions(PLUGIN, 'Assistant', 'composer-toolbar-actions', [{ id: 'ask', label: 'Assistant', icon: 'sparkles', shortcut: 'Ctrl+Shift+Y' }]);
  render(<EmailComposer initialData={{ ...DRAFT, body, ...initialData }} mode="reply" onClose={vi.fn()} />);
  const dom = await waitFor(() => {
    const el = document.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
    expect(el?.editor).toBeTruthy();
    return el!;
  });
  const editor = dom.editor!;
  await waitFor(() => expect(editor.getHTML()).toContain(body.slice(3, 12)));
  fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
  await waitFor(() => expect(clicks).toHaveLength(1));
  const id = clicks[0].composerId as string;
  expect(typeof id).toBe('string');
  return { editor, id, handle: composerHandle(id)!, clicks };
}

const html = (editor: Editor) => serializeEditorContent(editor);

describe('plugins editing the message being written', () => {
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
    resetActions();
    setActionDispatcher(null);
  });

  it('reads live subject and recipient metadata from the registered composer', async () => {
    const { handle } = await renderComposer(BODY, { cc: 'cc@example.com', bcc: 'bcc@example.com' });
    expect(handle.readMetadata?.()).toMatchObject({ subject: 'Re: Photo', to: ['Bob Builder <bob@example.com>'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], attachments: [], pending: false });
    fireEvent.change(screen.getByDisplayValue('Re: Photo'), { target: { value: 'Updated subject' } });
    expect(handle.readMetadata?.().subject).toBe('Updated subject');
  });

  it('distinguishes equal blob ids from two logins and reads through the attachment owner', async () => {
    const fetchA = vi.fn(async () => ({ type: 'text/plain', size: 1, arrayBuffer: async () => new Uint8Array([1]).buffer }));
    const fetchB = vi.fn(async () => ({ type: 'text/plain', size: 1, arrayBuffer: async () => new Uint8Array([2]).buffer }));
    const fetchOwn = vi.fn();
    const previous = useAuthStore.getState();
    const oldClient = previous.client;
    const oldGetClient = previous.getClientForAccount;
    const owners = new Map([['login-a', { fetchBlob: fetchA }], ['login-b', { fetchBlob: fetchB }]]);
    useAuthStore.setState({
      client: { fetchBlob: fetchOwn, hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never,
      getClientForAccount: (id: string) => owners.get(id) as never,
    });
    try {
      const { handle } = await renderComposer(BODY, {
        attachments: [
          { blobId: 'same-blob', name: 'a.txt', type: 'text/plain', size: 1, sourceAccountId: 'login-a' },
          { blobId: 'same-blob', name: 'b.txt', type: 'text/plain', size: 1, sourceAccountId: 'login-b' },
        ],
      });
      const files = handle.readMetadata!().attachments;
      expect(files).toHaveLength(2);
      expect(files[0].id).not.toBe(files[1].id);
      const result = await handle.readAttachment!(files[1].id);
      expect(new Uint8Array(result.data)).toEqual(new Uint8Array([2]));
      expect(fetchB).toHaveBeenCalledWith('same-blob', 'b.txt', 'text/plain');
      expect(fetchA).not.toHaveBeenCalled();
      expect(fetchOwn).not.toHaveBeenCalled();
      await expect(handle.readAttachment!('not-attached')).rejects.toThrow('attachment_unavailable');
    } finally {
      cleanup();
      useAuthStore.setState({ client: oldClient, getClientForAccount: oldGetClient });
    }
  });

  it('reads only the user\'s own text: no signature, no quote header, no quote', async () => {
    const { handle } = await renderComposer();
    const body = handle.readBody();
    expect(body.text).toBe('Hello Bob,\nhere it is');
    expect(body.html).toContain('cid:photo1');
    expect(body.html).not.toContain('ACME');
    expect(body.html).not.toContain('Bob wrote');
    expect(body.html).not.toContain('Can you send');
  });

  it('replaces the own text in place, at once, and leaves signature, quote and inline image', async () => {
    const { editor, handle } = await renderComposer();
    const before = html(editor);
    let ok = false;
    act(() => { ok = handle.replaceBody('<p>Hi Bob, attached.</p>', 'Hi Bob, attached.'); });
    expect(ok).toBe(true);
    // Applied to the editor at once, so a plugin reads its own change back.
    expect(handle.readBody().text).toBe('Hi Bob, attached.');

    const after = html(editor);
    expect(after).not.toContain('Hello Bob');
    expect(after.indexOf('Hi Bob, attached.')).toBeLessThan(after.indexOf('data-signature-block-node'));
    expect(after).toContain('ACME Ltd.');
    expect(after).toContain('On Monday, Bob wrote:');
    expect(after).toContain('Can you send the photo?');
    expect(after).toContain('data-cid="photo1"');
    // The blank line between the text and the signature stays.
    expect(after.indexOf('data-cid="photo1"')).toBeLessThan(after.indexOf('data-signature-block-node'));
    expect(before).not.toBe(after);
  });

  it("leaves a reply's quote header (On ... wrote:) with the quote when there is no signature above it", async () => {
    const { editor, handle } = await renderComposer('<p>Thanks, that works.</p><p>On Monday, Bob wrote:</p>' + QUOTE);
    expect(handle.readBody().text).toBe('Thanks, that works.');
    act(() => { handle.replaceBody('<p>Thank you, that works for me.</p>', 'Thank you, that works for me.'); });
    const after = html(editor);
    expect(after).toContain('Thank you, that works for me.');
    expect(after).toContain('On Monday, Bob wrote:');
    expect(after.indexOf('Thank you')).toBeLessThan(after.indexOf('On Monday'));
  });

  it('is one step in the editor history: one Ctrl+Z brings the old text back', async () => {
    const { editor, handle } = await renderComposer();
    const before = html(editor);
    const depth = undoDepth(editor.state);
    act(() => { handle.replaceBody('<p>Hi Bob, attached.</p>', 'Hi Bob, attached.'); });
    expect(undoDepth(editor.state)).toBe(depth + 1);
    act(() => { editor.commands.undo(); });
    expect(html(editor)).toBe(before);
  });

  it('replaces a selection in one step and keeps an image inside it', async () => {
    const { editor, handle } = await renderComposer();
    const before = html(editor);
    // "Hello Bob," up to and including the image.
    let imageEnd = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'image') imageEnd = pos + node.nodeSize; });
    act(() => { editor.commands.setTextSelection({ from: 1, to: imageEnd }); });
    expect(handle.readSelection().text).toContain('Hello Bob,');

    const depth = undoDepth(editor.state);
    act(() => { handle.replaceSelection('<p>Dear Bob,</p>', 'Dear Bob,', { below: false }); });
    expect(undoDepth(editor.state)).toBe(depth + 1);
    const after = html(editor);
    expect(after).toContain('Dear Bob,');
    expect(after).not.toContain('Hello Bob');
    expect(after).toContain('data-cid="photo1"');
    expect(after).toContain('ACME Ltd.');

    act(() => { editor.commands.undo(); });
    expect(html(editor)).toBe(before);
  });

  it('refuses to replace a selection that holds the signature', async () => {
    const { editor, handle } = await renderComposer();
    const before = html(editor);
    act(() => { editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size }); });
    let ok = true;
    act(() => { ok = handle.replaceSelection('<p>x</p>', 'x', { below: false }); });
    expect(ok).toBe(false);
    expect(html(editor)).toBe(before);
  });

  it('adds below the selection without touching it', async () => {
    const { editor, handle } = await renderComposer();
    act(() => { editor.commands.setTextSelection({ from: 1, to: 6 }); });
    act(() => { handle.replaceSelection('<p>Suggested: Hi Bob</p>', 'Suggested: Hi Bob', { below: true }); });
    const after = html(editor);
    expect(after).toContain('Hello Bob,');
    expect(after.indexOf('Hello Bob,')).toBeLessThan(after.indexOf('Suggested: Hi Bob'));
    expect(after.indexOf('Suggested: Hi Bob')).toBeLessThan(after.indexOf('data-signature-block-node'));
  });

  it('runs a plugin button\'s shortcut while typing in the composer', async () => {
    const { editor, clicks } = await renderComposer();
    fireEvent.keyDown(editor.view.dom, { key: 'Y', code: 'KeyY', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(clicks).toHaveLength(2));
    expect(clicks[1].composerId).toBe(clicks[0].composerId);
  });

  it('attaches a file the plugin uploaded, and forgets the composer when it closes', async () => {
    const { handle, id } = await renderComposer();
    let ok = false;
    await act(async () => { ok = await handle.attach({ blobId: 'B1', name: 'report.pdf', type: 'application/pdf', size: 2048 }); });
    expect(ok).toBe(true);
    expect(await screen.findByText('report.pdf')).toBeTruthy();
    cleanup();
    expect(composerHandle(id)).toBeNull();
  });
});
