import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FreeBusyShareSetting } from '../free-busy-share-setting';
import { useAuthStore } from '@/stores/auth-store';

// pim-26: the button named one address ("Share my free/busy with
// dso-ux-pim-b@example.org") while the text spoke of "colleagues in the
// group". The text no longer says group.

vi.mock('@/components/calendar/free-busy-share-button', () => ({ FreeBusyShareButton: () => null }));

describe('Free/busy setting wording (pim-26)', () => {
  it('describes sharing without calling the address a group', () => {
    useAuthStore.setState({
      client: {
        supportsCalendars: () => true,
        getSharedAccounts: () => [{ id: 'b', name: 'b@example.org', isPrimary: false }],
        getAccountInfo: () => ({ isPersonal: false }),
      },
    } as never);
    render(<FreeBusyShareSetting />);
    expect(screen.getByText('freebusy_description')).toBeInTheDocument();
    expect(screen.queryByText('description')).toBeNull();
  });
});
