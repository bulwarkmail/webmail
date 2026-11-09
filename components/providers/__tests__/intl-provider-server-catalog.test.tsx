import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useTranslations } from 'next-intl';
import { useLocaleStore } from '@/stores/locale-store';
import { loadCatalog } from '@/i18n/catalog';
import enCommon from '@/locales/en/common.json';
import enPlain from '@/locales/en/plain.json';
import dePlain from '@/locales/de/plain.json';

// Every build but Lite: the server hands IntlProvider the page's catalog with
// English already under it, and the browser has no copy of English of its
// own (next.config.ts swaps lite-intl-assets for the empty module). English
// is a chunk, fetched only to switch language.

vi.unmock('next-intl');
vi.mock('../lite-intl-assets', () => import('../lite-intl-assets.off'));
const english = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@/i18n/english-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/english-catalog')>();
  return {
    ...actual,
    loadEnglishMessages: () => { english.loads++; return actual.loadEnglishMessages(); },
    withEnglishFallback: (messages: Record<string, unknown>) => { english.loads++; return actual.withEnglishFallback(messages); },
  };
});

const { IntlProvider } = await import('../intl-provider');

function Strings() {
  const t = useTranslations('login');
  return <p data-testid="plain">{t('error.invalid_credentials')}</p>;
}

afterEach(() => {
  useLocaleStore.setState({ locale: '' });
  english.loads = 0;
});

describe('the server catalog', () => {
  it('has the plain wording, and English under every other locale', async () => {
    expect((await loadCatalog('en') as typeof enCommon).login.error.invalid_credentials).toBe(enPlain.login.error.invalid_credentials);
    const de = await loadCatalog('de') as typeof enCommon;
    expect(de.login.error.invalid_credentials).toBe(dePlain.login.error.invalid_credentials);
    // English under it: every English key is there.
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    const deKeys = new Set(keys(de));
    expect(keys(enCommon).filter((k) => !deKeys.has(k))).toEqual([]);
    await expect(loadCatalog('xx')).rejects.toThrow();
  });
});

describe('IntlProvider with a server catalog', () => {
  it('draws the first render from it and fetches no English', async () => {
    render(<IntlProvider locale="en" messages={await loadCatalog('en')}><Strings /></IntlProvider>);
    expect(screen.getByTestId('plain').textContent).toBe(enPlain.login.error.invalid_credentials);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(english.loads).toBe(0);
  });

  it('fetches English to switch language, under the new locale', async () => {
    render(<IntlProvider locale="en" messages={await loadCatalog('en')}><Strings /></IntlProvider>);
    act(() => useLocaleStore.setState({ locale: 'de' }));
    expect(await screen.findByText(dePlain.login.error.invalid_credentials, {}, { timeout: 8000 })).toBeTruthy();
    expect(english.loads).toBeGreaterThan(0);
  });

  it('draws nothing without a catalog, rather than keys', () => {
    const { container } = render(<IntlProvider locale="de"><Strings /></IntlProvider>);
    expect(container.textContent).toBe('');
  });
});

describe('IntlProvider with the first screen catalog', () => {
  function Both() {
    const login = useTranslations('login');
    const hover = useTranslations('settings.email_behavior.hover_actions');
    return <><p data-testid="first">{login('error.invalid_credentials')}</p><p data-testid="rest">{hover('archive')}</p></>;
  }

  it('draws a key outside it as nothing, never its name, and the string once the rest has come', async () => {
    const { loadFirstScreenCatalog } = await import('@/i18n/catalog');
    const first = await loadFirstScreenCatalog('en');
    const full = await loadCatalog('en') as { settings: { email_behavior: { hover_actions: { archive: string } } } };
    vi.stubGlobal('requestIdleCallback', undefined);
    render(<IntlProvider locale="en" messages={first} partial><Both /></IntlProvider>);
    expect(screen.getByTestId('first').textContent).toBe(enPlain.login.error.invalid_credentials);
    expect(screen.getByTestId('rest').textContent).toBe('');
    expect((window as { __bulwarkCatalogMisses?: string[] }).__bulwarkCatalogMisses).toContain('settings.email_behavior.hover_actions.archive');
    await waitFor(() => expect(screen.getByTestId('rest').textContent).toBe(full.settings.email_behavior.hover_actions.archive), { timeout: 8000 });
    vi.unstubAllGlobals();
  });

  it('fetches the rest on the sign-in page only once it is left', async () => {
    const { loadFirstScreenCatalog } = await import('@/i18n/catalog');
    const first = await loadFirstScreenCatalog('en');
    window.history.replaceState(null, '', '/en/login');
    vi.stubGlobal('requestIdleCallback', undefined);
    try {
      render(<IntlProvider locale="en" messages={first} partial><Both /></IntlProvider>);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(english.loads).toBe(0);
      expect(screen.getByTestId('rest').textContent).toBe('');
      window.history.pushState(null, '', '/en');
      await waitFor(() => expect(screen.getByTestId('rest').textContent).not.toBe(''), { timeout: 8000 });
    } finally {
      vi.unstubAllGlobals();
      window.history.replaceState(null, '', '/');
    }
  });
});
