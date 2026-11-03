import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wipe = vi.hoisted(() => ({ whole: vi.fn(async () => {}), unsent: 0 }));
vi.mock('@/lib/offline/device-wipe', () => ({ wipeWholeDevice: wipe.whole }));
vi.mock('@/lib/offline/offline-mode', () => ({ unsentCount: async () => ({ messages: wipe.unsent, changes: 0 }) }));

import { WipeDeviceSection } from '../wipe-device-section';

beforeEach(() => {
  wipe.whole.mockClear();
  wipe.unsent = 0;
});

describe('the wipe in settings', () => {
  it('says what goes before anything happens', async () => {
    render(<WipeDeviceSection />);
    fireEvent.click(screen.getByTestId('wipe-device-button'));
    const details = await screen.findByTestId('wipe-device-details');
    for (const key of ['confirm_mail', 'confirm_keys', 'confirm_plugins', 'confirm_files', 'confirm_accounts']) {
      expect(details.textContent).toContain(key);
    }
    expect(details.textContent).not.toContain('confirm_unsent');
    expect(wipe.whole).not.toHaveBeenCalled();
  });

  it('names unsent mail when there is some', async () => {
    wipe.unsent = 2;
    render(<WipeDeviceSection />);
    fireEvent.click(screen.getByTestId('wipe-device-button'));
    expect((await screen.findByTestId('wipe-device-details')).textContent).toContain('confirm_unsent');
  });

  it('wipes only after the yes, as the user\'s own', async () => {
    render(<WipeDeviceSection />);
    fireEvent.click(screen.getByTestId('wipe-device-button'));
    fireEvent.click(await screen.findByRole('button', { name: 'confirm_button' }));
    await waitFor(() => expect(wipe.whole).toHaveBeenCalledWith('user'));
  });

  it('a no leaves everything', async () => {
    render(<WipeDeviceSection />);
    fireEvent.click(screen.getByTestId('wipe-device-button'));
    await screen.findByTestId('wipe-device-details');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('wipe-device-details')).toBeNull());
    expect(wipe.whole).not.toHaveBeenCalled();
  });
});
