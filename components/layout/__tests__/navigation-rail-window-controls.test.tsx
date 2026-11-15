import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// On macOS the desktop app's traffic lights sit at the top of the rail, and the
// rail makes room for them there. The admin's logo sat above that room, so the
// traffic lights covered it.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({ appName: 'Mail', appLogoLightUrl: '/logo.svg', appLogoDarkUrl: '/logo.svg' }),
}));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

const { NavigationRail } = await import('../navigation-rail');
const { useUpdateStore } = await import('@/stores/update-store');

beforeEach(() => {
  useUpdateStore.setState({ startPolling: vi.fn() } as never);
});

describe('rail under the macOS traffic lights', () => {
  it.each([true, false])('keeps the logo inside the part that makes room (collapsed: %s)', (collapsed) => {
    const { container } = render(<NavigationRail orientation="vertical" collapsed={collapsed} />);
    const logo = container.querySelector('img[src$="/logo.svg"]');
    expect(logo).not.toBeNull();
    expect(logo!.closest('[data-window-rail]')).not.toBeNull();
  });

  it('pads the rail by the controls\' row when they are at the left', () => {
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    expect(css).toMatch(/html\[data-window-controls-left\] \[data-window-rail\] \{\s*padding-top: var\(--titlebar-row-height\);/);
  });
});

// The traffic lights also reached into the folder sidebar beside the rail, with
// the rule between the two columns running between the lights. Both columns
// leave the band empty now, and the rule starts below it.
describe('the folder sidebar under the macOS traffic lights', () => {
  const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
  const desk = css.match(/@media \(width >= 37\.5rem\) \{\s*html\[data-window-controls-left\] \[data-window-sidebar\][\s\S]*?\n\}/)?.[0] ?? '';

  it('pads the sidebar by the controls\' row on a desktop, where it is no drawer', () => {
    expect(desk).toMatch(/html\[data-window-controls-left\] \[data-window-sidebar\] \{\s*padding-top: var\(--titlebar-row-height\);/);
  });

  it('drags the window by that band', () => {
    const band = desk.match(/\[data-window-sidebar\]::before \{[^}]*\}/)?.[0] ?? '';
    expect(band).toContain('height: var(--titlebar-row-height);');
    expect(band).toContain('app-region: drag;');
    expect(band).toContain('-webkit-app-region: drag;');
    expect(band).toContain('pointer-events: none;');
  });

  it('runs the rule beside the rail full height, and below the band on macOS', () => {
    expect(css).toMatch(/\n\[data-window-rail-column\]::after \{[^}]*top: 0;[^}]*bottom: 0;[^}]*width: 1px;[^}]*background: rgba\(128, 128, 128, 0\.3\);/);
    expect(css).toMatch(/html\[data-window-controls-left\] \[data-window-rail-column\]::after \{\s*top: var\(--titlebar-row-height\);/);
  });

  it('draws Mail\'s rule with the stylesheet, not inline', () => {
    const mail = readFileSync(join(process.cwd(), 'components/mail/mail-app.tsx'), 'utf8');
    const column = mail.match(/<div className="[^"]*"[^>]*data-window-rail-column=""[^>]*>/)?.[0] ?? '';
    expect(column).toContain('relative');
    expect(column).not.toContain('borderRight');
  });
});
