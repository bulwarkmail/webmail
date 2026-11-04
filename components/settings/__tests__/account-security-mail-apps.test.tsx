import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountSecuritySettings } from '../account-security-settings';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';
import { useAccountSecurityStore } from '@/stores/account-security-store';
import { useAuthStore } from '@/stores/auth-store';

// settings-12: "Email client setup" showed only a "JMAP username", which no
// Thunderbird or Outlook asks for. The section now lists the IMAP, SMTP,
// CalDAV and CardDAV settings the server's autoconfig names, with Copy
// buttons; the rarely needed app password fields wait behind "More options";
// the two-step switch carries no "Disabled" word beside it.

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
    { raw: (key: string) => key, rich: (key: string) => key, has: () => true },
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({ oauthEnabled: false }),
}));

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const AUTOCONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <domain>example.com</domain>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>me@example.com</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>me@example.com</username>
    </outgoingServer>
  </emailProvider>
  <calendar type="caldav"><serverURL>https://mail.example.com/dav/cal</serverURL></calendar>
  <addressBook type="carddav"><serverURL>https://mail.example.com/dav/card</serverURL></addressBook>
</clientConfig>`;

function signIn() {
  const entry = {
    id: 'me@example.com@mail.example.com',
    label: 'me@example.com',
    serverUrl: 'https://mail.example.com',
    username: 'me@example.com',
    authMode: 'basic',
    cookieSlot: 0,
    rememberMe: false,
    providerSession: false,
    displayName: '',
    email: 'me@example.com',
    avatarColor: '#000000',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: true,
  } as AccountEntry;
  useAccountStore.setState({ accounts: [entry], activeAccountId: entry.id });
  const client = {
    getUsername: () => 'me@example.com',
    getServerUrl: () => 'https://mail.example.com',
    getAccountId: () => 'a1',
  };
  useAuthStore.setState({ isAuthenticated: true, authMode: 'basic', client: client as never, activeAccountId: entry.id });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useAccountSecurityStore.setState({
    isStalwart: true, isProbing: false, otpEnabled: false, isSaving: false,
    // Keep the store's own server probes away from the fake client.
    probe: vi.fn().mockResolvedValue(undefined),
    fetchAuthInfo: vi.fn().mockResolvedValue(undefined),
    fetchAll: vi.fn().mockResolvedValue(undefined),
    fetchPublicKeys: vi.fn().mockResolvedValue(undefined),
    fetchCryptoInfo: vi.fn().mockResolvedValue(undefined),
    fetchPrincipal: vi.fn().mockResolvedValue(undefined),
  } as never);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Use your mail in other apps', () => {
  it('lists the IMAP, SMTP, CalDAV and CardDAV settings the server names', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('/autoconfig/') ? new Response(AUTOCONFIG, { status: 200 }) : new Response('{}', { status: 404 })));
    signIn();
    render(<AccountSecuritySettings />);

    await waitFor(() => expect(screen.getByDisplayValue('imap.example.com')).toBeInTheDocument());
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      'https://mail.example.com/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=me%40example.com',
    );
    expect(screen.getByDisplayValue('smtp.example.com')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://mail.example.com/dav/cal')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://mail.example.com/dav/card')).toBeInTheDocument();
    expect(screen.getByDisplayValue('me@example.com')).toBeInTheDocument();
    expect(screen.getByText(`port_security:${JSON.stringify({ port: 993, security: 'security_ssl' })}`)).toBeInTheDocument();
    expect(screen.getByText(`port_security:${JSON.stringify({ port: 587, security: 'security_starttls' })}`)).toBeInTheDocument();
    expect(screen.getAllByTestId('mail-apps-row')).toHaveLength(5);
    expect(screen.queryByTestId('mail-apps-not-found')).toBeNull();
  });

  it('shows the user name and says so when the server names nothing', async () => {
    fetchMock.mockResolvedValue(new Response('not here', { status: 404 }));
    signIn();
    render(<AccountSecuritySettings />);

    await waitFor(() => expect(screen.getByTestId('mail-apps-not-found')).toBeInTheDocument());
    expect(screen.getAllByTestId('mail-apps-row')).toHaveLength(1);
    expect(screen.getByDisplayValue('me@example.com')).toBeInTheDocument();
  });

  it('keeps expiry and allowed addresses behind More options', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    signIn();
    render(<AccountSecuritySettings />);
    fireEvent.click(screen.getAllByText('app_passwords.new')[0]);

    expect(screen.queryByText('app_passwords.expires_label')).toBeNull();
    expect(screen.queryByText('app_passwords.allowed_ips_label')).toBeNull();
    const more = screen.getByRole('button', { name: /more_options/ });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    expect(screen.getByText('app_passwords.expires_label')).toBeInTheDocument();
    expect(screen.getByText('app_passwords.allowed_ips_label')).toBeInTheDocument();
  });

  it('shows no "Disabled" word next to the two-step switch', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    signIn();
    render(<AccountSecuritySettings />);
    await waitFor(() => expect(screen.getByTestId('mail-apps-not-found')).toBeInTheDocument());
    expect(screen.queryByText('totp.inactive')).toBeNull();
  });
});
