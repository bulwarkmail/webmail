import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { EmailComposer } from '../email-composer';
import { useAuthStore } from '@/stores/auth-store';
import { DEFAULT_POLICY_SNAPSHOT, type PolicySnapshot } from '@/lib/desktop/policy-schema';
import type { BulwarkDesktopBridge, DesktopRecentFile } from '@/lib/desktop/types';

// Recent files in the Attach menu, in the desktop app: the shell's side is
// repos/desktop's test/recent-files.spec.ts; here the bridge is a stub.

const hoisted = vi.hoisted(() => ({
  picked: [] as unknown[],
  beforeAttachmentUpload: vi.fn(async (_info: { name: string }) => true),
  toastError: vi.fn(),
}));

vi.mock('@/components/files/file-picker-dialog', () => ({
  FilePickerDialog: ({ onPick }: { onPick: (nodes: unknown[]) => void }) =>
    React.createElement(
      'button',
      { type: 'button', 'data-testid': 'fake-file-picker', onClick: () => onPick(hoisted.picked) },
      'pick',
    ),
}));

// ─── Heavy component mocks (mirrors composer-plugin-attachment-source.test.tsx) ─

vi.mock('@/components/email/rich-text-editor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
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

// ─── Misc dependency mocks ────────────────────────────────────────────────────

vi.mock('@/stores/toast-store', () => ({
  toast: { info: () => {}, error: hoisted.toastError, success: () => {} },
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
    onBeforeAttachmentUpload: { intercept: hoisted.beforeAttachmentUpload },
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
  plainTextBodyHasSignature: () => false,
  plainTextBodyWithoutSignature: (body: string) => body,
}));
vi.mock('@/lib/sub-addressing', () => ({ generateSubAddress: () => '' }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/email/quoted-html', () => ({
  buildQuotedHtmlBlock: () => '',
  serializeEditorContent: () => '',
}));
vi.mock('@/lib/template-utils', () => ({ substitutePlaceholders: (s: string) => s }));

// ─── Tests ────────────────────────────────────────────────────────────────────

const NOW = Date.now();
const RECENT: DesktopRecentFile[] = [
  { id: 'id-report', name: 'Quarterly report.docx', folder: '\\\\files\\team\\Reports', path: '\\\\files\\team\\Reports\\Quarterly report.docx', usedAt: NOW - 5 * 60_000, icon: 'data:image/png;base64,iVBORw0KGgo=' },
  { id: 'id-budget', name: 'Budget 2027.xlsx', folder: 'C:\\Users\\me\\Documents', path: 'C:\\Users\\me\\Documents\\Budget 2027.xlsx', usedAt: NOW - 3 * 60 * 60_000 },
];

interface DesktopOptions {
  files?: DesktopRecentFile[];
  policyOff?: boolean;
  /** The shell's native menus: the Attach menu must stay HTML all the same. */
  popup?: ReturnType<typeof vi.fn>;
}

function desktop({ files = RECENT, policyOff = false, popup }: DesktopOptions = {}) {
  const snapshot: PolicySnapshot = {
    ...DEFAULT_POLICY_SNAPSHOT,
    ...(policyOff ? { RecentFilesInAttach: { value: false, source: 'forced-machine', locked: true } } : {}),
  } as PolicySnapshot;
  const list = vi.fn(async () => ({ ok: true as const, files }));
  const attach = vi.fn(async (id: string) => {
    const file = files.find((f) => f.id === id);
    return file
      ? { ok: true as const, file: { name: file.name, data: new TextEncoder().encode(`bytes of ${file.name}`) } }
      : { ok: false as const, reason: 'unknown' as const };
  });
  window.bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    policy: { get: () => snapshot, onChange: () => () => {} },
    recentFiles: { list, attach },
    ...(popup ? { menu: { popup, setState: () => {}, onCommand: () => () => {} } } : {}),
  } as unknown as BulwarkDesktopBridge;
  return { list, attach };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    createDraft: vi.fn().mockResolvedValue('draft-1'),
    getEmail: vi.fn(),
    hasDelayedSend: () => false,
    getMaxDelayedSend: () => 0,
    // No Files, no plugins: in a browser, Attach is a plain button.
    supportsFiles: () => false,
    getMaxSizeAttachmentsPerEmail: () => 0,
    getMaxSizeUpload: () => 0,
    uploadBlob: vi.fn(() => new Promise(() => {})),
    ...overrides,
  };
}

const rows = () => screen.queryAllByTestId('composer-recent-file');

async function openMenu() {
  fireEvent.click(screen.getByTestId('composer-attach-menu'));
  await act(async () => {});
}

describe('recent files in the Attach menu', () => {
  afterEach(() => {
    window.bulwarkDesktop = undefined;
    useAuthStore.setState({ client: null });
    vi.clearAllMocks();
    hoisted.beforeAttachmentUpload.mockImplementation(async () => true);
  });

  it('in a browser the paperclip is the plain button it was', () => {
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    expect(screen.queryByTestId('composer-attach-menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'attach' })).toBeInTheDocument();
  });

  it('in the desktop app the paperclip opens a menu: recent files first, then the file dialog', async () => {
    const { list } = desktop();
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    expect(list).not.toHaveBeenCalled();
    await openMenu();
    expect(list).toHaveBeenCalledTimes(1);

    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.getAttribute('data-testid'))).toEqual(['composer-recent-file', 'composer-recent-file', 'composer-attach-from-device']);
    expect(within(menu).getByText('heading')).toBeInTheDocument();
    expect(items[2]).toHaveTextContent('browse');

    const [report, budget] = rows();
    expect(report).toHaveTextContent('Quarterly report.docx');
    expect(report).toHaveTextContent('\\\\files\\team\\Reports');
    expect(report).toHaveTextContent('5 minutes ago');
    expect(report).toHaveAttribute('title', '\\\\files\\team\\Reports\\Quarterly report.docx');
    expect(report.querySelector('img')).toHaveAttribute('src', RECENT[0].icon);
    // No icon from the shell: the app's own for the type.
    expect(budget.querySelector('img')).toBeNull();
    expect(budget.querySelector('svg')).not.toBeNull();
    expect(budget).toHaveTextContent('3 hours ago');
  });

  // compose-p3-5: each row was 24rem in a menu of at most 22rem, so the dates
  // were cut ("yester…") and the menu scrolled sideways.
  it('fits the rows to the menu and never cuts the date', async () => {
    desktop();
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    await openMenu();
    for (const row of rows()) {
      expect(row.className).toContain('w-full');
      expect(row.className).not.toMatch(/w-\[min\(24rem/);
      const when = row.querySelector('[data-testid="composer-recent-file-when"]')!;
      expect(when.className).toContain('shrink-0');
      expect(when.className).toContain('whitespace-nowrap');
    }
  });

  it('one click attaches that file through the composer\'s own checks and closes the menu', async () => {
    const { attach } = desktop();
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    await openMenu();
    fireEvent.click(rows()[1]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(attach).toHaveBeenCalledWith('id-budget');
    expect(await screen.findByText('Budget 2027.xlsx')).toBeInTheDocument();
    expect(hoisted.beforeAttachmentUpload).toHaveBeenCalledWith(expect.objectContaining({ name: 'Budget 2027.xlsx', size: 'bytes of Budget 2027.xlsx'.length }));
  });

  it('a plugin can refuse it, as it can a file from the dialog', async () => {
    hoisted.beforeAttachmentUpload.mockImplementation(async (info) => info.name !== 'Budget 2027.xlsx');
    desktop();
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    await openMenu();
    fireEvent.click(rows()[1]);
    await act(async () => {});
    expect(hoisted.beforeAttachmentUpload).toHaveBeenCalled();
    expect(screen.queryByText('Budget 2027.xlsx')).toBeNull();
  });

  it('the server\'s size limit applies too', async () => {
    desktop();
    useAuthStore.setState({ client: client({ getMaxSizeUpload: () => 5 }) as never });
    render(<EmailComposer onClose={vi.fn()} />);
    await openMenu();
    fireEvent.click(rows()[0]);
    await act(async () => {});
    expect(hoisted.toastError).toHaveBeenCalledWith('attachment_too_large');
    expect(screen.queryByText('Quarterly report.docx')).toBeNull();
  });

  // compose-p3-18: a 70 MB file was offered like the others; picking it
  // only then said the server takes 48 MB.
  it('greys out a file larger than the server takes, with "Too large" for its date', async () => {
    const { attach } = desktop({ files: [{ ...RECENT[0], size: 70 * 1024 * 1024 }, { ...RECENT[1], size: 1000 }] });
    useAuthStore.setState({ client: client({ getMaxSizeUpload: () => 48 * 1024 * 1024 }) as never });
    render(<EmailComposer onClose={vi.fn()} />);
    await openMenu();
    const [big, small] = rows();
    expect(big).toHaveAttribute('aria-disabled', 'true');
    expect(big).toHaveTextContent('too_large');
    expect(big).not.toHaveTextContent('minutes ago');
    expect(small).not.toHaveAttribute('aria-disabled');
    fireEvent.click(big);
    await act(async () => {});
    expect(attach).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('says so when the file is gone or too large for the app', async () => {
    const { attach } = desktop();
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    attach.mockResolvedValueOnce({ ok: false, reason: 'missing' } as never);
    await openMenu();
    fireEvent.click(rows()[0]);
    await act(async () => {});
    expect(hoisted.toastError).toHaveBeenLastCalledWith('missing');

    attach.mockResolvedValueOnce({ ok: false, reason: 'too-large' } as never);
    await openMenu();
    fireEvent.click(rows()[0]);
    await act(async () => {});
    expect(hoisted.toastError).toHaveBeenLastCalledWith('too_large');
  });

  it('with nothing recent the menu has only its other entries', async () => {
    desktop({ files: [] });
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    await openMenu();
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByText('heading')).toBeNull();
    expect(within(menu).queryByRole('separator')).toBeNull();
    expect(within(menu).getAllByRole('menuitem').map((item) => item.getAttribute('data-testid'))).toEqual(['composer-attach-from-device']);
  });

  it('with the policy off there\'s no list, and Attach is what it was', async () => {
    const { list } = desktop({ policyOff: true });
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    expect(screen.queryByTestId('composer-attach-menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'attach' }));
    await act(async () => {});
    expect(list).not.toHaveBeenCalled();
  });

  it('keys: the first file has the focus, arrows move, Escape closes', async () => {
    desktop();
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    await openMenu();
    await waitFor(() => expect(document.activeElement).toBe(rows()[0]), { timeout: 5000 });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAttribute('data-testid', 'composer-attach-from-device');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  }, 15_000);

  it('stays an HTML menu where the shell would draw it natively', async () => {
    const popup = vi.fn(async () => null);
    desktop({ popup });
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    await openMenu();
    // The list arrives from the shell after the menu opens; on a busy runner that takes a while.
    await waitFor(() => expect(rows()).toHaveLength(2), { timeout: 10_000 });
    expect(popup).not.toHaveBeenCalled();
  }, 15_000);

  // The To field takes the focus a moment after a new message opens; a click the user made
  // in the composer before that (Subject, Attach) keeps it.
  it('leaves the focus where the user put it before the first focus runs', async () => {
    useAuthStore.setState({ client: client() as never });
    render(<EmailComposer onClose={vi.fn()} />);
    const subject = screen.getByTestId('composer-subject');
    subject.focus();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    expect(document.activeElement).toBe(subject);
  });
});
