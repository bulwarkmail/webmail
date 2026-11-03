import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/common.json';

// Until /api/setup/status answers (and in the server HTML), the wizard
// draws its own frame with the welcome step, not a card saying "Loading".

vi.unmock('next-intl');
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: vi.fn(() => new Promise(() => {})),
  getPathPrefix: () => '',
  withBasePath: (p: string) => p,
}));
vi.mock('@/lib/setup/url-token', () => ({ takeSetupTokenFromUrl: () => '' }));

const { default: SetupWizardPage } = await import('../page');

const page = (
  <NextIntlClientProvider locale="en" messages={en}>
    <SetupWizardPage />
  </NextIntlClientProvider>
);

describe('setup wizard while the status loads', () => {
  it('server-renders the wizard frame', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(page);
    const region = container.querySelector('[data-boot-skeleton="setup"]');
    expect(region).not.toBeNull();
    expect(region!.querySelector('[role="status"]')?.textContent).toBe(en.setup.loading);
    // Header, all seven steps and the welcome card, in the page's words.
    expect(region!.textContent).toContain(en.setup.title);
    for (const step of Object.values(en.setup.steps)) expect(region!.textContent).toContain(step);
    expect(region!.textContent).toContain(en.setup.welcome.token_label);
    expect(container.querySelectorAll('a[href], button, input')).toHaveLength(0);
  });

  it('keeps it on the client until the status is there', () => {
    const { container } = render(page);
    expect(container.querySelector('[data-boot-skeleton="setup"]')).not.toBeNull();
    expect(container.querySelector('.max-w-md')).toBeNull();
  });
});
