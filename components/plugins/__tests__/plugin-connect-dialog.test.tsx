import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key);
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
const appName = vi.hoisted(() => ({ value: 'Webmail' }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: appName.value }) }));

import { PluginConnectDialog } from '../plugin-connect-dialog';
import { originFromInput, requestConnect, type ConnectResult } from '@/lib/plugin-sandbox/connect-dialog';
import { useAuthStore } from '@/stores/auth-store';

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  appName.value = 'Webmail';
});

function open(mode: 'password' | 'signin' = 'password') {
  let result: Promise<ConnectResult>;
  act(() => {
    result = requestConnect({
      pluginId: 'nextcloud', pluginName: 'Nextcloud', credentialId: 'cloud', mode,
      spec: { label: 'Nextcloud', scope: 'user', inject: { type: 'basic' } },
    });
  });
  return result!;
}

describe('connect dialog', () => {
  it('sends the password to the server and tells the plugin only that it worked', async () => {
    render(<PluginConnectDialog />);
    const result = open();

    fireEvent.change(screen.getByText('server').parentElement!.querySelector('input')!, { target: { value: 'cloud.example.org/index.php' } });
    fireEvent.change(screen.getByText('username').parentElement!.querySelector('input')!, { target: { value: 'alice' } });
    fireEvent.change(screen.getByText('secret').parentElement!.querySelector('input')!, { target: { value: 'app-pw' } });
    expect(screen.getByText(/intro_password /)).toHaveTextContent('cloud.example.org');
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));

    await expect(result).resolves.toEqual({ connected: true, origin: 'https://cloud.example.org' });
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/plugin-secrets');
    expect(JSON.parse(init.body)).toMatchObject({
      pluginId: 'nextcloud', credentialId: 'cloud', origin: 'https://cloud.example.org', username: 'alice', secret: 'app-pw',
    });
    expect(JSON.stringify(await result)).not.toContain('app-pw');
  });

  it('only approves the server for a sign-in flow', async () => {
    render(<PluginConnectDialog />);
    const result = open('signin');

    expect(screen.queryByText('secret')).toBeNull();
    fireEvent.change(screen.getByText('server').parentElement!.querySelector('input')!, { target: { value: 'https://cloud.example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));

    await expect(result).resolves.toEqual({ connected: false, origin: 'https://cloud.example.org' });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).not.toHaveProperty('secret');
  });

  it('asks nothing for an app password the server makes, and names it', async () => {
    useAuthStore.setState({ username: 'alice@example.org', serverUrl: 'https://mail.example.org/' });
    render(<PluginConnectDialog />);
    let result: Promise<ConnectResult>;
    act(() => {
      result = requestConnect({
        pluginId: 'team-calendar', pluginName: 'Teamkalender', credentialId: 'stalwart', mode: 'appPassword',
        spec: { label: 'Stalwart', scope: 'user', inject: { type: 'basic' }, appPassword: true },
      });
    });

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('input')).toBeNull();
    expect(screen.getByText(/intro_app_password /)).toHaveTextContent('"account":"alice@example.org","description":"Plugin: Teamkalender"');
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));

    await expect(result!).resolves.toEqual({ connected: true, origin: 'https://mail.example.org' });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({
      pluginId: 'team-calendar', credentialId: 'stalwart', label: 'Stalwart', appPassword: true,
    });
  });

  it('names the app as configured, and Bulwark on a stock install', async () => {
    const first = render(<PluginConnectDialog />);
    const result = open('signin');
    expect(screen.getByText(/intro_signin /)).toHaveTextContent('"appName":"Bulwark"');
    first.unmount();

    appName.value = 'Acme Mail';
    render(<PluginConnectDialog />);
    expect(screen.getByText(/intro_signin /)).toHaveTextContent('"appName":"Acme Mail"');
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    await expect(result).resolves.toEqual({ connected: false });
  });

  // A modal: the first field takes the focus, Tab stays inside, and the
  // focus goes back to what opened it.
  it('holds the focus while open and gives it back after', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render(<PluginConnectDialog />);
    const result = open();
    const server = screen.getByText('server').parentElement!.querySelector('input')!;
    expect(server).toHaveFocus();
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(server, { key: 'Tab', shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await expect(result).resolves.toEqual({ connected: false });
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });

  it('shows the server error and stays open', async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'The server address must start with https://' }), { status: 400 }));
    render(<PluginConnectDialog />);
    const result = open();
    fireEvent.change(screen.getByText('server').parentElement!.querySelector('input')!, { target: { value: 'cloud.example.org' } });
    fireEvent.change(screen.getByText('username').parentElement!.querySelector('input')!, { target: { value: 'alice' } });
    fireEvent.change(screen.getByText('secret').parentElement!.querySelector('input')!, { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('must start with https'));
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await expect(result).resolves.toEqual({ connected: false });
  });
});

describe('originFromInput', () => {
  it('adds https and keeps only the origin', () => {
    expect(originFromInput('cloud.example.org/nextcloud')).toBe('https://cloud.example.org');
    expect(originFromInput('https://u:p@cloud.example.org')).toBeNull();
    expect(originFromInput('javascript:alert(1)')).toBeNull();
  });
});
