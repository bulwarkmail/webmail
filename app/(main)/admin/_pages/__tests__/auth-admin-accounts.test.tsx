import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthPage } from '../auth';

// The "Additional admin accounts" list in Admin > Authentication > Admin access.

const MAIL = 'https://mail.example.com';
const OTHER = 'https://other.example.com';

let config: Record<string, { value?: unknown; source: string }>;
let patches: Array<Record<string, unknown>>;
let deletes: Array<Record<string, unknown>>;

function setConfig(over: Record<string, unknown>) {
  config = {
    stalwartAdminAccess: { value: 'auto', source: 'default' },
    jmapServerUrl: { value: MAIL, source: 'env' },
    jmapServers: { value: [], source: 'default' },
    adminAccounts: { value: [], source: 'default' },
  };
  for (const [key, value] of Object.entries(over)) config[key] = { value, source: 'admin' };
}

beforeEach(() => {
  patches = [];
  deletes = [];
  setConfig({});
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/admin/config')) {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return new Response('{"ok":true}', { status: 200 });
      }
      if (init?.method === 'DELETE') {
        deletes.push(JSON.parse(String(init.body)));
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response(JSON.stringify(config), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});

async function renderSection() {
  render(<AuthPage />);
  await screen.findByText('Additional admin accounts');
}

describe('the additional admin accounts list', () => {
  it('starts empty', async () => {
    await renderSection();
    expect(screen.getByText('No additional admin accounts.')).toBeTruthy();
    expect(screen.queryAllByTestId('admin-account-row')).toHaveLength(0);
  });

  it('adds a row on the only server and saves it', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    const row = screen.getByTestId('admin-account-row');
    expect((within(row).getByLabelText('Mail server') as HTMLSelectElement).value).toBe(MAIL);
    fireEvent.change(within(row).getByLabelText('Account'), { target: { value: ' alice@example.com ' } });

    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => expect(patches).toEqual([{ adminAccounts: [{ serverUrl: MAIL, account: 'alice@example.com' }] }]));
  });

  it('lets the admin pick one of several servers, labelled from the server list', async () => {
    setConfig({ jmapServers: [{ id: 'other', label: 'Other server', url: OTHER }] });
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    const row = screen.getByTestId('admin-account-row');
    const select = within(row).getByLabelText('Mail server') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(within(select).getByRole('option', { name: 'Other server' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: MAIL })).toBeTruthy();
    fireEvent.change(select, { target: { value: OTHER } });
    fireEvent.change(within(row).getByLabelText('Account'), { target: { value: 'bob' } });

    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => expect(patches).toEqual([{ adminAccounts: [{ serverUrl: OTHER, account: 'bob' }] }]));
  });

  it('removes a row and reverts the list', async () => {
    setConfig({ adminAccounts: [{ serverUrl: MAIL, account: 'alice' }, { serverUrl: MAIL, account: 'bob' }] });
    await renderSection();
    const rows = screen.getAllByTestId('admin-account-row');
    expect(rows).toHaveLength(2);
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove account' }));
    expect(screen.getAllByTestId('admin-account-row')).toHaveLength(1);

    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => expect(patches).toEqual([{ adminAccounts: [{ serverUrl: MAIL, account: 'bob' }] }]));

    const section = screen.getByText('Additional admin accounts').closest('div.space-y-3') as HTMLElement;
    fireEvent.click(within(section).getByRole('button', { name: 'Revert to default' }));
    await waitFor(() => expect(deletes).toEqual([{ key: 'adminAccounts' }]));
  });

  it('cannot add an account while no mail server is configured', async () => {
    setConfig({ jmapServerUrl: '' });
    await renderSection();
    expect(screen.getByText('Configure a mail server first (Settings > JMAP servers).')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add account' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('flags an entry whose server is no longer configured', async () => {
    setConfig({ adminAccounts: [{ serverUrl: OTHER, account: 'alice' }] });
    await renderSection();
    const row = screen.getByTestId('admin-account-row');
    expect(row.textContent).toContain('This server is no longer configured; the entry is ignored.');
    expect(within(row).getByRole('button', { name: 'Remove account' })).toBeTruthy();
  });

  it('says the list is ignored while Stalwart admin accounts is off', async () => {
    setConfig({ stalwartAdminAccess: 'off' });
    await renderSection();
    expect(screen.getByText('Ignored while Stalwart admin accounts is set to Off.')).toBeTruthy();
  });
});
