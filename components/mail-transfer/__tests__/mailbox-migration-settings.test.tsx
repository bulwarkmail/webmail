import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MailboxMigrationSettings } from '../mailbox-migration-settings';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountSecurityStore } from '@/stores/account-security-store';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
}));

const DAY_MS = 24 * 60 * 60 * 1000;

type Overview = Record<string, unknown>;

const overview = (over: Overview = {}): Overview => ({
  available: true,
  sources: [{ id: 'ox', name: 'Old OX', hasDav: true, hasSieve: true }],
  allowOther: false,
  forgetAfterDays: 30,
  migration: null,
  ...over,
});

const migration = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  sourceName: 'Old OX',
  progress: { messagesDone: 10, messagesTotal: 10 },
  running: false,
  forgetAt: Date.now() + 10 * DAY_MS,
  appPasswordExpiresAt: new Date(Date.now() + 10 * DAY_MS).toISOString(),
  account: {
    status: 'done',
    progress: { messagesDone: 10, messagesTotal: 10 },
    report: { counts: { messages: { copied: 10, skipped: 0, failed: 0 } }, problems: [], problemCount: 0 },
  },
  ...over,
});

interface Call { method: string; body: Record<string, unknown> | null }

let calls: Call[];
let postHandler: (body: Record<string, unknown>) => { status?: number; json: unknown };

function mockServer(initial: Overview) {
  calls = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method, body });
    if (method === 'GET') return new Response(JSON.stringify(initial), { status: 200 });
    const answer = postHandler(body!);
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posts = (action?: string) => calls.filter((c) => c.method === 'POST' && (!action || c.body?.action === action));

let createAppPassword: ReturnType<typeof vi.fn>;
let removeAppPassword: ReturnType<typeof vi.fn>;

beforeEach(() => {
  postHandler = () => ({ json: { ok: true } });
  useAuthStore.setState({ username: 'alice@example.com' } as never);
  createAppPassword = vi.fn(async () => ({ id: 'ap1', secret: 'app-secret' }));
  removeAppPassword = vi.fn(async () => {});
  useAccountSecurityStore.setState({ createAppPassword, removeAppPassword } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MailboxMigrationSettings', () => {
  it('renders nothing when the server says it is not available', async () => {
    const fetchMock = mockServer(overview({ available: false }));
    const { container } = render(<MailboxMigrationSettings />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the request is refused', async () => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })));
    const { container } = render(<MailboxMigrationSettings />);
    await Promise.resolve();
    await Promise.resolve();
    expect(container.firstChild).toBeNull();
  });

  it('hides the picker with a single source and offers no other server unless allowed', async () => {
    mockServer(overview());
    render(<MailboxMigrationSettings />);
    await screen.findByTestId('mailbox-migration-form');
    expect(screen.queryByTestId('mailbox-migration-source')).toBeNull();
    expect(screen.queryByText('other_server')).toBeNull();
    expect((screen.getByTestId('mailbox-migration-username') as HTMLInputElement).value).toBe('alice@example.com');
  });

  it('shows the picker with "Other server" when users may enter servers', async () => {
    mockServer(overview({ allowOther: true }));
    render(<MailboxMigrationSettings />);
    const picker = await screen.findByTestId('mailbox-migration-source') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['ox', 'other']);
    fireEvent.change(picker, { target: { value: 'other' } });
    expect(screen.getByTestId('mailbox-migration-other')).toBeTruthy();
  });

  it('creates an app password lasting forgetAfterDays and starts with it, never with a Stalwart password', async () => {
    mockServer(overview());
    postHandler = (body) => ({ json: body.action === 'start' ? { migration: { id: 'm1' } } : { ok: true } });
    render(<MailboxMigrationSettings />);
    await screen.findByTestId('mailbox-migration-form');
    fireEvent.change(screen.getByTestId('mailbox-migration-password'), { target: { value: 'old-pass' } });
    const before = Date.now();
    fireEvent.click(screen.getByTestId('mailbox-migration-start'));
    await waitFor(() => expect(posts('start')).toHaveLength(1));

    expect(createAppPassword).toHaveBeenCalledTimes(1);
    const input = createAppPassword.mock.calls[0][0] as { description: string; expiresAt: string };
    expect(input.description).toMatch(/^Mailbox migration \d{4}-\d{2}-\d{2}$/);
    expect(input.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const ahead = Date.parse(input.expiresAt) - before;
    expect(Math.abs(ahead - 30 * DAY_MS)).toBeLessThan(60_000);

    const body = posts('start')[0].body!;
    expect(body).toMatchObject({
      action: 'start',
      sourceId: 'ox',
      username: 'alice@example.com',
      password: 'old-pass',
      what: { mail: true, calendars: true, contacts: true, filters: true },
      appPassword: { id: 'ap1', secret: 'app-secret', expiresAt: input.expiresAt },
    });
    expect(Object.keys(body).sort()).toEqual(['action', 'appPassword', 'password', 'sourceId', 'username', 'what']);
    expect(JSON.stringify(body)).not.toMatch(/stalwart/i);
    expect(removeAppPassword).not.toHaveBeenCalled();
  });

  it('shows the app-password message and starts nothing when one cannot be created', async () => {
    mockServer(overview());
    createAppPassword.mockRejectedValueOnce(new Error('forbidden'));
    render(<MailboxMigrationSettings />);
    await screen.findByTestId('mailbox-migration-form');
    fireEvent.change(screen.getByTestId('mailbox-migration-password'), { target: { value: 'old-pass' } });
    fireEvent.click(screen.getByTestId('mailbox-migration-start'));
    expect((await screen.findByTestId('mailbox-migration-error')).textContent).toBe('errors.no_app_passwords');
    expect(posts('start')).toHaveLength(0);
  });

  it('removes the new app password when the start is refused', async () => {
    mockServer(overview());
    postHandler = () => ({ status: 409, json: { error: 'busy', code: 'active-exists' } });
    render(<MailboxMigrationSettings />);
    await screen.findByTestId('mailbox-migration-form');
    fireEvent.change(screen.getByTestId('mailbox-migration-password'), { target: { value: 'old-pass' } });
    fireEvent.click(screen.getByTestId('mailbox-migration-start'));
    expect((await screen.findByTestId('mailbox-migration-error')).textContent).toBe('errors.active_exists');
    expect(removeAppPassword).toHaveBeenCalledWith('ap1');
  });

  it('renews the app password when a pass asks for it', async () => {
    mockServer(overview({ migration: migration() }));
    postHandler = (body) => ({ json: body.action === 'pass' && !body.appPassword ? { renew: true } : { queued: 1 } });
    render(<MailboxMigrationSettings />);
    fireEvent.click(await screen.findByTestId('mailbox-migration-pass'));
    await waitFor(() => expect(posts('pass')).toHaveLength(2));
    expect(posts('pass')[0].body).toEqual({ action: 'pass' });
    expect(createAppPassword).toHaveBeenCalledTimes(1);
    const second = posts('pass')[1].body as { appPassword: { id: string; secret: string; expiresAt: string } };
    expect(second.appPassword).toMatchObject({ id: 'ap1', secret: 'app-secret' });
    expect(Math.abs(Date.parse(second.appPassword.expiresAt) - Date.now() - 30 * DAY_MS)).toBeLessThan(60_000);
  });

  it('renews up front when the stored app password expires within a day', async () => {
    mockServer(overview({ migration: migration({ appPasswordExpiresAt: new Date(Date.now() + 3600_000).toISOString() }) }));
    postHandler = () => ({ json: { queued: 1 } });
    render(<MailboxMigrationSettings />);
    fireEvent.click(await screen.findByTestId('mailbox-migration-pass'));
    await waitFor(() => expect(posts('pass')).toHaveLength(1));
    expect(posts('pass')[0].body).toHaveProperty('appPassword.id', 'ap1');
  });

  it('shows status, progress and the deletion date of a running migration', async () => {
    mockServer(overview({
      migration: migration({
        running: true,
        account: {
          status: 'paused',
          pausedUntil: Date.now() + 3600_000,
          progress: { messagesDone: 1234, messagesTotal: 5678 },
          report: { counts: {}, problems: [], problemCount: 0 },
        },
      }),
    }));
    render(<MailboxMigrationSettings />);
    expect((await screen.findByTestId('mailbox-migration-state')).textContent).toBe('status.paused');
    expect(screen.getByText(/^progress /).textContent).toContain('"done":"1,234","total":"5,678"');
    expect(screen.getByText(/^paused_until /)).toBeTruthy();
    expect(screen.getByText(/^forget_at /)).toBeTruthy();
    expect(screen.getByTestId('mailbox-migration-cancel')).toBeTruthy();
    expect(screen.queryByTestId('mailbox-migration-pass')).toBeNull();
    expect(screen.queryByTestId('mailbox-migration-form')).toBeNull();
  });
});
