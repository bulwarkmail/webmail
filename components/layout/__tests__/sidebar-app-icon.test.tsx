import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SidebarAppIcon } from '../sidebar-app-icon';

// An operator's app may carry its own image (iconUrl); the named icon stands
// in when it fails to load, and a user's own app never shows one.

const chat = {
  id: 'admin-app-chat',
  name: 'Chat',
  url: 'https://chat.example.com/',
  icon: 'tabler:check',
  iconUrl: 'https://chat.example.com/favicon.png',
  openMode: 'inline' as const,
  showOnMobile: false,
};

describe('SidebarAppIcon', () => {
  it("draws an admin app's image at the icon's size", () => {
    const { container } = render(<SidebarAppIcon app={{ ...chat, managed: true }} className="w-[18px] h-[18px]" />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', 'https://chat.example.com/favicon.png');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveClass('w-[18px]', 'h-[18px]', 'object-contain');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('falls back to the named icon when the image fails to load', () => {
    const { container } = render(<SidebarAppIcon app={{ ...chat, managed: true }} className="w-5 h-5" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toHaveClass('w-5', 'h-5');
  });

  it("tries again when the image's URL changes", () => {
    const { container, rerender } = render(<SidebarAppIcon app={{ ...chat, managed: true }} />);
    fireEvent.error(container.querySelector('img')!);
    rerender(<SidebarAppIcon app={{ ...chat, iconUrl: 'https://chat.example.com/logo.svg', managed: true }} />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://chat.example.com/logo.svg');
  });

  it("ignores an image on a user's own app", () => {
    const { container } = render(<SidebarAppIcon app={chat} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
