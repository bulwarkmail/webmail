import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge, DesktopUpdateState, DesktopUpdatesBridge } from '@/lib/desktop/types';
import { DesktopUpdateSettings } from '../desktop-update-settings';

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const base: DesktopUpdateState = {
  version: '1.0.0',
  channel: 'stable',
  channelLocked: false,
  allowed: true,
  ability: 'install',
  perMachine: false,
  status: 'idle',
};

function bridge(state: Partial<DesktopUpdateState>) {
  const full = { ...base, ...state };
  let push: (next: DesktopUpdateState) => void = () => {};
  const updates: DesktopUpdatesBridge = {
    state: vi.fn(async () => full),
    check: vi.fn(async () => full),
    setChannel: vi.fn(async (channel) => ({ ...full, channel })),
    installOlder: vi.fn(async () => full),
    restart: vi.fn(),
    openDownload: vi.fn(),
    onChanged: (listener) => {
      push = listener;
      return () => {};
    },
  };
  window.bulwarkDesktop = { version: 1, platform: 'win32', updates } as BulwarkDesktopBridge;
  return { updates, push: (next: Partial<DesktopUpdateState>) => act(() => push({ ...full, ...next })) };
}

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

describe('updates in the settings', () => {
  it('shows nothing in a browser', () => {
    const { container } = render(<DesktopUpdateSettings />);
    expect(container.textContent).toBe('');
  });

  it('shows nothing in a copy that cannot update', async () => {
    const { updates } = bridge({ ability: 'none' });
    const { container } = render(<DesktopUpdateSettings />);
    await waitFor(() => expect(updates.state).toHaveBeenCalled());
    await act(async () => {});
    expect(container.textContent).toBe('');
  });

  it('offers to restart once an update is ready, and only then', async () => {
    const { updates, push } = bridge({});
    render(<DesktopUpdateSettings />);
    await screen.findByRole('button', { name: 'check' });
    expect(screen.queryByRole('button', { name: 'restart' })).toBeNull();

    push({ status: 'ready', target: '1.1.0' });
    fireEvent.click(await screen.findByRole('button', { name: 'restart' }));
    expect(updates.restart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'check' })).toBeNull();
  });

  it('can check again, but not while it is already checking or downloading', async () => {
    const { updates, push } = bridge({});
    render(<DesktopUpdateSettings />);
    const check = await screen.findByRole<HTMLButtonElement>('button', { name: 'check' });
    fireEvent.click(check);
    expect(updates.check).toHaveBeenCalledTimes(1);
    push({ status: 'downloading', target: '1.1.0', percent: 20 });
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'check' }).disabled).toBe(true));
  });

  it('switches the channel through the shell', async () => {
    const { updates } = bridge({});
    render(<DesktopUpdateSettings />);
    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'beta' } });
    expect(updates.setChannel).toHaveBeenCalledWith('beta');
  });

  it('marks the channel as set by the organisation when a policy locks it', async () => {
    bridge({ channelLocked: true, channel: 'beta' });
    render(<DesktopUpdateSettings />);
    const select = await screen.findByRole<HTMLSelectElement>('combobox');
    expect(select.value).toBe('beta');
    expect(select.closest('[inert]')).not.toBeNull();
  });

  it('downgrades only on a click, and only where this copy can install it', async () => {
    const { updates, push } = bridge({ status: 'older-available', target: '0.9.0', version: '1.0.0-beta.1' });
    render(<DesktopUpdateSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'install_older' }));
    expect(updates.installOlder).toHaveBeenCalledTimes(1);

    push({ status: 'older-available', target: '0.9.0', ability: 'notify' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'install_older' })).toBeNull());
  });

  it('on an MSI it says a version exists and offers no download to a user who cannot install it', async () => {
    bridge({ status: 'available', target: '1.1.0', ability: 'notify', perMachine: true });
    render(<DesktopUpdateSettings />);
    await screen.findByText('status_available_per_machine');
    expect(screen.queryByRole('button', { name: 'download' })).toBeNull();
  });

  it('links to the download where the user installs it themselves', async () => {
    const { updates } = bridge({ status: 'available', target: '1.1.0', ability: 'notify' });
    render(<DesktopUpdateSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'download' }));
    expect(updates.openDownload).toHaveBeenCalledTimes(1);
  });

  it('says the organisation turned updates off', async () => {
    bridge({ status: 'off', allowed: false });
    render(<DesktopUpdateSettings />);
    await screen.findByText('status_off');
  });
});
