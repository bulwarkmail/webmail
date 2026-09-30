import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinkDeviceSection, AccountSecuritySettings } from '../account-security-settings';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';
import { useAccountSecurityStore } from '@/stores/account-security-store';
import { useAuthStore } from '@/stores/auth-store';

const mocks = vi.hoisted(() => ({
  lite: { value: false },
  oauthEnabled: { value: false },
  apiFetch: vi.fn(),
  toDataURL: vi.fn(async () => 'data:image/png;base64,QR'),
}));

// A stable `t` (keys come back as-is) that also has `t.raw` for the
// "not available" note.
vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { raw: (key: string) => key });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

vi.mock('@/lib/lite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lite')>();
  return {
    ...actual,
    get IS_LITE() {
      return mocks.lite.value;
    },
  };
});

vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  apiFetch: mocks.apiFetch,
  getPathPrefix: () => '',
}));

vi.mock('qrcode', () => ({ default: { toDataURL: mocks.toDataURL } }));

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({ oauthEnabled: mocks.oauthEnabled.value }),
}));

interface Reply {
  status: number;
  body: unknown;
}

const OK = (code = 'CODE-1', statusId = 'st-1', expiresIn = 120): Reply => ({
  status: 200,
  body: { pairing_code: code, status_id: statusId, expires_in: expiresIn },
});
const ERR = (status: number, error: string): Reply => ({ status, body: { error } });

let createReplies: Reply[] = [];
let pairStatus = 'pending';
let ssoStartStatus = 200;

function reply({ status, body }: Reply) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function callsTo(prefix: string) {
  return mocks.apiFetch.mock.calls.filter(([url]) => String(url).startsWith(prefix));
}
const createBodies = () =>
  callsTo('/api/auth/pair/create').map(([, init]) => JSON.parse((init as RequestInit).body as string));
const ssoBodies = () =>
  callsTo('/api/auth/sso/start').map(([, init]) => JSON.parse((init as RequestInit).body as string));
const statusCalls = () => callsTo('/api/auth/pair/status');

function setAccount(providerSession?: boolean) {
  const entry = {
    id: 'me@example.com@mail.example.com',
    label: 'me@example.com',
    serverUrl: 'https://mail.example.com',
    username: 'me@example.com',
    authMode: providerSession ? 'oauth' : 'basic',
    cookieSlot: 2,
    rememberMe: false,
    providerSession,
    displayName: '',
    email: 'me@example.com',
    avatarColor: '#000000',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: true,
  } as AccountEntry;
  useAccountStore.setState({ accounts: [entry], activeAccountId: entry.id });
}

const origin = () => window.location.origin;
const expectedBase = () => ({
  slot: 2,
  webmail_base: origin(),
  redirect_uri: `${origin()}/en/auth/callback`,
});
const announcement = (container: HTMLElement) =>
  container.querySelector('p.sr-only[aria-live="polite"]')?.textContent ?? '';

function clickGenerate() {
  fireEvent.click(screen.getByRole('button', { name: 'link_device.generate' }));
}

async function submitPassword(password: string, totp?: string) {
  fireEvent.change(await screen.findByLabelText('password.current'), { target: { value: password } });
  if (totp !== undefined) {
    fireEvent.change(screen.getByLabelText('totp.verification_code'), { target: { value: totp } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'link_device.continue' }));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createReplies = [];
  pairStatus = 'pending';
  ssoStartStatus = 200;
  mocks.lite.value = false;
  mocks.oauthEnabled.value = false;
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/auth/pair/create') {
      return reply(createReplies.shift() ?? ERR(500, 'unexpected_call'));
    }
    if (url.startsWith('/api/auth/pair/status')) return reply({ status: 200, body: { status: pairStatus } });
    // A fragment-only URL keeps jsdom from attempting a real navigation.
    if (url === '/api/auth/sso/start') return reply({ status: ssoStartStatus, body: { authorize_url: '#idp', state: 'sso-state-1' } });
    throw new Error(`unexpected fetch ${url}`);
  });
  sessionStorage.clear();
  useAccountSecurityStore.setState({ otpEnabled: false });
  setAccount(false);
});

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('LinkDeviceSection step-up', () => {
  it('offers single sign-on from the password form when the server has it', async () => {
    mocks.oauthEnabled.value = true;
    createReplies = [ERR(401, 'reauth_required')];
    render(<LinkDeviceSection />);
    clickGenerate();

    fireEvent.click(await screen.findByRole('button', { name: 'link_device.use_sso' }));
    await waitFor(() => expect(ssoBodies()).toHaveLength(1));
    expect(ssoBodies()[0]).toMatchObject({ purpose: 'reauth', slot: 2 });
    expect(sessionStorage.getItem('pair_reauth_resume')).toBe('sso-state-1');
  });

  it('leaves no re-auth flag behind when the IdP round trip cannot start', async () => {
    mocks.oauthEnabled.value = true;
    ssoStartStatus = 500;
    createReplies = [ERR(401, 'reauth_required')];
    render(<LinkDeviceSection />);
    clickGenerate();

    fireEvent.click(await screen.findByRole('button', { name: 'link_device.use_sso' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('link_device.error');
    expect(sessionStorage.getItem('pair_reauth_resume')).toBeNull();
  });

  it('shows no single sign-on option without it', async () => {
    createReplies = [ERR(401, 'reauth_required')];
    render(<LinkDeviceSection />);
    clickGenerate();

    await screen.findByLabelText('password.current');
    expect(screen.queryByRole('button', { name: 'link_device.use_sso' })).toBeNull();
  });

  it('asks a password account for its password when the server wants a step-up', async () => {
    createReplies = [ERR(401, 'reauth_required')];
    render(<LinkDeviceSection />);
    clickGenerate();

    const password = await screen.findByLabelText('password.current');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByText('link_device.password_prompt')).toBeInTheDocument();
    expect(screen.queryByLabelText('totp.verification_code')).toBeNull();
    expect(createBodies()).toEqual([expectedBase()]);
    expect(ssoBodies()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'link_device.show_password' }));
    expect(password).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'app_passwords.cancel' }));
    expect(screen.queryByLabelText('password.current')).toBeNull();
    expect(screen.getByRole('button', { name: 'link_device.generate' })).toBeInTheDocument();
  });

  it('sends the password with webmail_base and shows the QR and sign-in link', async () => {
    createReplies = [ERR(401, 'reauth_required'), OK('ABC 123')];
    render(<LinkDeviceSection />);
    clickGenerate();
    await submitPassword('hunter2');

    const img = await screen.findByAltText('link_device.qr_alt');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,QR');
    expect(createBodies()[1]).toEqual({ ...expectedBase(), password: 'hunter2' });

    const link = `bulwarkmail://pair?server=${encodeURIComponent(origin())}&code=${encodeURIComponent('ABC 123')}`;
    expect(mocks.toDataURL).toHaveBeenCalledWith(link, expect.anything());
    expect(screen.getByLabelText('link_device.link_label')).toHaveValue(link);
    expect(screen.getByText('link_device.instructions')).toBeInTheDocument();
    expect(screen.getByText('link_device.copy_hint')).toBeInTheDocument();
    expect(screen.getByText('link_device.expires_in')).toBeInTheDocument();
    // The password form (and the password in it) is gone.
    expect(screen.queryByLabelText('password.current')).toBeNull();

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'link_device.copy_link' }));
    expect(writeText).toHaveBeenCalledWith(link);
    expect(await screen.findByText('link_device.copied')).toBeInTheDocument();
  });

  it('sends an identity-provider account back to the IdP instead of asking for a password', async () => {
    setAccount(true);
    createReplies = [ERR(401, 'reauth_required')];
    render(<LinkDeviceSection />);
    clickGenerate();

    await waitFor(() => expect(ssoBodies()).toHaveLength(1));
    expect(ssoBodies()[0]).toMatchObject({
      purpose: 'reauth',
      slot: 2,
      locale: 'en',
      redirect_uri: `${origin()}/en/auth/callback`,
    });
    expect(sessionStorage.getItem('pair_reauth_resume')).toBe('sso-state-1');
    expect(screen.queryByLabelText('password.current')).toBeNull();
  });

  it('does not bounce to the IdP again right after an IdP re-auth', async () => {
    setAccount(true);
    sessionStorage.setItem('pair_reauth_done', '1');
    createReplies = [ERR(401, 'reauth_required')];
    render(<LinkDeviceSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('link_device.error');
    expect(createBodies()).toEqual([expectedBase()]);
    expect(ssoBodies()).toEqual([]);
    expect(sessionStorage.getItem('pair_reauth_done')).toBeNull();
  });

  it('keeps the IdP resume when the section is remounted before the code arrives', async () => {
    setAccount(true);
    sessionStorage.setItem('pair_reauth_done', '1');
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    createReplies = [OK('CODE-LOST'), OK('CODE-SHOWN')]; // whichever lands on the mounted section
    const firstReply = mocks.apiFetch.getMockImplementation()!;
    mocks.apiFetch.mockImplementationOnce(async (url: string, init?: RequestInit) => {
      await held;
      return firstReply(url, init);
    });

    // The Security tab unmounts the section while it probes the server.
    const first = render(<LinkDeviceSection />);
    first.unmount();
    release();
    expect(sessionStorage.getItem('pair_reauth_done')).toBe('1');

    render(<LinkDeviceSection />);
    const link = (await screen.findByLabelText('link_device.link_label')) as HTMLInputElement;
    expect(link.value).toMatch(/^bulwarkmail:\/\/pair\?server=.+&code=CODE-(LOST|SHOWN)$/);
    expect(sessionStorage.getItem('pair_reauth_done')).toBeNull();
    expect(ssoBodies()).toEqual([]);
  });

  it('reveals the TOTP field on totp_required and blames password or code after a failed code', async () => {
    createReplies = [
      ERR(401, 'reauth_required'),
      ERR(401, 'totp_required'),
      ERR(401, 'totp_required'),
      OK(),
    ];
    render(<LinkDeviceSection />);
    clickGenerate();
    await submitPassword('hunter2');

    const totp = await screen.findByLabelText('totp.verification_code');
    expect(totp).toHaveAttribute('inputmode', 'numeric');
    expect(totp).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByRole('status')).toHaveTextContent('link_device.totp_prompt');
    expect(screen.getByLabelText('password.current')).toHaveValue('hunter2');
    expect(createBodies()[1]).toEqual({ ...expectedBase(), password: 'hunter2' });

    fireEvent.change(totp, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'link_device.continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('link_device.error_password_or_code');
    expect(createBodies()[2]).toEqual({ ...expectedBase(), password: 'hunter2', totp: '000000' });
    expect(screen.getByLabelText('totp.verification_code')).toHaveValue('');

    fireEvent.change(screen.getByLabelText('totp.verification_code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'link_device.continue' }));
    await screen.findByAltText('link_device.qr_alt');
    expect(createBodies()[3]).toEqual({ ...expectedBase(), password: 'hunter2', totp: '123456' });
  });

  it('shows the TOTP field up front when two-factor auth is on', async () => {
    useAccountSecurityStore.setState({ otpEnabled: true });
    createReplies = [ERR(401, 'reauth_required'), OK()];
    render(<LinkDeviceSection />);
    clickGenerate();

    fireEvent.change(await screen.findByLabelText('password.current'), { target: { value: 'hunter2' } });
    const continueButton = screen.getByRole('button', { name: 'link_device.continue' });
    expect(continueButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('totp.verification_code'), { target: { value: '654321' } });
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);

    await screen.findByAltText('link_device.qr_alt');
    expect(createBodies()[1]).toEqual({ ...expectedBase(), password: 'hunter2', totp: '654321' });
  });

  it('says the password is wrong on invalid_credentials and clears it', async () => {
    createReplies = [ERR(401, 'reauth_required'), ERR(401, 'invalid_credentials')];
    render(<LinkDeviceSection />);
    clickGenerate();
    await submitPassword('wrong');

    expect(await screen.findByRole('alert')).toHaveTextContent('link_device.error_wrong_password');
    expect(screen.getByLabelText('password.current')).toHaveValue('');
  });

  it.each([
    [401, 'not_signed_in', 'link_device.error_not_signed_in'],
    [403, 'impersonation', 'link_device.error_impersonation'],
    [429, 'too_many_attempts', 'link_device.error_too_many_attempts'],
    [500, 'session_secret_required', 'link_device.error_session_secret'],
    [502, 'server_unreachable', 'link_device.error_server_unreachable'],
    [502, 'pairing_unavailable', 'link_device.error_pairing_unavailable'],
    [400, 'insecure_server', 'link_device.error_insecure_server'],
    [400, 'invalid_request', 'link_device.error'],
    [500, 'something_else', 'link_device.error'],
  ])('maps %i %s to %s', async (status, error, key) => {
    createReplies = [ERR(status, error)];
    render(<LinkDeviceSection />);
    clickGenerate();
    expect(await screen.findByRole('alert')).toHaveTextContent(new RegExp(`^${key}$`));
  });

  it('shows the generic error when the request fails outright', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<LinkDeviceSection />);
    clickGenerate();
    expect(await screen.findByRole('alert')).toHaveTextContent(/^link_device\.error$/);
  });
});

describe('LinkDeviceSection status polling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('swaps the QR for a success panel once the phone redeems the code, then stops polling', async () => {
    createReplies = [OK('C1', 'st-9'), ERR(401, 'reauth_required')];
    const { container } = render(<LinkDeviceSection />);
    clickGenerate();
    await screen.findByAltText('link_device.qr_alt');

    await advance(2000);
    expect(statusCalls()).toHaveLength(1);
    expect(statusCalls()[0][0]).toBe('/api/auth/pair/status?id=st-9');
    expect(screen.getByAltText('link_device.qr_alt')).toBeInTheDocument();

    pairStatus = 'redeemed';
    await advance(2000);
    await waitFor(() => expect(screen.getByText('link_device.success_body')).toBeInTheDocument());
    expect(screen.queryByAltText('link_device.qr_alt')).toBeNull();
    expect(announcement(container)).toBe('link_device.success_title');

    const polled = statusCalls().length;
    await advance(6000);
    expect(statusCalls()).toHaveLength(polled);

    // "Link another device" mints again; the used grant means a new step-up.
    fireEvent.click(screen.getByRole('button', { name: 'link_device.link_another' }));
    expect(await screen.findByLabelText('password.current')).toBeInTheDocument();
    expect(createBodies()[1]).toEqual(expectedBase());
  });

  it('offers a new code when the server reports the code expired', async () => {
    createReplies = [OK('C1', 'st-1'), OK('C2', 'st-2')];
    const { container } = render(<LinkDeviceSection />);
    clickGenerate();
    await screen.findByAltText('link_device.qr_alt');

    pairStatus = 'expired';
    await advance(2000);
    await waitFor(() => expect(announcement(container)).toBe('link_device.expired'));
    expect(screen.queryByAltText('link_device.qr_alt')).toBeNull();

    pairStatus = 'pending';
    fireEvent.click(screen.getByRole('button', { name: 'link_device.regenerate' }));
    await screen.findByAltText('link_device.qr_alt');
    // Tried without a password first: the server may still hold a live grant.
    expect(createBodies()[1]).toEqual(expectedBase());

    await advance(2000);
    expect(statusCalls().at(-1)?.[0]).toBe('/api/auth/pair/status?id=st-2');
  });

  it('treats an unknown status id as expired', async () => {
    createReplies = [OK()];
    const { container } = render(<LinkDeviceSection />);
    clickGenerate();
    await screen.findByAltText('link_device.qr_alt');

    pairStatus = 'unknown';
    await advance(2000);
    await waitFor(() => expect(announcement(container)).toBe('link_device.expired'));
    expect(screen.getByRole('button', { name: 'link_device.regenerate' })).toBeInTheDocument();
  });

  it('expires the code when the countdown runs out', async () => {
    createReplies = [OK('C1', 'st-1', 3)];
    const { container } = render(<LinkDeviceSection />);
    clickGenerate();
    await screen.findByAltText('link_device.qr_alt');

    await advance(3000);
    await waitFor(() => expect(announcement(container)).toBe('link_device.expired'));
    expect(screen.queryByAltText('link_device.qr_alt')).toBeNull();
  });

  it('stops polling on unmount', async () => {
    createReplies = [OK()];
    const { unmount } = render(<LinkDeviceSection />);
    clickGenerate();
    await screen.findByAltText('link_device.qr_alt');

    unmount();
    await advance(6000);
    expect(statusCalls()).toHaveLength(0);
  });
});

describe('AccountSecuritySettings link-device visibility', () => {
  beforeEach(() => {
    useAuthStore.setState({ isAuthenticated: false, authMode: 'basic', client: null });
  });

  it('shows the linker to password accounts on servers without account management', () => {
    useAccountSecurityStore.setState({ isStalwart: false, isProbing: false });
    render(<AccountSecuritySettings />);
    expect(screen.getByText('link_device.title')).toBeInTheDocument();
    expect(screen.getByText('not_available')).toBeInTheDocument();
  });

  it('shows the linker to password accounts on Stalwart, without the OAuth-only email client box', () => {
    useAccountSecurityStore.setState({ isStalwart: true, isProbing: false });
    render(<AccountSecuritySettings />);
    expect(screen.getByText('link_device.title')).toBeInTheDocument();
    expect(screen.queryByText('email_client.title')).toBeNull();
  });

  it('mounts the linker only once the server probe has a verdict', () => {
    // A layout guessed before the verdict remounted the linker afterwards and
    // threw away a QR that was already showing.
    useAuthStore.setState({ isAuthenticated: true, authMode: 'oauth', client: null });
    useAccountSecurityStore.setState({ isStalwart: null, isProbing: false });
    const { rerender } = render(<AccountSecuritySettings />);
    expect(screen.queryByText('link_device.title')).toBeNull();
    expect(screen.getByText('detecting')).toBeInTheDocument();

    act(() => useAccountSecurityStore.setState({ isStalwart: false }));
    rerender(<AccountSecuritySettings />);
    expect(screen.getByText('link_device.title')).toBeInTheDocument();
  });

  it('hides the linker in Bulwark Lite', () => {
    mocks.lite.value = true;
    useAccountSecurityStore.setState({ isStalwart: false, isProbing: false });
    render(<AccountSecuritySettings />);
    expect(screen.queryByText('link_device.title')).toBeNull();
    expect(screen.getByText('not_available')).toBeInTheDocument();
  });
});
