import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// "Vacation responder is active" opens Settings > Out of Office, not
// whichever settings page was open last.

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: nav.push, back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/contexts/drag-drop-context', () => ({ useDragDropContext: () => ({ isDragging: false }) }));
vi.mock('@/hooks/use-mailbox-drop', () => ({
  useMailboxDrop: () => ({ dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }),
}));
vi.mock('@/hooks/use-tag-drop', () => ({ useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }) }));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), progress: vi.fn(), dismiss: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));

const { Sidebar } = await import('../sidebar');
const { useVacationStore } = await import('@/stores/vacation-store');
const { buildSettingsPath } = await import('@/lib/deep-links');
const { useAuthStore } = await import('@/stores/auth-store');

describe('vacation banner', () => {
  it('opens the Out of Office settings', () => {
    useVacationStore.setState({ isEnabled: true, isSupported: true } as never);
    render(<Sidebar mailboxes={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /vacation_active/ }));
    expect(nav.push).toHaveBeenCalledWith(buildSettingsPath('vacation'));
    expect(buildSettingsPath('vacation')).not.toBe('/settings');
  });

  // settings-p2-12: the banner says "Out of office is on", as the setting is
  // called, and turns it off without a trip to Settings, like Gmail's "End now".
  it('turns out of office off on the server', async () => {
    const update = vi.fn(async () => true);
    useAuthStore.setState({ client: {} as never });
    useVacationStore.setState({ isEnabled: true, isSupported: true, updateVacationResponse: update } as never);
    render(<Sidebar mailboxes={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'vacation_turn_off' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.anything(), { isEnabled: false }, undefined));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says so when turning it off fails', async () => {
    const update = vi.fn(async () => { throw new Error('down'); });
    useAuthStore.setState({ client: {} as never });
    useVacationStore.setState({ isEnabled: true, isSupported: true, updateVacationResponse: update } as never);
    render(<Sidebar mailboxes={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'vacation_turn_off' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vacation_save_failed'));
  });
});
