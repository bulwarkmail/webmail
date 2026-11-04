import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The desktop app with a mail server of one's own: email first, the server found
// from it, and "Sign in with your browser" as the main button. When the button
// needs something, it says so where that goes.

// Stubbed, so the flag doesn't stay set for the next file in this worker.
vi.hoisted(() => { vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1'); });

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({
    appName: 'Bulwark',
    isLoading: false,
    error: null,
    jmapServerUrl: '',
    jmapServers: [],
    oauthEnabled: false,
    oauthOnly: false,
    allowCustomJmapEndpoint: true,
    desktopBrowserSignIn: true,
    loginShowHeading: true,
  }),
}));
const runDesktopBrowserSignIn = vi.hoisted(() => vi.fn(async (_options: { serverUrl: string }) => ({ kind: 'cancelled' as const })));
vi.mock('@/lib/desktop/browser-sign-in', () => ({
  browserSignInAvailable: () => true,
  cancelBrowserSignIn: () => {},
  runDesktopBrowserSignIn,
  runInstanceBrowserSignIn: vi.fn(),
}));

const { default: LoginPage } = await import('../page');

let found: Record<string, string | null>;

beforeEach(() => {
  found = {};
  runDesktopBrowserSignIn.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/discover-server')) {
      const domain = (JSON.parse(String(init?.body)).email as string).split('@')[1];
      return new Response(JSON.stringify({ serverUrl: found[domain] ?? null }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const browserButton = () => screen.findByTestId('desktop-browser-sign-in', {}, { timeout: 10000 });
const email = () => document.getElementById('username') as HTMLInputElement;
const serverField = () => document.getElementById('jmap-endpoint') as HTMLInputElement | null;

describe('the desktop app, with a server of one\'s own', () => {
  it('puts the email address before the browser button', async () => {
    render(<LoginPage />);
    const button = await browserButton();
    expect(email().compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(serverField()).toBeNull();
    // No website to allow in the app: no CORS hint at all.
    expect(screen.queryByTestId('login-server-trouble')).toBeNull();
  }, 30_000);

  it('makes "Sign in" the main button once a password is typed', async () => {
    render(<LoginPage />);
    const button = await browserButton();
    const submit = email().closest('form')!.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(button.className).toContain('bg-primary');
    expect(submit.className).not.toContain('bg-primary');
    fireEvent.change(document.getElementById('password')!, { target: { value: 'secret' } });
    await waitFor(() => expect(submit.className).toContain('bg-primary'));
    expect(button.className).not.toContain('bg-primary');
  }, 30_000);

  it('asks for the address under its field when the browser button is pressed first', async () => {
    render(<LoginPage />);
    fireEvent.click(await browserButton());
    expect(await screen.findByTestId('login-email-needed')).toHaveTextContent('email_needed');
    expect(document.activeElement).toBe(email());
    expect(runDesktopBrowserSignIn).not.toHaveBeenCalled();
  }, 30_000);

  it('sends the browser to the server found from the address', async () => {
    found['example.org'] = 'https://mail.example.org';
    render(<LoginPage />);
    const button = await browserButton();
    fireEvent.change(email(), { target: { value: 'sam@example.org' } });
    fireEvent.click(button);
    await waitFor(() => expect(runDesktopBrowserSignIn).toHaveBeenCalled());
    expect(runDesktopBrowserSignIn.mock.calls[0][0].serverUrl).toBe('https://mail.example.org');
  }, 30_000);

  it('opens, marks and focuses the server field when nothing was found', async () => {
    render(<LoginPage />);
    const button = await browserButton();
    fireEvent.change(email(), { target: { value: 'sam@example.net' } });
    fireEvent.click(button);
    expect(await screen.findByTestId('login-server-error')).toHaveTextContent('server_needed');
    await waitFor(() => expect(document.activeElement).toBe(serverField()));
    expect(serverField()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByTestId('desktop-notice')).toBeNull();
    expect(runDesktopBrowserSignIn).not.toHaveBeenCalled();
    fireEvent.change(serverField()!, { target: { value: 'mail.example.net:8443' } });
    fireEvent.click(button);
    await waitFor(() => expect(runDesktopBrowserSignIn).toHaveBeenCalled());
    expect(runDesktopBrowserSignIn.mock.calls[0][0].serverUrl).toBe('https://mail.example.net:8443');
  }, 30_000);
});
