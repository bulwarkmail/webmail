import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDesktopWindowName, windowMenuName } from '../window-name';
import { useAccountStore } from '@/stores/account-store';

// The desktop app's Window menu: each window by what it shows (usability pass 2, desktop-p2-5).

function Named({ view, withAccount }: { view: string | null; withAccount?: boolean }) {
  useDesktopWindowName(view, { withAccount });
  return null;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('the Window menu name', () => {
  it('is the view and the account for the main window, the view alone otherwise', () => {
    expect(windowMenuName('Inbox', 'a@example.org')).toBe('Inbox - a@example.org');
    expect(windowMenuName('Quarterly budget', null)).toBe('Quarterly budget');
    expect(windowMenuName('  ', null)).toBeNull();
  });

  it('goes to the shell, with the account in view, and again when it changes', () => {
    const named: string[] = [];
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', windows: { setMenuName: (name: string) => named.push(name) } };
    useAccountStore.setState({ accounts: [{ id: 'acc-1', email: 'a@example.org' }], activeAccountId: 'acc-1' } as never);
    const { rerender } = render(<Named view="Inbox" withAccount />);
    expect(named).toEqual(['Inbox - a@example.org']);
    rerender(<Named view="Sent" withAccount />);
    expect(named).toEqual(['Inbox - a@example.org', 'Sent - a@example.org']);
    rerender(<Named view="A subject" />);
    expect(named.at(-1)).toBe('A subject');
  });

  it('is nothing to an older shell, or in a browser', () => {
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', windows: {} };
    expect(() => render(<Named view="Inbox" />)).not.toThrow();
  });
});
