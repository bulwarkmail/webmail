import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string, values?: Record<string, unknown>) =>
  key === 'delete_warning' ? `${key} ${values?.address}` : key === 'page' ? `${values?.page}/${values?.pages}` : key }));

const state = vi.hoisted(() => ({ client: null as unknown, account: 'session-a', slot: 1 }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: Object.assign(
  (selector: (s: { client: unknown }) => unknown) => selector({ client: state.client }),
  { getState: () => ({ client: state.client }) },
) }));
vi.mock('@/stores/account-store', () => ({ useAccountStore: (selector: (s: { activeAccountId: string }) => unknown) => selector({ activeAccountId: state.account }) }));
vi.mock('@/lib/auth/active-account-slot', () => ({ getActiveAccountSlot: () => state.slot }));
vi.mock('@/lib/stalwart/principal', () => ({ isStalwartJmapPassthroughEnabled: async () => true }));
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/lite', () => ({ IS_LITE: false }));

import { apiFetch } from '@/lib/browser-navigation';
import { bumpStoreEpoch } from '@/lib/store-epoch';
import { MaskedAddressesSection } from '@/components/settings/masked-addresses-section';

const namespaces = ['urn:stalwart:jmap', 'urn:inbuxa:jmap:registry'];
const fetchMock = vi.mocked(apiFetch);
const client = (namespace: string) => ({
  getAccountId: () => 'personal',
  hasAccountCapability: (cap: string, id: string) => cap === namespace && id === 'personal',
  getCapabilities: () => ({ 'urn:ietf:params:jmap:core': { maxObjectsInGet: 10 } }),
});
const initial = () => ({ id: 'existing', accountId: 'personal', email: 'mask@example.test', forDomain: 'https://shop.example.test', description: 'Shop', enabled: true });
const reply = (method: string, result: unknown) => new Response(JSON.stringify({ methodResponses: [[method, result, 'masked']] }));
const requests = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).methodCalls[0]);
const clipboard = vi.fn(async () => {});
let records = [initial()];
let denied: 'read' | 'create' | 'update' | 'destroy' | null = null;
let destroyReply: 'success' | 'ambiguous' | 'unsupported' = 'success';
beforeEach(() => {
  bumpStoreEpoch();
  state.client = client(namespaces[1]);
  state.account = 'session-a';
  state.slot = 1;
  records = [initial()];
  denied = null;
  destroyReply = 'success';
  clipboard.mockClear();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const [method, args] = body.methodCalls[0];
    const enabledProperty = body.using[1] === namespaces[0] ? 'enable' : 'enabled';
    if (method.endsWith('/query')) return denied === 'read' ? reply('error', { type: 'forbidden' }) :
      reply(method, { ids: records.slice(args.position, args.position + args.limit).map(r => r.id), total: records.length });
    if (method.endsWith('/get')) return reply(method, { accountId: 'personal', list: records.filter(r => args.ids.includes(r.id)).map(r => {
      // Native ordinary-user responses bind ownership at the get envelope.
      const { enabled, accountId: _owner, ...rest } = r;
      return { ...rest, [enabledProperty]: enabled };
    }) });
    if (args.destroy) {
      const id = args.destroy[0];
      if (denied === 'destroy') return reply(method, { accountId: 'personal', notDestroyed: { [id]: { type: 'forbidden' } } });
      if (destroyReply === 'ambiguous') return reply(method, { accountId: 'personal' });
      if (destroyReply === 'unsupported') return reply('error', { type: 'unknownMethod' });
      records = records.filter(r => r.id !== id);
      return reply(method, { accountId: 'personal', destroyed: [id] });
    }
    if (args.create) {
      if (denied === 'create') return reply(method, { notCreated: { new: { type: 'forbidden' } } });
      const input = args.create.new;
      records.push({ ...initial(), id: 'new', email: 'new@example.test', description: input.description, forDomain: input.forDomain, enabled: input[enabledProperty] });
      return reply(method, { created: { new: { id: 'new' } } });
    }
    const id = Object.keys(args.update)[0];
    if (denied === 'update') return reply(method, { notUpdated: { [id]: { type: 'forbidden' } } });
    const patch = args.update[id];
    records = records.map(r => r.id === id ? { ...r,
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch[enabledProperty] !== undefined ? { enabled: patch[enabledProperty] } : {}),
    } : r);
    return reply(method, { updated: { [id]: null } });
  });
});

describe('Masked Addresses Security UI', () => {
  it.each(namespaces)('loads a complete native query result without a duplicate tail request with %s', async namespace => {
    state.client = client(namespace);
    const enabledProperty = namespace === namespaces[0] ? 'enable' : 'enabled';
    fetchMock.mockImplementation(async (_url, init) => {
      const [method, args] = JSON.parse(String(init?.body)).methodCalls[0];
      if (method.endsWith('/query')) return reply(method, {
        accountId: 'personal', ids: ['existing'], total: args.calculateTotal ? 1 : undefined, position: 0,
      });
      const { accountId: _owner, enabled, ...data } = initial();
      return reply(method, { accountId: 'personal', list: [{ ...data, forDomain: null, [enabledProperty]: enabled }] });
    });
    render(<MaskedAddressesSection />);
    await screen.findByText('mask@example.test');
    expect(screen.queryByText('load_failed')).not.toBeInTheDocument();
    expect(screen.getByText(/no_website/)).toBeInTheDocument();
    expect(requests().map(([method]) => method)).toEqual(['x:MaskedEmail/query', 'x:MaskedEmail/get']);
  });
  it.each(namespaces)('lists, copies, creates, edits and toggles with %s', async namespace => {
    state.client = client(namespace);
    render(<MaskedAddressesSection />);
    await screen.findByText('mask@example.test');
    expect(requests().every(([method]: string[]) => !method.endsWith('/set'))).toBe(true);
    expect(screen.getByText(/https:\/\/shop.example.test/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'copy mask@example.test' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('mask@example.test'));
    expect(screen.queryByRole('button', { name: /delete|destroy/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'edit mask@example.test' }));
    const row = screen.getByRole('listitem');
    fireEvent.change(within(row).getByLabelText('description'), { target: { value: 'Updated shop' } });
    fireEvent.submit(within(row).getByLabelText('description').closest('form')!);
    await waitFor(() => expect(records[0].description).toBe('Updated shop'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'disable mask@example.test' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'disable mask@example.test' }));
    await screen.findByRole('button', { name: 'enable mask@example.test' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'enable mask@example.test' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'enable mask@example.test' }));
    await screen.findByRole('button', { name: 'disable mask@example.test' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'create' })).toBeEnabled());

    fireEvent.change(screen.getByLabelText('website'), { target: { value: 'https://new.example.test' } });
    const fields = screen.getAllByLabelText('description');
    fireEvent.change(fields[fields.length - 1], { target: { value: 'New site' } });
    fireEvent.click(screen.getByRole('button', { name: 'create' }));
    await screen.findByText('new@example.test');
    expect(records[1]).toMatchObject({ forDomain: 'https://new.example.test', description: 'New site', enabled: true });
    expect(requests().filter(([, args]) => args.create)).toHaveLength(1);
  });
  it.each(['create', 'update'] as const)('disables refused %s operations while retaining copy and the other operation', async operation => {
    denied = operation;
    render(<MaskedAddressesSection />);
    await screen.findByText('mask@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'edit mask@example.test' }));
    fireEvent.click(screen.getByRole('button', { name: operation === 'create' ? 'create' : 'disable mask@example.test' }));
    await waitFor(() => expect(screen.getByRole('button', { name: operation === 'create' ? 'create' : 'disable mask@example.test' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'copy mask@example.test' })).toBeEnabled();
    expect(screen.getByRole('button', { name: operation === 'create' ? 'disable mask@example.test' : 'create' })).toBeEnabled();
  });
  it('shows a read permission refusal without offering any write', async () => {
    denied = 'read';
    render(<MaskedAddressesSection />);
    await screen.findByText('forbidden');
    expect(screen.queryByRole('button', { name: 'create' })).not.toBeInTheDocument();
    expect(requests()).toHaveLength(1);
  });
  it('stays hidden when the edition does not implement the method', async () => {
    fetchMock.mockResolvedValue(reply('error', { type: 'unknownMethod' }));
    const { container } = render(<MaskedAddressesSection />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
  it('stays hidden on Stalwart Community, which refuses the Enterprise-only object (#1624)', async () => {
    fetchMock.mockResolvedValue(reply('error', { type: 'forbidden',
      description: 'This feature is only available in the Enterprise edition. Obtain your trial license at https://license.stalw.art/trial.' }));
    const { container } = render(<MaskedAddressesSection />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });
  it('renders nothing without an account management capability', () => {
    state.client = client('unsupported');
    const { container } = render(<MaskedAddressesSection />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(namespaces)('hides management actions after an empty-query unsupported get with %s', async namespace => {
    state.client = client(namespace);
    fetchMock.mockImplementation(async (_url, init) => {
      const [method] = JSON.parse(String(init?.body)).methodCalls[0];
      return method.endsWith('/query') ? reply(method, { ids: [] }) : reply('error', { type: 'unknownMethod' });
    });
    const { container } = render(<MaskedAddressesSection />);
    await waitFor(() => expect(requests().map(([method]) => method)).toEqual(['x:MaskedEmail/query', 'x:MaskedEmail/get']));
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(requests()[1][1].ids).toEqual([]);
  });
  it('clears private rows and draft fields on account switch and ignores the old response', async () => {
    const { rerender } = render(<MaskedAddressesSection />);
    await screen.findByText('mask@example.test');
    fireEvent.change(screen.getByLabelText('website'), { target: { value: 'private draft' } });
    let release!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(requests()).toHaveLength(3));
    state.client = client(namespaces[0]); // Another server can use the same JMAP account id.
    state.slot = 4;
    state.account = 'session-b';
    bumpStoreEpoch();
    records = [];
    rerender(<MaskedAddressesSection />);
    await screen.findByText('empty');
    await act(async () => { release(reply('x:MaskedEmail/query', { ids: ['existing'] })); });
    expect(screen.queryByText('mask@example.test')).not.toBeInTheDocument();
    expect(screen.getByLabelText('website')).toHaveValue('');
    // One get for the old row, one empty get proving the new account's support.
    expect(requests().filter(([method]) => method.endsWith('/get'))).toHaveLength(2);
  });
  it('shows ten collapsed rows per local page, one expanded row, and does not query on page changes', async () => {
    records = Array.from({ length: 23 }, (_, i) => ({ ...initial(), id: `m${i}`, email: `mask${i}@example.test`, description: `Site ${i}` }));
    render(<MaskedAddressesSection />);
    await screen.findByText('mask0@example.test');
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('Site 0')).toBeInTheDocument();
    expect(screen.getAllByLabelText('description')).toHaveLength(1); // Create only.
    expect(screen.queryByRole('button', { name: /delete / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'previous' })).toBeDisabled();
    const callsBeforeNavigation = requests().length;
    fireEvent.click(screen.getByRole('button', { name: 'edit mask0@example.test' }));
    expect(screen.getByRole('button', { name: 'close mask0@example.test' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'edit mask1@example.test' }));
    expect(screen.queryByRole('button', { name: 'delete mask0@example.test' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'delete mask1@example.test' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'close mask1@example.test' }));
    expect(screen.getAllByLabelText('description')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('mask10@example.test')).toBeInTheDocument();
    expect(screen.queryByText('mask0@example.test')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('3/3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'next' })).toBeDisabled();
    expect(requests()).toHaveLength(callsBeforeNavigation);
  });
});

describe('Masked Addresses confirmed deletion UI', () => {
  const openDelete = async (email = 'mask@example.test') => {
    await screen.findByText(email);
    fireEvent.click(screen.getByRole('button', { name: `edit ${email}` }));
    fireEvent.click(screen.getByRole('button', { name: `delete ${email}` }));
    return screen.findByRole('alertdialog');
  };
  it.each(namespaces)('requires confirmation, supports cancellation and refreshes only after confirmed deletion with %s', async namespace => {
    state.client = client(namespace);
    render(<MaskedAddressesSection />);
    let dialog = await openDelete();
    expect(within(dialog).getByText('delete_warning mask@example.test')).toBeInTheDocument();
    expect(requests().filter(([, args]) => args.destroy)).toHaveLength(0);
    const beforeCancel = requests().length;
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'cancel' })); });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(requests()).toHaveLength(beforeCancel);
    fireEvent.click(screen.getByRole('button', { name: 'delete mask@example.test' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'delete_confirm' }));
    await screen.findByText('deleted');
    expect(screen.queryByText('mask@example.test')).not.toBeInTheDocument();
    const writes = requests().filter(([, args]) => args.destroy);
    expect(writes).toEqual([['x:MaskedEmail/set', { accountId: 'personal', destroy: ['existing'] }, 'masked']]);
    expect(requests().map(([method]) => method)).toEqual([
      'x:MaskedEmail/query', 'x:MaskedEmail/get', 'x:MaskedEmail/set', 'x:MaskedEmail/query', 'x:MaskedEmail/get',
    ]);
  });
  it('retains the row on permission denial, disables only delete, and does not refresh', async () => {
    denied = 'destroy';
    render(<MaskedAddressesSection />);
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: 'delete_confirm' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'delete mask@example.test' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'disable mask@example.test' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'create' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'copy mask@example.test' })).toBeEnabled();
    expect(requests()).toHaveLength(3);
  });
  it('does not refresh or repeat an ambiguous delete; explicit read reconciliation removes a deleted row', async () => {
    destroyReply = 'ambiguous';
    render(<MaskedAddressesSection />);
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: 'delete_confirm' }));
    await screen.findByText('delete_unconfirmed');
    expect(screen.getByText('mask@example.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'delete mask@example.test' })).toBeDisabled();
    expect(requests()).toHaveLength(3);
    records = []; // Simulate the outcome, not another destructive operation.
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await screen.findByText('empty');
    expect(requests().filter(([, args]) => args.destroy)).toHaveLength(1);
  });
  it('disables management if the server does not support destroy', async () => {
    destroyReply = 'unsupported';
    render(<MaskedAddressesSection />);
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: 'delete_confirm' }));
    await screen.findByText('unavailable');
    expect(screen.queryByRole('button', { name: 'create' })).not.toBeInTheDocument();
    expect(requests()).toHaveLength(3);
  });
  it('does not repeat a confirmed delete when its refresh fails', async () => {
    render(<MaskedAddressesSection />);
    const dialog = await openDelete();
    fetchMock.mockImplementationOnce(async (_url, init) => {
      const [method] = JSON.parse(String(init?.body)).methodCalls[0];
      records = [];
      return reply(method, { accountId: 'personal', destroyed: ['existing'] });
    });
    fetchMock.mockRejectedValueOnce(new Error('synthetic refresh failure'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'delete_confirm' }));
    await screen.findByText('deleted_refresh_failed');
    expect(screen.getByText('load_failed')).toBeInTheDocument();
    expect(requests().filter(([, args]) => args.destroy)).toHaveLength(1);
    expect(requests()).toHaveLength(4);
  });
  it('clamps the local page after deleting the last row on the final page', async () => {
    records = Array.from({ length: 11 }, (_, i) => ({ ...initial(), id: `m${i}`, email: `mask${i}@example.test` }));
    render(<MaskedAddressesSection />);
    await screen.findByText('mask0@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    const dialog = await openDelete('mask10@example.test');
    fireEvent.click(within(dialog).getByRole('button', { name: 'delete_confirm' }));
    await screen.findByText('deleted');
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.queryByText('mask10@example.test')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'pagination' })).not.toBeInTheDocument();
  });
  it('cancels an open confirmation when switching accounts without any deletion', async () => {
    const { rerender } = render(<MaskedAddressesSection />);
    await openDelete();
    state.client = client(namespaces[0]); state.slot = 4; state.account = 'session-b'; bumpStoreEpoch(); records = [];
    rerender(<MaskedAddressesSection />);
    await screen.findByText('empty');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(requests().filter(([, args]) => args.destroy)).toHaveLength(0);
  });
  it('does not let a delayed deletion refresh or overwrite the next account', async () => {
    const { rerender } = render(<MaskedAddressesSection />);
    const dialog = await openDelete();
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'delete_confirm' }));
    await waitFor(() => expect(requests()).toHaveLength(3));
    state.client = client(namespaces[0]); state.slot = 4; state.account = 'session-b'; bumpStoreEpoch(); records = [];
    rerender(<MaskedAddressesSection />);
    await screen.findByText('empty');
    const beforeOldResponse = requests().length;
    await act(async () => { release(reply('x:MaskedEmail/set', { accountId: 'personal', destroyed: ['existing'] })); });
    expect(requests()).toHaveLength(beforeOldResponse);
    expect(screen.queryByText('deleted')).not.toBeInTheDocument();
    expect(screen.queryByText('delete_unconfirmed')).not.toBeInTheDocument();
  });
});
