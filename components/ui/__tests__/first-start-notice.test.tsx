import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstStartNoticeBar } from '../first-start-notice';
import { resetFirstStartNotices, showFirstStartNotice } from '@/lib/first-start-notices';
import { useSettingsStore } from '@/stores/settings-store';

beforeEach(() => {
  localStorage.clear();
  resetFirstStartNotices();
  // The welcome tips were closed: notices may show.
  useSettingsStore.setState({ onboardingCompleted: true, showOnboardingOnNewDevices: false });
});

afterEach(() => cleanup());

describe('first-start notices', () => {
  it('wait for the welcome tips, wherever they show, and come after Got it', () => {
    useSettingsStore.setState({ onboardingCompleted: false });
    render(<FirstStartNoticeBar />);
    act(() => showFirstStartNotice({ id: 'offline', text: 'Mail is kept on this device.' }));
    expect(screen.queryByText('Mail is kept on this device.')).toBeNull();
    act(() => {
      localStorage.setItem('onboarding_completed', 'true');
      useSettingsStore.setState({ onboardingCompleted: true });
    });
    expect(screen.getByText('Mail is kept on this device.')).toBeTruthy();
  });

  it('show one at a time, each with a close button, the next once the first is closed', () => {
    render(<FirstStartNoticeBar />);
    act(() => {
      showFirstStartNotice({ id: 'one', text: 'Mail is kept on this device.' });
      showFirstStartNotice({ id: 'two', text: 'Spelling needs a dictionary.' });
    });
    expect(screen.getByText('Mail is kept on this device.')).toBeTruthy();
    expect(screen.queryByText('Spelling needs a dictionary.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.queryByText('Mail is kept on this device.')).toBeNull();
    expect(screen.getByText('Spelling needs a dictionary.')).toBeTruthy();
  });

  it('once closed, never again on this device', () => {
    const onClose = vi.fn();
    const view = render(<FirstStartNoticeBar />);
    act(() => showFirstStartNotice({ id: 'kept', text: 'Mail is kept on this device.', onClose }));
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    resetFirstStartNotices();
    render(<FirstStartNoticeBar />);
    act(() => showFirstStartNotice({ id: 'kept', text: 'Mail is kept on this device.' }));
    expect(screen.queryByText('Mail is kept on this device.')).toBeNull();
  });

  it('its button does its job and closes it', () => {
    const open = vi.fn();
    render(<FirstStartNoticeBar />);
    act(() => showFirstStartNotice({ id: 'act', text: 'Mail is kept on this device.', action: { label: 'Open settings', onClick: open } }));
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Mail is kept on this device.')).toBeNull();
  });

  it('waits while something else greets the user, and the same notice isn\'t queued twice', () => {
    const view = render(<FirstStartNoticeBar hidden />);
    act(() => {
      showFirstStartNotice({ id: 'wait', text: 'Mail is kept on this device.' });
      showFirstStartNotice({ id: 'wait', text: 'Mail is kept on this device.' });
    });
    expect(screen.queryByText('Mail is kept on this device.')).toBeNull();
    view.rerender(<FirstStartNoticeBar />);
    expect(screen.getAllByText('Mail is kept on this device.')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.queryByText('Mail is kept on this device.')).toBeNull();
  });
});
