import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicAccount, PublicMigration } from '@/lib/migration/service';
import type { PublicSource } from '@/lib/migration/types';
import { DEFAULT_OPTIONS } from '@/lib/migration/types';
import { MigrationPage } from '../migration';

// Admin > Mailbox migration (#1760).

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast, useToastStore: () => [] }));

const NOTICE = 'Bulk migration needs the Stalwart master user. Set BULWARK_STALWART_MASTER_USER and BULWARK_STALWART_MASTER_PASSWORD.';

const source = (over: Partial<PublicSource> = {}): PublicSource => ({
  id: 'src1',
  name: 'Old mail server',
  imap: { host: 'imap.old.example', port: 993, security: 'tls' },
  allowSelfService: false,
  ...over,
});

const migration = (over: Partial<PublicMigration> = {}): PublicMigration => ({
  id: 'mig1',
  kind: 'bulk',
  startedBy: 'admin',
  sourceName: 'Old mail server',
  what: { mail: true, contacts: true, calendars: true, filters: true },
  createdAt: Date.UTC(2026, 10, 1),
  lastPassAt: Date.UTC(2026, 10, 1),
  forgetAt: Date.UTC(2026, 11, 1),
  accountCount: 2,
  statusCounts: { done: 1, failed: 1 },
  progress: { messagesDone: 1234, messagesTotal: 5678 },
  running: false,
  ...over,
});

const account = (over: Partial<PublicAccount> = {}): PublicAccount => {
  const counts = () => ({ copied: 0, skipped: 0, failed: 0 });
  return {
    key: 'a1',
    sourceUser: 'alice',
    target: 'alice@example.com',
    status: 'done',
    progress: { messagesDone: 0, messagesTotal: 0 },
    report: { counts: { messages: counts(), folders: counts(), contacts: counts(), events: counts(), scripts: counts() }, problems: [], problemCount: 0 },
    passes: 1,
    passwordSaved: true,
    ...over,
  };
};

let overview: { masterConfigured: boolean; sources: PublicSource[]; options: typeof DEFAULT_OPTIONS; migrations: PublicMigration[] };
let gets: string[];
let posts: Array<Record<string, unknown>>;
let postAnswer: (body: Record<string, unknown>) => Response;

beforeEach(() => {
  overview = { masterConfigured: true, sources: [source()], options: { ...DEFAULT_OPTIONS }, migrations: [] };
  gets = [];
  posts = [];
  postAnswer = () => new Response('{}', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    expect(url).toContain('/api/admin/migration');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      return postAnswer(body);
    }
    gets.push(url);
    if (url.includes('migration=')) {
      return new Response(JSON.stringify({ total: 1, accounts: [account()] }), { status: 200 });
    }
    return new Response(JSON.stringify(overview), { status: 200 });
  }));
});

async function renderPage() {
  render(<MigrationPage />);
  await screen.findByRole('button', { name: /New migration/ });
}

describe('the mailbox migration page', () => {
  it('without the master user says so and only blocks new migrations', async () => {
    overview.masterConfigured = false;
    overview.sources = [];
    await renderPage();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect((screen.getByRole('button', { name: /New migration/ }) as HTMLButtonElement).disabled).toBe(true);
    const add = screen.getByRole('button', { name: /Add source/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(screen.getByTestId('migration-source-form')).toBeTruthy();
    expect((screen.getByLabelText('Accounts copied at the same time') as HTMLInputElement).disabled).toBe(false);
  });

  it('shows a saved admin password as Saved and keeps it on save', async () => {
    overview.sources = [source({ adminLogin: { username: 'oxadmin', format: '{user}*{admin}', passwordSaved: true } })];
    postAnswer = (body) => new Response(JSON.stringify({ source: body.source }), { status: 200 });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    const form = screen.getByTestId('migration-source-form');
    expect(within(form).getByText('Saved')).toBeTruthy();
    expect(within(form).getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(form.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const sent = posts[0];
    expect(sent.action).toBe('save-source');
    const login = (sent.source as { adminLogin: Record<string, unknown> }).adminLogin;
    expect(login).toEqual({ username: 'oxadmin', format: '{user}*{admin}' });
    expect('password' in login).toBe(false);
    expect((sent.source as { id: string }).id).toBe('src1');
  });

  it('sends a changed admin password', async () => {
    overview.sources = [source({ adminLogin: { username: 'oxadmin', format: '{user}*{admin}', passwordSaved: true } })];
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    const form = screen.getByTestId('migration-source-form');
    fireEvent.click(within(form).getByRole('button', { name: 'Change' }));
    fireEvent.change(within(form).getByLabelText('Password'), { target: { value: 'n3w' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect((posts[0].source as { adminLogin: Record<string, unknown> }).adminLogin.password).toBe('n3w');
  });

  it('lists the bad rows of a list and starts nothing', async () => {
    postAnswer = () => new Response(JSON.stringify({ problems: [{ row: 3, reason: 'target_account: no such account.' }] }), { status: 422 });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /New migration/ }));
    const dialog = await screen.findByTestId('migration-new-dialog');
    fireEvent.change(within(dialog).getByLabelText('Accounts (CSV)'), {
      target: { value: 'source_user,target_account,source_password\nalice,alice@example.com,a\nbob,nobody@example.com,b\n' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(await within(dialog).findByText('Row 3: target_account: no such account.')).toBeTruthy();
    expect(posts.map((p) => p.action)).toEqual(['start-bulk']);
    expect(posts[0]).toMatchObject({ sourceId: 'src1', what: { mail: true, contacts: true, calendars: true, filters: true } });
    // Still open, nothing reloaded, and no second try while the rows are bad.
    expect(screen.getByTestId('migration-new-dialog')).toBeTruthy();
    expect(gets).toHaveLength(1);
    expect((within(dialog).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a migration with its progress and password deadline', async () => {
    overview.migrations = [migration({ kind: 'self', startedBy: 'carol@example.com', customHosts: ['imap.carol.example:993'] })];
    await renderPage();
    const row = screen.getByTestId('migration-row');
    expect(row.textContent).toContain('Started by the user');
    expect(row.textContent).toContain('carol@example.com');
    expect(row.textContent).toContain('imap.carol.example:993');
    expect(row.textContent).toContain(`${(1234).toLocaleString()} of ${(5678).toLocaleString()} messages`);
    expect(row.textContent).toContain('Stored passwords are deleted on');
    expect(row.textContent).toContain('Copies what is new on the old server. Deleted messages and changed flags are not carried over.');
    expect(within(row).getByRole('link', { name: /Download report/ }).getAttribute('href')).toBe('/api/admin/migration/report?migration=mig1');
  });

  it('shows the error of a refused pass', async () => {
    const expired = "The user's access for this migration expired. The user can start a new pass in Settings.";
    overview.migrations = [migration()];
    postAnswer = () => new Response(JSON.stringify({ error: expired, code: 'user-access-expired' }), { status: 409 });
    await renderPage();
    fireEvent.click(within(screen.getByTestId('migration-row')).getByRole('button', { name: 'Copy new items' }));
    await waitFor(() => expect(posts).toEqual([{ action: 'pass', migrationId: 'mig1' }]));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expired));
  });

  it('asks the server for the accounts with the search and status filter', async () => {
    overview.migrations = [migration()];
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Show accounts/ }));
    await screen.findByTestId('migration-account-row');
    const accountGets = () => gets.filter((u) => u.includes('migration=mig1'));
    expect(accountGets()[0]).toContain('offset=0');
    expect(accountGets()[0]).toContain('limit=50');
    fireEvent.change(screen.getByLabelText('Search accounts'), { target: { value: 'alice' } });
    await waitFor(() => expect(accountGets().some((u) => u.includes('q=alice'))).toBe(true));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    await waitFor(() => expect(accountGets().some((u) => u.includes('q=alice') && u.includes('status=failed'))).toBe(true));
  });
});
