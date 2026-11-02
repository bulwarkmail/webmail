import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { useTranslations } from 'next-intl';
import { IntlProvider } from '../intl-provider';
import { useLocaleStore } from '@/stores/locale-store';

const nav = vi.hoisted(() => ({ pathname: null as string | null }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => nav.pathname,
}));

// The Lite export leaves the catalog out of the [locale] layout, because the
// prop was baked into every exported page and pushed the Stalwart zip past its
// size limit. The provider then loads the catalog itself and must render
// no text until it has it (only the page's skeleton, which has none): English text would flash on a German page, and the
// prerendered HTML has to match the client's first render.

vi.unmock('next-intl');

function Cancel() {
  return <span>{useTranslations('common')('cancel')}</span>;
}

describe('IntlProvider without server messages (Lite)', () => {
  afterEach(() => {
    useLocaleStore.setState({ locale: '' });
    nav.pathname = null;
  });

  it('prerenders nothing for a non-English locale', () => {
    expect(renderToString(<IntlProvider locale="de"><Cancel /></IntlProvider>)).toBe('');
  });

  it('prerenders the page skeleton, without any text, while the catalog is missing', () => {
    nav.pathname = '/de/calendar';
    const html = renderToString(<IntlProvider locale="de"><Cancel /></IntlProvider>);
    expect(html).toContain('data-boot-skeleton="calendar"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('Cancel');
    expect(html).not.toContain('role="status"');
  });

  it('prerenders English straight away from the bundled catalog', () => {
    expect(renderToString(<IntlProvider locale="en"><Cancel /></IntlProvider>)).toContain('Cancel');
  });

  it('loads the route locale on the client and renders it', async () => {
    const { container } = render(<IntlProvider locale="de"><Cancel /></IntlProvider>);
    expect(container.textContent).toBe('');
    expect(await screen.findByText('Abbrechen')).toBeTruthy();
  });

  it('follows a stored locale choice over the route locale', async () => {
    useLocaleStore.setState({ locale: 'fr' });
    render(<IntlProvider locale="de"><Cancel /></IntlProvider>);
    expect(await screen.findByText('Annuler')).toBeTruthy();
    expect(screen.queryByText('Abbrechen')).toBeNull();
  });
});
