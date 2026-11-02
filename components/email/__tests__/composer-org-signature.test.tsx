import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { registerOrgOutgoing } from '@/lib/org/outgoing';
import { resetSendPipeline } from '@/lib/outgoing/send-pipeline';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';

// ─── Heavy component mocks (mirrors composer-reply-signature.test.tsx) ─

// A stand-in for the TipTap editor: it hands the composer an editor object
// whose content is whatever the composer last rendered into it, the way the
// real editor reports itself ready from an effect after mounting.
const editorState = vi.hoisted(() => ({ html: '' }));
// A plugin that rewrites signatures (onSignatureRender), off unless a test turns it on.
const signaturePlugin = vi.hoisted(() => ({ on: false }));
// Send plugins: a footer added by onTransformOutgoingEmail, and a crypto
// plugin taking the send over (onComposeSend).
const sendPlugins = vi.hoisted(() => ({
  footer: false,
  takeOver: null as null | ((request: { htmlBody: string; textBody: string }) => void),
}));
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
    emptySubjectWarningEnabled: false,
    signatureDetails: { title: '', department: '', phone: '', mobile: '' },
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
    onSignatureRender: {
      get size() { return signaturePlugin.on ? 1 : 0; },
      transform: async (value: { html: string; text: string }) => ({ html: `${value.html}<p>PLUGIN</p>`, text: `${value.text} PLUGIN` }),
    },
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
    onComposeSend: {
      takeOver: async (request: { htmlBody: string; textBody: string }) => {
        if (!sendPlugins.takeOver) return 'default';
        sendPlugins.takeOver(request);
        return 'handled';
      },
    },
    onTransformOutgoingEmail: {
      transform: async (email: { htmlBody: string; textBody: string }) => (sendPlugins.footer
        ? { ...email, htmlBody: `${email.htmlBody}<p>Plugin footer</p>`, textBody: `${email.textBody}\n\nPlugin footer` }
        : email),
    },
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
 * The organisation signature (lib/org-signature.ts) goes in where the
 * composer's own signature goes, before plugins, so every path that builds
 * a signature carries it: a new mail, a reply, a forward, a re-opened draft,
 * plain text, an identity switch. Each body must carry it exactly once.
 */

const ORG_SIGNATURE = {
  html: '<p><b>{name}</b><br>{title}<br>Phone: {phone}<br>Mobile: {mobile}</p><p>ACME Ltd</p>',
  text: '{name}\n{title}\nPhone: {phone}\nMobile: {mobile}\nACME Ltd',
  fields: ['title', 'phone', 'mobile'] as Array<'title' | 'phone' | 'mobile'>,
};

function setOrgPolicy(options: { locked?: boolean; signature?: typeof ORG_SIGNATURE | null } = {}) {
  const signature = options.signature === undefined ? ORG_SIGNATURE : options.signature;
  const policy: SettingsPolicy = {
    ...DEFAULT_POLICY,
    restrictions: options.locked ? { signature: { locked: true } } : {},
    organisation: {
      ...DEFAULT_ORGANISATION_POLICY,
      signature: signature ?? DEFAULT_ORGANISATION_POLICY.signature,
    },
  };
  usePolicyStore.setState({ policy, rawPolicy: policy, subject: null });
}

const REPLY_TO = {
  from: [{ name: 'Bob', email: 'bob@example.com' }],
  to: [{ email: 'me@example.com' }],
  subject: 'Question',
  body: 'Original text',
  htmlBody: '<p>Original text</p>',
  receivedAt: '2026-08-01T10:00:00Z',
};

const DRAFT = {
  to: 'bob@example.com',
  cc: '',
  bcc: '',
  subject: 'Re: Question',
  body: '<p>Thanks, looks good.</p><blockquote>original mail</blockquote>',
  showCc: false,
  showBcc: false,
  selectedIdentityId: 'id-me',
  subAddressTag: '',
  mode: 'compose' as const,
  draftId: 'draft-v1',
};

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;
const fromSelect = () => screen.getByTestId('composer-from') as HTMLSelectElement;
const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

async function send(onSend: ReturnType<typeof vi.fn>) {
  fireEvent.click(sendButton());
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0] as { body: string; htmlBody?: string };
}

/** The body carries the organisation signature for `name` once, and no personal one. */
function expectOrgSignatureOnce(sent: { body: string; htmlBody?: string }, name: string) {
  if (sent.htmlBody !== undefined) {
    expect(countOf(sent.htmlBody, 'ACME Ltd')).toBe(1);
    expect(sent.htmlBody).toContain(`<b>${name}</b><br>CEO<br>Phone: +49 30 1</p>`);
    expect(sent.htmlBody).not.toContain('Mobile:');
    expect(sent.htmlBody).not.toContain('Alice');
  }
  expect(countOf(sent.body, 'ACME Ltd')).toBe(1);
  // The text part of an HTML mail is made from the HTML, so its spacing
  // follows the paragraphs; a plain-text mail has the text template as is.
  const squash = (value: string) => value.replace(/\s+/g, ' ');
  if (sent.htmlBody !== undefined) expect(squash(sent.body)).toContain(`${name} CEO Phone: +49 30 1 ACME Ltd`);
  else expect(sent.body).toContain(`-- \n${name}\nCEO\nPhone: +49 30 1\nACME Ltd`);
  expect(sent.body).not.toContain('Mobile:');
  expect(sent.body).not.toContain('Alice');
}

describe('organisation signature in the composer', () => {
  beforeEach(() => {
    resetSendPipeline();
    registerOrgOutgoing();
    useSettingsStore.setState({
      signatureDetails: { title: 'CEO', department: '', phone: '+49 30 1', mobile: '' },
    } as never);
  });
  afterEach(() => {
    resetSendPipeline();
    useSettingsStore.setState({ plainTextMode: false, signaturePosition: 'below_quote' });
    setOrgPolicy({ signature: null });
    vi.clearAllMocks();
  });

  describe('locked: it replaces every signature', () => {
    beforeEach(() => setOrgPolicy({ locked: true }));

    it('signs a new mail once', async () => {
      const onSend = vi.fn();
      render(<EmailComposer prefill={{ to: ['bob@example.com'] }} onSend={onSend} />);
      expectOrgSignatureOnce(await send(onSend), 'Me');
    });

    it('signs a reply once, below the quote', async () => {
      const onSend = vi.fn();
      render(<EmailComposer mode="reply" replyTo={REPLY_TO} onSend={onSend} />);
      const sent = await send(onSend);
      expectOrgSignatureOnce(sent, 'Me');
      expect(sent.htmlBody!.indexOf('Original text')).toBeLessThan(sent.htmlBody!.indexOf('ACME Ltd'));
    });

    it('signs a reply above the quote once', async () => {
      useSettingsStore.setState({ signaturePosition: 'above_quote' });
      const onSend = vi.fn();
      render(<EmailComposer mode="reply" replyTo={REPLY_TO} onSend={onSend} />);
      const sent = await send(onSend);
      expectOrgSignatureOnce(sent, 'Me');
      expect(sent.htmlBody!.indexOf('ACME Ltd')).toBeLessThan(sent.htmlBody!.indexOf('reply_line'));
    });

    it('signs a forward once', async () => {
      const onSend = vi.fn();
      render(<EmailComposer mode="forward" replyTo={REPLY_TO} prefill={{ to: ['carol@example.com'] }} onSend={onSend} />);
      expectOrgSignatureOnce(await send(onSend), 'Me');
    });

    it('signs a re-opened draft once, also one that already carries it', async () => {
      const first = vi.fn();
      const { unmount } = render(<EmailComposer initialData={DRAFT} onSend={first} />);
      expectOrgSignatureOnce(await send(first), 'Me');
      const resent = first.mock.calls[0][0] as { htmlBody: string };
      unmount();

      // The body as the composer saved it, signature range included.
      const withSignature = resent.htmlBody.replace(/^<div>|<\/div>$/g, '');
      const second = vi.fn();
      render(<EmailComposer initialData={{ ...DRAFT, body: withSignature }} onSend={second} />);
      expectOrgSignatureOnce(await send(second), 'Me');
    });

    it('signs a plain-text mail and a plain-text reply once', async () => {
      useSettingsStore.setState({ plainTextMode: true });
      const compose = vi.fn();
      const { unmount } = render(<EmailComposer prefill={{ to: ['bob@example.com'] }} onSend={compose} />);
      const sent = await send(compose);
      expect(sent.htmlBody).toBeUndefined();
      expectOrgSignatureOnce(sent, 'Me');
      unmount();

      const reply = vi.fn();
      render(<EmailComposer mode="reply" replyTo={REPLY_TO} onSend={reply} />);
      expectOrgSignatureOnce(await send(reply), 'Me');
    });

    it('fills it in again for the identity picked in From', async () => {
      const onSend = vi.fn();
      render(<EmailComposer prefill={{ to: ['bob@example.com'] }} onSend={onSend} />);
      fireEvent.change(fromSelect(), { target: { value: 'id-team' } });
      await waitFor(() => expect(editorState.html).toContain('<b>Team</b>'));
      const sent = await send(onSend);
      expectOrgSignatureOnce(sent, 'Team');
      expect(sent.htmlBody).not.toContain('<b>Me</b>');
    });

    it('swaps it in a plain-text mail too', async () => {
      useSettingsStore.setState({ plainTextMode: true });
      const onSend = vi.fn();
      render(<EmailComposer prefill={{ to: ['bob@example.com'] }} onSend={onSend} />);
      fireEvent.change(fromSelect(), { target: { value: 'id-team' } });
      const textarea = () => document.querySelector('textarea') as HTMLTextAreaElement;
      await waitFor(() => expect(textarea().value).toContain('Team\nCEO'));
      const sent = await send(onSend);
      expectOrgSignatureOnce(sent, 'Team');
      expect(sent.body).not.toContain('Me\nCEO');
    });
  });

  describe('not locked: the default for identities without their own', () => {
    beforeEach(() => setOrgPolicy());

    it('keeps the signature of an identity that has one', async () => {
      const onSend = vi.fn();
      render(<EmailComposer prefill={{ to: ['bob@example.com'] }} onSend={onSend} />);
      const sent = await send(onSend);
      expect(sent.htmlBody).toContain('<b>Alice</b>');
      expect(sent.htmlBody).not.toContain('ACME Ltd');
    });

    it('signs from an identity without one with the organisation signature', async () => {
      const onSend = vi.fn();
      render(<EmailComposer prefill={{ to: ['bob@example.com'] }} onSend={onSend} />);
      fireEvent.change(fromSelect(), { target: { value: 'id-team' } });
      await waitFor(() => expect(editorState.html).toContain('ACME Ltd'));
      expectOrgSignatureOnce(await send(onSend), 'Team');
    });
  });

  describe('a signature that changes while the composer is open', () => {
    const PROPS = { prefill: { to: ['bob@example.com'] } };

    it('swaps in a locked signature whose policy arrives after the composer opened', async () => {
      setOrgPolicy({ signature: null });
      const onSend = vi.fn();
      render(<EmailComposer {...PROPS} onSend={onSend} />);
      await waitFor(() => expect(editorState.html).toContain('<b>Alice</b>'));
      act(() => setOrgPolicy({ locked: true }));
      await waitFor(() => expect(editorState.html).toContain('ACME Ltd'));
      expectOrgSignatureOnce(await send(onSend), 'Me');
    });

    it('brings in a default that arrives late for an identity without a signature', async () => {
      setOrgPolicy({ signature: null });
      const onSend = vi.fn();
      render(<EmailComposer {...PROPS} onSend={onSend} />);
      fireEvent.change(fromSelect(), { target: { value: 'id-team' } });
      await waitFor(() => expect(editorState.html).not.toContain('Alice'));
      act(() => setOrgPolicy());
      await waitFor(() => expect(editorState.html).toContain('ACME Ltd'));
      expectOrgSignatureOnce(await send(onSend), 'Team');
    });

    it('fills in the details again when they change', async () => {
      setOrgPolicy({ locked: true });
      const onSend = vi.fn();
      const { rerender } = render(<EmailComposer {...PROPS} onSend={onSend} />);
      await waitFor(() => expect(editorState.html).toContain('CEO'));
      useSettingsStore.setState({ signatureDetails: { title: 'CTO', department: '', phone: '+49 30 1', mobile: '' } } as never);
      rerender(<EmailComposer {...PROPS} onSend={onSend} />);
      await waitFor(() => expect(editorState.html).toContain('CTO'));
      const sent = await send(onSend);
      expect(countOf(sent.htmlBody!, 'ACME Ltd')).toBe(1);
      expect(sent.htmlBody).not.toContain('CEO');
    });

    it('keeps plugins away from a locked signature, and lets them change an unlocked one', async () => {
      signaturePlugin.on = true;
      try {
        setOrgPolicy({ locked: true });
        const locked = vi.fn();
        const { unmount } = render(<EmailComposer {...PROPS} onSend={locked} />);
        await waitFor(() => expect(editorState.html).toContain('ACME Ltd'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const sent = await send(locked);
        expect(sent.htmlBody).not.toContain('PLUGIN');
        expectOrgSignatureOnce(sent, 'Me');
        unmount();

        setOrgPolicy();
        render(<EmailComposer {...PROPS} onSend={vi.fn()} />);
        await waitFor(() => expect(editorState.html).toContain('<b>Alice</b><p>PLUGIN</p>'));
      } finally {
        signaturePlugin.on = false;
      }
    });

    it('swaps a plain-text signature whose policy arrives late', async () => {
      useSettingsStore.setState({ plainTextMode: true });
      setOrgPolicy({ signature: null });
      const onSend = vi.fn();
      render(<EmailComposer {...PROPS} onSend={onSend} />);
      const textarea = () => document.querySelector('textarea') as HTMLTextAreaElement;
      await waitFor(() => expect(textarea().value).toContain('Alice'));
      act(() => setOrgPolicy({ locked: true }));
      await waitFor(() => expect(textarea().value).toContain('ACME Ltd'));
      expectOrgSignatureOnce(await send(onSend), 'Me');
    });
  });
});

describe('organisation disclaimer in the composer', () => {
  const DISCLAIMER = { html: '<p>Confidential, from {email}</p>', text: '' };

  beforeEach(() => {
    registerOrgOutgoing();
    const policy: SettingsPolicy = {
      ...DEFAULT_POLICY,
      organisation: { ...DEFAULT_ORGANISATION_POLICY, disclaimer: DISCLAIMER },
    };
    usePolicyStore.setState({ policy, rawPolicy: policy, subject: null });
  });
  afterEach(() => {
    resetSendPipeline();
    useAuthStore.setState({ client: null });
    useSettingsStore.setState({ plainTextMode: false });
    setOrgPolicy({ signature: null });
    vi.clearAllMocks();
  });

  it('shows it read-only under the editor', () => {
    render(<EmailComposer prefill={{ to: ['bob@example.com'] }} />);
    const preview = screen.getByTestId('org-disclaimer-preview');
    expect(preview).toHaveTextContent('disclaimer_added_on_send');
    expect(preview.innerHTML).toContain('<p>Confidential, from me@example.com</p>');
    expect(editorState.html).not.toContain('Confidential');
  });

  it('sends it once below the quote, and saves the draft without it', async () => {
    const createDraft = vi.fn().mockResolvedValue('draft-1');
    useAuthStore.setState({
      client: { createDraft, getEmail: vi.fn().mockResolvedValue(null), hasDelayedSend: () => false, getMaxDelayedSend: () => 0 } as never,
    });
    const onSend = vi.fn();
    render(<EmailComposer mode="reply" replyTo={REPLY_TO} onSend={onSend} />);
    // A change arms the autosave, which the send flushes first.
    fireEvent.change(screen.getByTestId('composer-subject'), { target: { value: 'Re: Question?' } });
    const sent = await send(onSend);

    expect(createDraft).toHaveBeenCalled();
    for (const call of createDraft.mock.calls) {
      expect(`${call[2]} ${call[10]}`).not.toContain('Confidential');
    }
    expect(countOf(sent.htmlBody!, 'Confidential')).toBe(1);
    expect(sent.htmlBody).toMatch(/Original text[\s\S]*<hr><div data-org-disclaimer=""><p>Confidential, from me@example.com<\/p><\/div>$/);
    expect(countOf(sent.body, 'Confidential')).toBe(1);
    expect(sent.body).toMatch(/Original text[\s\S]*\n\nConfidential, from me@example.com$/);
  });

  it('sends it once in a plain-text mail', async () => {
    useSettingsStore.setState({ plainTextMode: true });
    const onSend = vi.fn();
    render(<EmailComposer prefill={{ to: ['bob@example.com'] }} onSend={onSend} />);
    const sent = await send(onSend);
    expect(sent.htmlBody).toBeUndefined();
    expect(countOf(sent.body, 'Confidential')).toBe(1);
    expect(sent.body.endsWith('\n\nConfidential, from me@example.com')).toBe(true);
  });

  it('shows no block and adds no second copy when a draft back from Undo already ends with it', async () => {
    const onSend = vi.fn();
    // As the first send went out: the signature embedded, the disclaimer below it.
    const body = '<p>Hi Bob</p><p data-signature-block="separator">-- </p><div data-signature-block-node=""><b>Alice</b></div>'
      + '<p data-signature-block="end"></p><hr><p>Confidential, from me@example.com</p>';
    render(<EmailComposer initialData={{ ...DRAFT, body }} onSend={onSend} />);
    await waitFor(() => expect(screen.queryByTestId('org-disclaimer-preview')).toBeNull());
    const sent = await send(onSend);
    expect(countOf(sent.htmlBody!, 'Confidential')).toBe(1);
    expect(countOf(sent.body, 'Confidential')).toBe(1);
  });

  it('goes below a footer a plugin adds', async () => {
    sendPlugins.footer = true;
    try {
      const onSend = vi.fn();
      render(<EmailComposer prefill={{ to: ['bob@example.com'] }} onSend={onSend} />);
      const sent = await send(onSend);
      expect(sent.htmlBody).toMatch(/<p>Plugin footer<\/p><hr><div data-org-disclaimer=""><p>Confidential, from me@example.com<\/p><\/div>$/);
      expect(sent.body).toMatch(/Plugin footer\n\nConfidential, from me@example.com$/);
    } finally {
      sendPlugins.footer = false;
    }
  });

  it('is in the message a signing or encrypting plugin takes over', async () => {
    const taken = vi.fn();
    sendPlugins.takeOver = taken;
    try {
      render(<EmailComposer prefill={{ to: ['bob@example.com'] }} onSend={vi.fn()} />);
      fireEvent.click(sendButton());
      await waitFor(() => expect(taken).toHaveBeenCalledTimes(1));
      const request = taken.mock.calls[0][0] as { htmlBody: string; textBody: string };
      expect(countOf(request.htmlBody, 'Confidential')).toBe(1);
      expect(request.textBody.endsWith('\n\nConfidential, from me@example.com')).toBe(true);
    } finally {
      sendPlugins.takeOver = null;
    }
  });
});
