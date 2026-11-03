import 'fake-indexeddb/auto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLockSettings } from '@/components/settings/app-lock-settings';
import { LockScreen } from '../lock-screen';
import { createVault, deleteVault, FREE_FAILURES } from '@/lib/app-lock/vault';
import { writeAppLockFile } from '@/lib/app-lock/state';

vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));

const unlockWithPin = vi.hoisted(() => vi.fn());
const forgetEverything = vi.hoisted(() => vi.fn());
vi.mock('@/lib/app-lock/controller', async (original) => ({
  ...(await original<typeof import('@/lib/app-lock/controller')>()),
  unlockWithPin,
  forgetEverything,
}));

function setPolicy(required: boolean, minutes: number | null, locked: boolean): void {
  (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    policy: {
      get: () => ({
        AppLockRequired: { value: required, locked: required, source: required ? 'forced-machine' : 'default' },
        AppLockTimeoutMinutes: { value: minutes, locked, source: locked ? 'forced-machine' : 'default' },
      }),
      onChange: () => () => {},
    },
  };
}

beforeEach(async () => {
  await deleteVault();
  localStorage.clear();
  unlockWithPin.mockReset();
  forgetEverything.mockReset();
});

afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

function typeAndSubmit(pin: string): void {
  fireEvent.change(screen.getByTestId('app-lock-pin'), { target: { value: pin } });
  fireEvent.submit(screen.getByTestId('app-lock-form'));
}

describe('the lock screen', () => {
  it('passes the PIN on and shows nothing but the lock', async () => {
    (await createVault('correct-pin')).fill(0);
    unlockWithPin.mockResolvedValue(undefined);
    render(<LockScreen phase="locked" />);
    typeAndSubmit('correct-pin');
    await waitFor(() => expect(unlockWithPin).toHaveBeenCalledWith('correct-pin'));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-app-lock-overlay');
  });

  it('says a wrong PIN was wrong, and empties the field', async () => {
    (await createVault('correct-pin')).fill(0);
    unlockWithPin.mockRejectedValue(Object.assign(new Error('x'), { name: 'WrongPinError' }));
    render(<LockScreen phase="locked" />);
    typeAndSubmit('nope-nope');
    await waitFor(() => expect(screen.getByTestId('app-lock-message')).toHaveTextContent('wrong_pin'));
    expect(screen.getByTestId('app-lock-pin')).toHaveValue('');
  });

  it('comes up blocked after a reload, from what is on disk', async () => {
    (await createVault('correct-pin')).fill(0);
    const { openVaultWithPin } = await import('@/lib/app-lock/vault');
    for (let i = 0; i <= FREE_FAILURES; i += 1) await openVaultWithPin('wrong-pin').catch(() => {});
    await act(async () => {
      render(<LockScreen phase="locked" />);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(screen.getByTestId('app-lock-pin')).toBeDisabled());
    expect(screen.getByTestId('app-lock-message').textContent).toMatch(/blocked_/);
    expect(screen.getByTestId('app-lock-unlock')).toBeDisabled();
  });

  it('offers no passkey or OS button when none is set up, and always the way out', async () => {
    (await createVault('correct-pin')).fill(0);
    render(<LockScreen phase="locked" />);
    await waitFor(() => expect(screen.getByTestId('app-lock-forgot')).toBeInTheDocument());
    expect(screen.queryByTestId('app-lock-passkey')).toBeNull();
    expect(screen.queryByTestId('app-lock-os')).toBeNull();
  });

  it('asks about a forgotten PIN inside the lock screen: everything on <body> beside it is hidden', async () => {
    (await createVault('correct-pin')).fill(0);
    render(<LockScreen phase="locked" />);
    fireEvent.click(await screen.findByTestId('app-lock-forgot'));
    const confirm = screen.getByRole('button', { name: 'forgot_confirm' });
    expect(confirm.closest('[data-app-lock-overlay]')).not.toBeNull();
    expect(screen.getByRole('dialog')).toHaveTextContent('forgot_body');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(await screen.findByTestId('app-lock-pin')).toBeInTheDocument();
    expect(forgetEverything).not.toHaveBeenCalled();
  });

  it('forgets only after the yes, and comes back when main says no', async () => {
    (await createVault('correct-pin')).fill(0);
    forgetEverything.mockResolvedValue(false);
    render(<LockScreen phase="locked" />);
    fireEvent.click(await screen.findByTestId('app-lock-forgot'));
    fireEvent.click(screen.getByRole('button', { name: 'forgot_confirm' }));
    await waitFor(() => expect(forgetEverything).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('app-lock-pin')).toBeInTheDocument();
  });

  it('says it\'s saving rather than ask for anything while it locks', () => {
    render(<LockScreen phase="locking" />);
    expect(screen.queryByTestId('app-lock-pin')).toBeNull();
    expect(screen.getByRole('dialog')).toHaveTextContent('locking');
  });

  it('asks for a PIN when an organisation requires it, and only a good one', () => {
    render(<LockScreen phase="setup" />);
    expect(screen.getByRole('dialog')).toHaveTextContent('setup_required_title');
    const save = screen.getByRole('button', { name: 'save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId('app-lock-new-pin'), { target: { value: '12345' } });
    fireEvent.change(screen.getByTestId('app-lock-repeat-pin'), { target: { value: '12345' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId('app-lock-new-pin'), { target: { value: '123456' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId('app-lock-repeat-pin'), { target: { value: '123456' } });
    expect(save).toBeEnabled();
  });
});

describe('the settings', () => {
  it('are off by default, with nothing else shown', () => {
    render(<AppLockSettings />);
    expect(screen.getByTestId('app-lock-switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('app-lock-now')).toBeNull();
    expect(screen.queryByTestId('app-lock-timeout')).toBeNull();
  });

  it('show the switch as set by the organisation when a policy requires it', () => {
    setPolicy(true, null, false);
    writeAppLockFile({ on: true, locked: false });
    const { container } = render(<AppLockSettings />);
    const toggle = screen.getByTestId('app-lock-switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle.closest('[inert]')).not.toBeNull();
    expect(container.textContent).toContain('org_locked');
  });

  it('show a forced timeout as set by the organisation, with its value', () => {
    setPolicy(false, 3, true);
    writeAppLockFile({ on: true, locked: false, timeoutMinutes: 60 });
    render(<AppLockSettings />);
    const select = screen.getByTestId('app-lock-timeout');
    expect(select).toHaveValue('3');
    expect(select.closest('[inert]')).not.toBeNull();
  });

  it('leave the timeout to the user otherwise', () => {
    writeAppLockFile({ on: true, locked: false, timeoutMinutes: 30 });
    render(<AppLockSettings />);
    const select = screen.getByTestId('app-lock-timeout');
    expect(select).toHaveValue('30');
    expect(select.closest('[inert]')).toBeNull();
  });
});
