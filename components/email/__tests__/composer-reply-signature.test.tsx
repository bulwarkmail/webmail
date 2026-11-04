import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useSettingsStore } from '@/stores/settings-store';
import { useIdentityStore } from '@/stores/identity-store';
import type { Identity } from '@/lib/jmap/types';

// ─── Heavy component mocks (mirrors composer-format-toggle.test.tsx) ─

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
 * #842: replying did not insert the signature. With the signature above the
 * quote, a reply's body is built before its From is known - the composer
 * picks the identity the mail was sent to in an effect, and the identities
 * may load after the composer opened. A plain-text reply never received the
 * signature that arrived then, and the send path doesn't append one to an
 * above-quote reply, so the mail went out unsigned. An HTML reply got it, but
 * between the "On ... wrote:" line and the quote.
 */

const ME = { id: 'id-me', email: 'me@example.com', name: 'Me', htmlSignature: '<b>Alice</b>', textSignature: 'Alice' };
const UNSIGNED_ME = { ...ME, htmlSignature: '', textSignature: '' };
const SALES = { id: 'id-sales', email: 'sales@example.com', name: 'Sales', htmlSignature: '<i>Sales team</i>', textSignature: 'Sales team' };

const REPLY_TO = {
  from: [{ name: 'Bob', email: 'bob@example.com' }],
  to: [{ email: 'sales@example.com' }],
  subject: 'Question',
  body: 'Original text',
  htmlBody: '<p>Original text</p>',
  receivedAt: '2026-08-01T10:00:00Z',
};
const TO_ME = { ...REPLY_TO, to: [{ email: 'me@example.com' }] };

const sendButton = () => screen.getAllByTestId('composer-send')[0] as HTMLButtonElement;

async function send(onSend: ReturnType<typeof vi.fn>) {
  fireEvent.click(sendButton());
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return onSend.mock.calls[0][0] as { body: string; htmlBody?: string };
}

function setIdentities(list: Array<Partial<Identity>>) {
  useIdentityStore.setState({ identities: list as Identity[] });
}

describe('reply signature above the quote (#842)', () => {
  afterEach(() => {
    useSettingsStore.setState({ plainTextMode: false, signaturePosition: 'below_quote' });
    setIdentities([ME]);
    vi.clearAllMocks();
  });

  describe('plain text', () => {
    it('signs a reply from an alias the composer picks itself', async () => {
      useSettingsStore.setState({ signaturePosition: 'above_quote', plainTextMode: true });
      setIdentities([UNSIGNED_ME, SALES]);
      const onSend = vi.fn();
      render(<EmailComposer mode="reply" replyTo={REPLY_TO} onSend={onSend} />);

      const sent = await send(onSend);
      expect(sent.body).toBe('\n\n-- \nSales team\n\nreply_line\n> Original text');
    });

    it('swaps in the signature of the picked alias instead of the default one', async () => {
      useSettingsStore.setState({ signaturePosition: 'above_quote', plainTextMode: true });
      setIdentities([ME, SALES]);
      const onSend = vi.fn();
      render(<EmailComposer mode="replyAll" replyTo={REPLY_TO} onSend={onSend} />);

      const sent = await send(onSend);
      expect(sent.body).toBe('\n\n-- \nSales team\n\nreply_line\n> Original text');
    });

    it('signs a forward when the identities load after it opened', async () => {
      useSettingsStore.setState({ signaturePosition: 'above_quote', plainTextMode: true });
      setIdentities([]);
      const onSend = vi.fn();
      const props = { mode: 'forward' as const, replyTo: TO_ME, prefill: { to: ['carol@example.com'] }, onSend };
      const { rerender } = render(<EmailComposer {...props} />);
      setIdentities([ME]);
      rerender(<EmailComposer {...props} />);

      const sent = await send(onSend);
      expect(sent.body.startsWith('\n\n-- \nAlice\n\nforwarded_separator\n')).toBe(true);
    });
  });

  describe('HTML', () => {
    it('puts the signature of the picked alias above the "wrote:" line', async () => {
      useSettingsStore.setState({ signaturePosition: 'above_quote' });
      setIdentities([UNSIGNED_ME, SALES]);
      const onSend = vi.fn();
      render(<EmailComposer mode="reply" replyTo={REPLY_TO} onSend={onSend} />);

      const sent = await send(onSend);
      const html = sent.htmlBody ?? '';
      expect(html).toContain('<i>Sales team</i>');
      expect(html.indexOf('<i>Sales team</i>')).toBeLessThan(html.indexOf('reply_line'));
    });

    // #1503: with the delimiter on, a reply started with the "-- " line, so
    // there was no line above the signature to type the reply into.
    it('leaves an empty line above the delimiter', () => {
      useSettingsStore.setState({ signaturePosition: 'above_quote' });
      setIdentities([ME]);
      render(<EmailComposer mode="reply" replyTo={TO_ME} />);

      const html = screen.getByTestId('rich-text-editor').getAttribute('data-html')!;
      expect(html.startsWith('<p></p><p data-signature-block="separator">-- </p>')).toBe(true);
    });

    it('leaves an empty line above a delimiter that arrives with late identities', async () => {
      useSettingsStore.setState({ signaturePosition: 'above_quote' });
      setIdentities([]);
      const props = { mode: 'reply' as const, replyTo: TO_ME };
      const { rerender } = render(<EmailComposer {...props} />);
      setIdentities([ME]);
      rerender(<EmailComposer {...props} />);

      await waitFor(() => expect(editorState.html).toContain('<b>Alice</b>'));
      const lines = new DOMParser().parseFromString(editorState.html, 'text/html').body.children;
      expect(lines[0].tagName).toBe('P');
      expect(lines[0].textContent).toBe('');
      expect(lines[0].hasAttribute('data-signature-block')).toBe(false);
      expect(lines[1].getAttribute('data-signature-block')).toBe('separator');
    });
  });

  it('still signs a reply below the quote at send time by default', async () => {
    setIdentities([UNSIGNED_ME, SALES]);
    const onSend = vi.fn();
    render(<EmailComposer mode="reply" replyTo={REPLY_TO} onSend={onSend} />);

    const sent = await send(onSend);
    expect(sent.htmlBody).toMatch(/Original text[\s\S]*<i>Sales team<\/i>$/);
    expect(sent.body).toMatch(/Original text[\s\S]*Sales team$/);
  });
});


describe('reply quote attribution markers', () => {
  afterEach(() => {
    useSettingsStore.setState({ plainTextMode: false, signaturePosition: 'below_quote' });
  });

  it.each(['reply', 'replyAll'] as const)('marks the HTML original in %s mode', (mode) => {
    render(<EmailComposer mode={mode} replyTo={TO_ME} />);
    const html = screen.getByTestId('rich-text-editor').getAttribute('data-html')!;
    expect(html).toContain('data-reply-quote-start="true"');
    expect(html).toContain('Original text');
  });

  it('marks the attribution of a plain-text original composed in rich-text mode', () => {
    render(<EmailComposer mode="reply" replyTo={{ ...TO_ME, htmlBody: undefined }} />);
    const html = screen.getByTestId('rich-text-editor').getAttribute('data-html')!;
    expect(html).toContain('data-reply-quote-start="true"');
    expect(html).toContain('<blockquote');
  });

  it('leaves forwarding attribution unmarked', () => {
    render(<EmailComposer mode="forward" replyTo={TO_ME} />);
    const html = screen.getByTestId('rich-text-editor').getAttribute('data-html')!;
    expect(html).not.toContain('data-reply-quote-start');
    expect(html).toContain('Original text');
  });

  it('preserves a simple plugin attribution', () => {
    render(<EmailComposer mode="reply" replyTo={{ ...TO_ME, quoteHeaderHtml: '<p><b>From:</b> Bob</p>', quoteWrapInBlockquote: false }} />);
    const html = screen.getByTestId('rich-text-editor').getAttribute('data-html')!;
    expect(html).toContain('<p data-reply-quote-start="true"><b>From:</b> Bob</p>');
  });
});

// The forwarded header had From, Date and Subject only; Gmail and Outlook
// also say who the mail went to.
describe('forwarded header recipients', () => {
  afterEach(() => {
    useSettingsStore.setState({ plainTextMode: false, signaturePosition: 'below_quote' });
    setIdentities([ME]);
  });
  const FORWARDED = {
    ...REPLY_TO,
    to: [{ name: 'Anna Becker', email: 'anna@example.com' }, { email: 'team@example.com' }],
    cc: [{ name: 'Carol', email: 'carol@example.com' }],
  };

  it('lists To and Cc in a plain text forward', async () => {
    useSettingsStore.setState({ plainTextMode: true });
    const onSend = vi.fn();
    render(<EmailComposer mode="forward" replyTo={FORWARDED} prefill={{ to: ['dave@example.com'] }} onSend={onSend} />);
    const sent = await send(onSend);
    expect(sent.body).toContain('subject_label: Question\nforward_to_label: Anna Becker <anna@example.com>, team@example.com\nforward_cc_label: Carol <carol@example.com>\n\nOriginal text');
  });

  // escapeHtml is mocked to pass values through in this file.
  it('lists To and Cc in an HTML forward', () => {
    render(<EmailComposer mode="forward" replyTo={FORWARDED} />);
    const html = screen.getByTestId('rich-text-editor').getAttribute('data-html')!;
    expect(html).toContain('subject_label: Question<br>forward_to_label: Anna Becker <anna@example.com>, team@example.com<br>forward_cc_label: Carol <carol@example.com><br><br>');
  });

  it('leaves out a Cc line when nobody was copied', () => {
    render(<EmailComposer mode="forward" replyTo={{ ...FORWARDED, cc: [] }} />);
    const html = screen.getByTestId('rich-text-editor').getAttribute('data-html')!;
    expect(html).toContain('forward_to_label: ');
    expect(html).not.toContain('forward_cc_label');
  });
});
