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
const helloState = vi.hoisted(() => vi.fn());
const unlockWithHello = vi.hoisted(() => vi.fn());
const cancelHello = vi.hoisted(() => vi.fn());
const enableHello = vi.hoisted(() => vi.fn());
const disableHello = vi.hoisted(() => vi.fn());
vi.mock('@/lib/app-lock/controller', async (original) => ({
  ...(await original<typeof import('@/lib/app-lock/controller')>()),
  unlockWithPin,
  forgetEverything,
  helloState,
  unlockWithHello,
  cancelHello,
  enableHello,
  disableHello,
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
  for (const mock of [unlockWithHello, cancelHello, enableHello, disableHello]) mock.mockReset();
  helloState.mockReset();
  // A browser, or a shell without Hello: what the tests above expect.
  helloState.mockResolvedValue({ shown: false, on: false });
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

  describe('in a pop-out', () => {
    class Channel {
      static open = new Set<Channel>();
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() { Channel.open.add(this); }
      postMessage(data: unknown): void {
        for (const channel of Channel.open) if (channel !== this) channel.onmessage?.({ data } as MessageEvent);
      }
      close(): void { Channel.open.delete(this); }
    }

    beforeEach(() => {
      Channel.open.clear();
      vi.stubGlobal('BroadcastChannel', Channel);
      window.history.replaceState(null, '', '/popout/compose');
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      window.history.replaceState(null, '', '/');
    });

    it('sends people to the main window, and asks for the PIN itself once that has closed', async () => {
      (await createVault('correct-pin')).fill(0);
      const main = new Channel();
      let mainOpen = true;
      main.onmessage = (event) => {
        if (mainOpen && (event.data as { type: string }).type === 'main-ping') main.postMessage({ type: 'main-pong' });
      };
      render(<LockScreen phase="locked" />);
      expect(await screen.findByRole('button', { name: 'open_main' })).toBeInTheDocument();
      mainOpen = false;
      main.close();
      expect(await screen.findByTestId('app-lock-pin', {}, { timeout: 6000 })).toBeInTheDocument();
    }, 15_000);
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
    fireEvent.change(screen.getByTestId('app-lock-new-pin'), { target: { value: '482913' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId('app-lock-repeat-pin'), { target: { value: '482913' } });
    expect(save).toBeEnabled();
  });
});

describe('the settings', () => {
  it('say what a PIN protects against here', () => {
    render(<AppLockSettings />);
    expect(screen.getByText('protects_desc')).toBeInTheDocument();
  });

  it('won\'t save a PIN anyone would guess', async () => {
    render(<AppLockSettings />);
    fireEvent.click(screen.getByTestId('app-lock-switch'));
    fireEvent.change(await screen.findByTestId('app-lock-new-pin'), { target: { value: '123456' } });
    fireEvent.change(screen.getByTestId('app-lock-repeat-pin'), { target: { value: '123456' } });
    expect(screen.getByText('pin_obvious')).toBeInTheDocument();
    expect(screen.getByTestId('app-lock-dialog-save')).toBeDisabled();
  });

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

describe('Windows Hello on the lock screen', () => {
  beforeEach(async () => {
    (await createVault('correct-pin')).fill(0);
    helloState.mockResolvedValue({ shown: true, on: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks Hello first when the window has the focus, with the PIN a click away', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    unlockWithHello.mockReturnValue(new Promise(() => {}));
    render(<LockScreen phase="locked" />);
    await waitFor(() => expect(unlockWithHello).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog')).toHaveTextContent('waiting');
    expect(screen.queryByTestId('app-lock-pin')).toBeNull();
    fireEvent.click(screen.getByTestId('app-lock-use-pin'));
    expect(cancelHello).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('app-lock-pin')).toBeInTheDocument();
    expect(screen.getByTestId('app-lock-hello-button')).toBeInTheDocument();
  });

  it('waits for the focus before it asks: a prompt nobody sees only times out', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    unlockWithHello.mockReturnValue(new Promise(() => {}));
    render(<LockScreen phase="locked" />);
    expect(await screen.findByTestId('app-lock-hello')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(unlockWithHello).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(unlockWithHello).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(unlockWithHello).toHaveBeenCalledTimes(1);
  });

  it('falls back to the PIN when Hello fails, and says so; a cancel says nothing', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    unlockWithHello.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'HelloError', reason: 'failed' }));
    render(<LockScreen phase="locked" />);
    // The PIN form shows until the lock screen knows Hello is on.
    await waitFor(() => expect(unlockWithHello).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('app-lock-message')).toHaveTextContent('failed'));
    expect(screen.getByTestId('app-lock-pin')).toBeInTheDocument();
    unlockWithHello.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'HelloError', reason: 'cancelled' }));
    fireEvent.click(screen.getByTestId('app-lock-hello-button'));
    await waitFor(() => expect(unlockWithHello).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('app-lock-pin')).toBeInTheDocument());
    expect(screen.getByTestId('app-lock-message')).toHaveTextContent(/^$/);
  });

  it('a key credential that is gone takes the Hello button with it', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    unlockWithHello.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'HelloError', reason: 'missing' }));
    render(<LockScreen phase="locked" />);
    await waitFor(() => expect(screen.getByTestId('app-lock-message')).toHaveTextContent('gone'));
    expect(screen.getByTestId('app-lock-pin')).toBeInTheDocument();
    expect(screen.queryByTestId('app-lock-hello-button')).toBeNull();
  });

  it('with Hello off it is the PIN, as before', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    helloState.mockResolvedValue({ shown: true, on: false });
    render(<LockScreen phase="locked" />);
    expect(await screen.findByTestId('app-lock-pin')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(unlockWithHello).not.toHaveBeenCalled();
    expect(screen.queryByTestId('app-lock-hello-button')).toBeNull();
  });
});

describe('Windows Hello in the settings', () => {
  beforeEach(() => {
    writeAppLockFile({ on: true, locked: false });
  });

  it('shows a switch under the PIN where Hello can unlock, and turns it on with the PIN', async () => {
    helloState.mockResolvedValue({ shown: true, on: false });
    enableHello.mockResolvedValue(undefined);
    render(<AppLockSettings />);
    const toggle = await screen.findByTestId('app-lock-hello-switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('protects')).toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.change(await screen.findByTestId('app-lock-current-pin'), { target: { value: 'correct-pin' } });
    fireEvent.click(screen.getByTestId('app-lock-dialog-save'));
    await waitFor(() => expect(enableHello).toHaveBeenCalledWith('correct-pin'));
  });

  it('says why Hello couldn\'t be turned on', async () => {
    helloState.mockResolvedValue({ shown: true, on: false });
    enableHello.mockRejectedValue(Object.assign(new Error('x'), { name: 'HelloError', reason: 'unsupported' }));
    render(<AppLockSettings />);
    fireEvent.click(await screen.findByTestId('app-lock-hello-switch'));
    fireEvent.change(await screen.findByTestId('app-lock-current-pin'), { target: { value: 'correct-pin' } });
    fireEvent.click(screen.getByTestId('app-lock-dialog-save'));
    expect(await screen.findByText('unsupported')).toBeInTheDocument();
  });

  it('turns it off without the PIN: that only narrows', async () => {
    helloState.mockResolvedValue({ shown: true, on: true });
    disableHello.mockResolvedValue(undefined);
    render(<AppLockSettings />);
    const toggle = await screen.findByTestId('app-lock-hello-switch');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);
    await waitFor(() => expect(disableHello).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('app-lock-current-pin')).toBeNull();
  });

  it('shows no switch and no Hello text where Hello can\'t unlock', async () => {
    helloState.mockResolvedValue({ shown: false, on: false });
    render(<AppLockSettings />);
    await waitFor(() => expect(helloState).toHaveBeenCalled());
    expect(screen.queryByTestId('app-lock-hello-switch')).toBeNull();
    expect(screen.queryByText('protects')).toBeNull();
  });
});
