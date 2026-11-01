import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The admin sign-in page renders in full on the server, which can't know the
// theme: it sends both logos and CSS shows the one for the theme, instead of
// the light logo turning white after the first paint in dark mode.

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({
    appName: 'Webmail',
    loginLogoLightUrl: '/branding/light.svg',
    loginLogoDarkUrl: '/branding/dark.svg',
  }),
}));

const { default: AdminLoginPage } = await import('../login/page');

describe('admin sign-in logo', () => {
  it('sends the light and the dark logo, each for its theme', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(<AdminLoginPage />);
    const logos = [...container.querySelectorAll('img')].map((img) => [img.getAttribute('src'), img.className]);
    expect(logos).toEqual([
      ['/branding/light.svg', expect.stringContaining('dark:hidden')],
      ['/branding/dark.svg', expect.stringContaining('hidden dark:block')],
    ]);
  });
});
