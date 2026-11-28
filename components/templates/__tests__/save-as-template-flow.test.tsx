import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';

// "Save as template" on a message: the message is read in full, its cid:
// images become data: URLs, and the template goes to the user's own list.
// The global next-intl mock returns keys.

vi.mock('@/components/templates/template-form', () => ({
  TemplateForm: ({ initialData, onSave }: { initialData: Record<string, unknown>; onSave: (data: unknown) => void }) => (
    <div>
      <pre data-testid="form-data">{JSON.stringify(initialData)}</pre>
      <button type="button" onClick={() => onSave({ ...initialData, category: 'Work', isFavorite: false })}>form-save</button>
    </div>
  ),
}));

const { SaveAsTemplateFlow } = await import('../save-as-template-flow');
const { useSaveAsTemplateStore } = await import('@/stores/save-as-template-store');
const { useTemplateStore } = await import('@/stores/template-store');
const { useAccountTemplatesStore, emptyPartition } = await import('@/stores/account-templates-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useEmailStore } = await import('@/stores/email-store');
const { toast } = await import('@/stores/toast-store');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const listRow = {
  id: 'e1',
  subject: 'Weekly report',
  from: [{ email: 'me@example.com' }],
  to: [{ name: 'Bob', email: 'bob@example.com' }],
  mailboxIds: { sent: true },
} as unknown as Email;

const full = {
  ...listRow,
  htmlBody: [{ partId: '1', blobId: 'body', size: 10, type: 'text/html' }],
  textBody: [],
  bodyValues: { 1: { value: '<p>Hello<img src="cid:logo"></p>' } },
  attachments: [{ partId: '2', blobId: 'b-logo', size: 8, type: 'application/octet-stream', cid: '<logo>', disposition: 'inline' }],
} as unknown as Email;

const original = useAuthStore.getState();
let client: { getEmail: ReturnType<typeof vi.fn>; fetchBlobArrayBuffer: ReturnType<typeof vi.fn> };

beforeEach(() => {
  client = {
    getEmail: vi.fn(async () => full),
    fetchBlobArrayBuffer: vi.fn(async () => PNG.buffer.slice(0)),
  };
  useAuthStore.setState({ client, activeAccountId: null, identities: [] } as never);
  useEmailStore.setState({ viewingAccountId: null, mailboxes: [{ id: 'sent', name: 'Sent', role: 'sent' }] } as never);
  useTemplateStore.setState({ templates: [], recentTemplateIds: [], deletedTemplateIds: {} });
  useAccountTemplatesStore.setState({ personal: {}, teams: {}, active: null });
  useSaveAsTemplateStore.getState().ask(listRow);
});

afterEach(() => {
  useAuthStore.setState({ client: original.client, activeAccountId: original.activeAccountId, identities: original.identities } as never);
  useSaveAsTemplateStore.getState().close();
  vi.restoreAllMocks();
});

const saveButton = () => screen.getByRole('button', { name: 'save' }) as HTMLButtonElement;

describe('SaveAsTemplateFlow', () => {
  it('names the template after the subject and saves the body with its images', async () => {
    const success = vi.spyOn(toast, 'success');
    render(<SaveAsTemplateFlow email={listRow} />);
    expect((screen.getByLabelText('template_name') as HTMLInputElement).value).toBe('Weekly report');
    // Save waits for the message to be read.
    expect(saveButton().disabled).toBe(true);
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    fireEvent.click(saveButton());
    const [saved] = useTemplateStore.getState().templates;
    expect(saved).toMatchObject({ name: 'Weekly report', subject: 'Weekly report', isHTML: true });
    // The part was declared octet-stream: its type is read from the bytes.
    expect(saved.body).toMatch(/^<p>Hello<img src="data:image\/png;base64,[^"]+"><\/p>$/);
    expect(client.getEmail).toHaveBeenCalledWith('e1', undefined);
    expect(success).toHaveBeenCalledWith('template_saved');
    expect(useSaveAsTemplateStore.getState().pending).toBeNull();
  });

  it('names the template without the Re:/Fwd: prefixes', async () => {
    const reply = { ...listRow, subject: 'Re: Fwd: Weekly report' } as Email;
    render(<SaveAsTemplateFlow email={reply} />);
    expect((screen.getByLabelText('template_name') as HTMLInputElement).value).toBe('Weekly report');
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });

  it("opens the full editor with the own mail's recipients", async () => {
    render(<SaveAsTemplateFlow email={listRow} />);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('template_name'), { target: { value: 'Report' } });
    fireEvent.click(screen.getByRole('button', { name: 'template_edit_details' }));

    const data = JSON.parse(screen.getByTestId('form-data').textContent ?? '{}');
    expect(data).toMatchObject({ name: 'Report', subject: 'Weekly report', isHTML: true, to: ['Bob <bob@example.com>'] });
    fireEvent.click(screen.getByRole('button', { name: 'form-save' }));
    expect(useTemplateStore.getState().templates[0]).toMatchObject({ name: 'Report', category: 'Work' });
  });

  it('says which images were left out', async () => {
    client.fetchBlobArrayBuffer.mockRejectedValue(new Error('gone'));
    const warning = vi.spyOn(toast, 'warning');
    render(<SaveAsTemplateFlow email={listRow} />);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    expect(useTemplateStore.getState().templates[0].body).toBe('<p>Hello</p>');
    expect(warning).toHaveBeenCalledWith('template_saved', { message: 'images_dropped' });
  });

  it('warns that a template too large for the account stays in this browser', async () => {
    const big = { ...full, bodyValues: { 1: { value: `<p>${'Hello '.repeat(2000)}</p>` } } } as unknown as Email;
    client.getEmail.mockResolvedValue(big);
    useAuthStore.setState({ activeAccountId: 'acc' } as never);
    useAccountTemplatesStore.setState({ personal: { acc: emptyPartition() } });
    render(<SaveAsTemplateFlow email={listRow} />);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.getByTestId('quick-save-template-notice').textContent).toBe('too_large_to_sync');

    fireEvent.click(saveButton());
    expect(useAccountTemplatesStore.getState().personal.acc.templates).toHaveLength(1);
  });

  it('does not warn about a template the account can keep, or one kept in the browser anyway', async () => {
    useAuthStore.setState({ activeAccountId: 'acc' } as never);
    useAccountTemplatesStore.setState({ personal: { acc: emptyPartition() } });
    const { unmount } = render(<SaveAsTemplateFlow email={listRow} />);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.queryByTestId('quick-save-template-notice')).toBeNull();
    unmount();

    // Without account storage every template stays in the browser: nothing to warn about.
    useAccountTemplatesStore.setState({ personal: {} });
    client.getEmail.mockResolvedValue({ ...full, bodyValues: { 1: { value: `<p>${'Hello '.repeat(2000)}</p>` } } });
    render(<SaveAsTemplateFlow email={listRow} />);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.queryByTestId('quick-save-template-notice')).toBeNull();
  });

  it('closes with an error when the message cannot be read', async () => {
    client.getEmail.mockResolvedValue(null);
    const error = vi.spyOn(toast, 'error');
    render(<SaveAsTemplateFlow email={listRow} />);
    await waitFor(() => expect(error).toHaveBeenCalledWith('read_failed'));
    expect(useSaveAsTemplateStore.getState().pending).toBeNull();
    await act(async () => {});
    expect(useTemplateStore.getState().templates).toEqual([]);
  });
});
