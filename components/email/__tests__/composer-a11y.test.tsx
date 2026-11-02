import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';

// Accessibility of the composer: named fields, keyboard-reachable chips,
// announcements, uploads, the send confirmation and the default font.

// Translations that show their parameters, so names in labels can be checked.
vi.mock('next-intl', () => ({
  useTranslations: () => {
    const t = (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join('|')}` : key;
    t.raw = () => [];
    return t;
  },
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: (props: { ariaInvalid?: boolean; ariaDescribedBy?: string; defaultTextStyle?: unknown }) =>
    React.createElement('div', {
      'data-testid': 'rich-text-editor',
      'data-invalid': props.ariaInvalid ? 'true' : undefined,
      'data-describedby': props.ariaDescribedBy,
      'data-default-style': JSON.stringify(props.defaultTextStyle ?? null),
    }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/identity/sub-address-helper', () => ({ SubAddressHelper: () => null }));
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('@/components/templates/template-form', () => ({ TemplateForm: () => null }));
vi.mock('@/components/files/file-preview-modal', () => ({ FilePreviewModal: () => null }));
vi.mock('@/hooks/use-pro-multi-account-identities', () => ({
  useProMultiAccountIdentities: () => ({ enabled: false, groups: [], allIdentities: [] }),
  stripCrossAccountIdentityPrefix: (id: string) => ({ localAccountId: null, rawId: id }),
}));

const settings = vi.hoisted(() => ({
  timeFormat: '24h',
  plainTextMode: false,
  subAddressDelimiter: '+',
  autoSelectReplyIdentity: true,
  attachmentReminderEnabled: false,
  attachmentReminderKeywords: [],
  emptySubjectWarningEnabled: false,
  sendDelaySeconds: 0,
  signaturePosition: 'below_quote',
  signatureNewMailEnabled: true,
  signatureReplyForwardEnabled: true,
  signatureSeparatorEnabled: false,
  requestReadReceiptDefault: false,
  sendConfirmation: false,
  composeFontFamily: '',
  composeFontSize: '',
  addTrustedSender: () => {},
  trustedSendersAddressBook: null,
  updateSetting: () => {},
}));
const DEFAULT_SETTINGS = { ...settings };

vi.mock('@/stores/settings-store', () => {
  const hook = (sel?: (s: typeof settings) => unknown) =>
    typeof sel === 'function' ? sel(settings) : settings;
  hook.getState = () => settings;
  hook.setState = (p: Partial<typeof settings>) => Object.assign(settings, p);
  return { useSettingsStore: hook };
});

const auth = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/stores/auth-store', () => {
  const state = {
    get client() { return auth.client; },
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
  const state = { draftSaveEnabled: false, sendRawEmail: async () => ({ sent: true }) };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  hook.setState = (p: Partial<typeof state>) => Object.assign(state, p);
  return { useEmailStore: hook };
});

vi.mock('@/stores/contact-store', () => {
  const state = { contacts: [], getAutocomplete: async () => [], addToTrustedSendersBook: async () => {} };
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

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: toastError, success: () => {} },
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
    onBeforeAttachmentUpload: { intercept: async () => true },
    onBeforeBlobUpload: { transform: async (id: unknown) => id },
    onAfterAttachmentUpload: { emit: () => {} },
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
  isExternalAttachmentResult: () => false,
}));

vi.mock('@/lib/email-sanitization', () => ({
  sanitizeSignatureHtml: (v: string) => v,
  sanitizeSignatureHtmlForDisplay: (v: string) => v,
  sanitizeEmailHtml: (v: string) => v,
  sanitizePluginBodyHtml: (v: string) => v,
  escapeHtml: (v: string) => v,
  parseHtmlSafely: (html: string) => new DOMParser().parseFromString(html, 'text/html'),
}));
const progress = vi.hoisted(() => ({ report: null as null | ((loaded: number, total: number) => void) }));
vi.mock('@/lib/upload-progress', () => ({
  onUploadProgress: (_id: string, report: (loaded: number, total: number) => void) => {
    progress.report = report;
    return () => {};
  },
}));
vi.mock('@/lib/plugin-storage', () => ({
  fileStorage: { saveFile: async () => {}, getFile: async () => null, deleteFile: async () => {} },
}));
vi.mock('@/lib/email-threading', () => ({
  computeReplyThreadingHeaders: () => ({ inReplyTo: [], references: [] }),
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

const DRAFT = {
  to: '',
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

const liveRegion = () => screen.getByTestId('composer-live-region');
const toInput = () => screen.getByPlaceholderText('to_placeholder') as HTMLInputElement;

beforeEach(() => {
  Object.assign(settings, DEFAULT_SETTINGS);
  auth.client = null;
});

/** A client whose upload is held: report progress, then fail or never finish. */
function uploadClient(upload: () => Promise<{ blobId: string }>) {
  auth.client = {
    uploadBlob: vi.fn(upload),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
  };
}

async function attach(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('recipient fields (SR-06, CV-02)', () => {
  it('names the To input by its visible label, also once it holds chips', () => {
    render(<EmailComposer initialData={{ ...DRAFT, to: 'Anna Berg <anna@example.com>' }} />);
    const input = screen.getByRole('combobox', { name: 'to:' });
    // The placeholder, the only name before, is gone once a chip exists.
    expect(input).toHaveAttribute('placeholder', '');
    expect(screen.getByRole('list', { name: 'to:' })).toBeInTheDocument();
  });

  it('labels the subject field', () => {
    render(<EmailComposer initialData={DRAFT} />);
    expect(screen.getByLabelText('subject_label')).toBe(screen.getByTestId('composer-subject'));
  });

  it('names the remove button after the person', () => {
    render(<EmailComposer initialData={{ ...DRAFT, to: 'Anna Berg <anna@example.com>' }} />);
    expect(screen.getByRole('button', { name: 'recipient_remove_named:Anna Berg' })).toBeInTheDocument();
  });

  it('gives the chips one Tab stop and moves between them with the arrows', () => {
    render(<EmailComposer initialData={{ ...DRAFT, to: 'anna@example.com, ben@example.com, cleo@example.com' }} />);
    const chips = within(screen.getByRole('list', { name: 'to:' })).getAllByRole('listitem');
    expect(chips.map((c) => c.tabIndex)).toEqual([-1, -1, 0]);

    // ← at the start of the input steps onto the last chip.
    const input = screen.getByRole('combobox', { name: 'to:' }) as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(chips[2]);

    fireEvent.keyDown(chips[2], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(chips[1]);
    expect(chips.map((c) => c.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(chips[1], { key: 'Home' });
    expect(document.activeElement).toBe(chips[0]);
    fireEvent.keyDown(chips[0], { key: 'End' });
    expect(document.activeElement).toBe(chips[2]);
    fireEvent.keyDown(chips[2], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(input);
  });

  it('removes the focused chip with Delete, moves the focus on and announces it', async () => {
    vi.useFakeTimers();
    try {
      render(<EmailComposer initialData={{ ...DRAFT, to: 'Anna Berg <anna@example.com>, ben@example.com' }} />);
      // The composer focuses the To field on open; let that happen first.
      act(() => { vi.runOnlyPendingTimers(); });
      const chips = within(screen.getByRole('list', { name: 'to:' })).getAllByRole('listitem');
      chips[0].focus();
      fireEvent.keyDown(chips[0], { key: 'Delete' });
      act(() => { vi.runOnlyPendingTimers(); });

      const left = within(screen.getByRole('list', { name: 'to:' })).getAllByRole('listitem');
      expect(left).toHaveLength(1);
      expect(left[0]).toHaveTextContent('ben@example.com');
      expect(document.activeElement).toBe(left[0]);
      expect(liveRegion()).toHaveTextContent('recipient_removed:Anna Berg|to');
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces a recipient added by typing', () => {
    render(<EmailComposer initialData={DRAFT} />);
    expect(liveRegion()).toHaveTextContent('');
    fireEvent.change(toInput(), { target: { value: 'bob@example.com' } });
    fireEvent.keyDown(toInput(), { key: ',' });
    expect(liveRegion()).toHaveTextContent('recipient_added:bob@example.com|to');
  });

  it('links the missing-recipient error to the input and shows it with an icon', async () => {
    render(<EmailComposer initialData={DRAFT} />);
    // Send is disabled without a recipient; Ctrl+Enter still tries.
    fireEvent.keyDown(screen.getByTestId('composer-subject'), { key: 'Enter', ctrlKey: true });
    await act(async () => {});

    const input = toInput();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const error = document.getElementById(describedBy!);
    expect(error).toHaveTextContent('validation.recipient_required');
    expect(error?.querySelector('svg')).not.toBeNull();
  });

  it('says in text that a chip is not a valid address', () => {
    render(<EmailComposer initialData={{ ...DRAFT, to: 'notanemail' }} />);
    const chip = within(screen.getByRole('list', { name: 'to:' })).getByRole('listitem');
    expect(chip).toHaveTextContent('invalid_recipient');
  });
});

describe('moving a recipient by keyboard (MO-07)', () => {
  it('moves a chip to Cc from its menu and announces it', async () => {
    render(<EmailComposer initialData={{ ...DRAFT, to: 'Anna Berg <anna@example.com>' }} />);
    const chip = within(screen.getByRole('list', { name: 'to:' })).getByRole('listitem');
    chip.focus();
    fireEvent.keyDown(chip, { key: 'Enter' });

    const move = await screen.findByTestId('recipient-move-cc');
    expect(move).toHaveTextContent('recipient_move_to:cc');
    expect(screen.queryByTestId('recipient-move-to')).toBeNull();
    fireEvent.click(move);

    await waitFor(() => expect(screen.queryByRole('list', { name: 'to:' })).toBeNull());
    expect(within(screen.getByRole('list', { name: 'cc_label' })).getByRole('listitem')).toHaveTextContent('Anna Berg');
    expect(liveRegion()).toHaveTextContent('recipient_moved:Anna Berg|cc');
  });

  it('opens the chip menu with Shift+F10 too', async () => {
    render(<EmailComposer initialData={{ ...DRAFT, to: 'anna@example.com' }} />);
    const chip = within(screen.getByRole('list', { name: 'to:' })).getByRole('listitem');
    chip.focus();
    fireEvent.keyDown(chip, { key: 'F10', shiftKey: true });
    expect(await screen.findByTestId('recipient-move-bcc')).toBeInTheDocument();
  });
});

describe('message body (SR-07)', () => {
  it('labels the plain-text body', () => {
    settings.plainTextMode = true;
    render(<EmailComposer initialData={DRAFT} />);
    expect(screen.getByLabelText('body_label').tagName).toBe('TEXTAREA');
  });

  it('marks an empty body invalid and links the error text', async () => {
    render(<EmailComposer initialData={{ ...DRAFT, to: 'bob@example.com', body: '' }} />);
    const editor = screen.getByTestId('rich-text-editor');
    expect(editor).not.toHaveAttribute('data-invalid');

    fireEvent.keyDown(screen.getByTestId('composer-subject'), { key: 'Enter', ctrlKey: true });
    await act(async () => {});

    expect(editor).toHaveAttribute('data-invalid', 'true');
    const error = document.getElementById(editor.getAttribute('data-describedby')!);
    expect(error).toHaveTextContent('validation.body_required');
  });
});

describe('attachment uploads (SR-16)', () => {
  it('shows upload progress as a named progress bar with a text value', async () => {
    uploadClient(() => new Promise(() => {}));
    render(<EmailComposer initialData={DRAFT} />);
    await attach(new File(['%PDF'], 'report.pdf', { type: 'application/pdf' }));

    const bar = screen.getByRole('progressbar', { name: 'report.pdf' });
    expect(bar).toHaveAttribute('aria-valuetext', 'attachment_uploading');
    act(() => progress.report?.(45, 100));
    expect(bar).toHaveAttribute('aria-valuenow', '45');
    expect(bar).toHaveAttribute('aria-valuetext', 'attachment_progress:45');
  });

  // The error toast is a live region of its own; the composer saying it
  // too would read the failure twice.
  it('says in words that an upload failed and reports it once', async () => {
    uploadClient(() => Promise.reject(new Error('boom')));
    render(<EmailComposer initialData={DRAFT} />);
    await attach(new File(['%PDF'], 'report.pdf', { type: 'application/pdf' }));

    await waitFor(() => expect(screen.getByText('attachment_upload_failed')).toBeInTheDocument());
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(toastError).toHaveBeenCalledWith('upload_failed:report.pdf');
    expect(liveRegion()).not.toHaveTextContent('upload_failed');
  });
});

describe('confirm before sending (MO-16)', () => {
  const READY = { ...DRAFT, to: 'bob@example.com, carol@example.com' };

  it('sends straight away while the setting is off', async () => {
    const onSend = vi.fn();
    render(<EmailComposer initialData={READY} onSend={onSend} />);
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks first when it is on, and sends only after the user confirms', async () => {
    settings.sendConfirmation = true;
    const onSend = vi.fn();
    render(<EmailComposer initialData={READY} onSend={onSend} />);
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('send_confirm.title');
    expect(dialog).toHaveTextContent('send_confirm.message:2');
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it('asks on Ctrl+Enter too, and does not send when cancelled', async () => {
    settings.sendConfirmation = true;
    const onSend = vi.fn();
    render(<EmailComposer initialData={READY} onSend={onSend} />);
    fireEvent.keyDown(screen.getByTestId('composer-subject'), { key: 'Enter', ctrlKey: true });

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(async () => {});
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('default compose font (CO-16)', () => {
  const READY = { ...DRAFT, to: 'bob@example.com' };

  it('starts the editor in the chosen font and sends it with the mail', async () => {
    settings.composeFontFamily = 'serif';
    settings.composeFontSize = '18px';
    const onSend = vi.fn();
    render(<EmailComposer initialData={READY} onSend={onSend} />);
    expect(JSON.parse(screen.getByTestId('rich-text-editor').getAttribute('data-default-style')!))
      .toEqual({ fontFamily: 'serif', fontSize: '18px' });

    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const sent = onSend.mock.calls[0][0] as { htmlBody?: string };
    expect(sent.htmlBody).toMatch(/^<div style="font-family: serif; font-size: 18px">/);
  });

  it('leaves the mail as it was without the setting, and ignores values that are not a font', async () => {
    settings.composeFontFamily = 'serif"><script>';
    const onSend = vi.fn();
    render(<EmailComposer initialData={READY} onSend={onSend} />);
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect((onSend.mock.calls[0][0] as { htmlBody?: string }).htmlBody).toMatch(/^<div>/);
  });
});

describe('alt text in the plain-text part (MA-02)', () => {
  it('keeps image descriptions in the text part and skips decorative images', async () => {
    const onSend = vi.fn();
    render(<EmailComposer
      initialData={{ ...DRAFT, to: 'bob@example.com', body: '<p>Results <img src="data:image/png;base64,AA" alt="Sales chart"> <img src="data:image/png;base64,BB" alt=""></p>' }}
      onSend={onSend}
    />);
    fireEvent.click(screen.getAllByTestId('composer-send')[0]);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const sent = onSend.mock.calls[0][0] as { body: string };
    expect(sent.body).toBe('Results image_alt.plain_text:Sales chart');
  });
});
