import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useTranslations } from 'next-intl';
import { IntlProvider } from '../intl-provider';
import { useLocaleStore } from '@/stores/locale-store';
import enCommon from '@/locales/en/common.json';
import deCommon from '@/locales/de/common.json';
import frCommon from '@/locales/fr/common.json';
import enPlain from '@/locales/en/plain.json';
import dePlain from '@/locales/de/plain.json';
import { addPlainLanguage } from '@/i18n/plain-language';

// The plain wording in locales/<en|de|vi>/plain.json is the only wording
// (usability pass 2026-11-04, settings-15): it is laid over the catalog for
// English, German and Vietnamese with no setting, and other locales keep
// their own strings.

vi.unmock('next-intl');

function Strings() {
  const t = useTranslations('login');
  return (
    <>
      <p data-testid="plain">{t('error.invalid_credentials')}</p>
      <p data-testid="normal">{t('sign_in')}</p>
    </>
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;

// Lets lazily imported catalogs land.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe('plain wording', () => {
  beforeEach(() => {
    // The fallback assertions need a key that has no plain version, and the
    // plain assertions one whose plain version differs.
    expect((enPlain as { login: Record<string, unknown> }).login.sign_in).toBeUndefined();
    expect((dePlain as { login: Record<string, unknown> }).login.sign_in).toBeUndefined();
    expect(enPlain.login.error.invalid_credentials).not.toBe(enCommon.login.error.invalid_credentials);
    expect(dePlain.login.error.invalid_credentials).not.toBe(deCommon.login.error.invalid_credentials);
  });

  afterEach(() => {
    useLocaleStore.setState({ locale: '' });
  });

  it('shows the plain English string from the first render, with no setting', () => {
    render(<IntlProvider locale="en"><Strings /></IntlProvider>);
    expect(text('plain')).toBe(enPlain.login.error.invalid_credentials);
    // A key without a plain version keeps the common.json string.
    expect(text('normal')).toBe(enCommon.login.sign_in);
  });

  it('adds the plain strings to a server catalog for German, not French', async () => {
    const de = (await addPlainLanguage('de', deCommon)) as typeof deCommon;
    expect(de.login.error.invalid_credentials).toBe(dePlain.login.error.invalid_credentials);
    expect(await addPlainLanguage('fr', frCommon)).toBe(frCommon);
  });

  it('uses the plain German string for a German UI', async () => {
    const messages = await addPlainLanguage('de', deCommon);
    render(<IntlProvider locale="de" messages={messages}><Strings /></IntlProvider>);
    expect(text('plain')).toBe(dePlain.login.error.invalid_credentials);
    expect(text('normal')).toBe(deCommon.login.sign_in);
  });

  it('loads the plain German strings without server messages, as in the Lite export', async () => {
    render(<IntlProvider locale="de"><Strings /></IntlProvider>);
    // The German catalog is a lazy chunk, slow to import under load.
    expect(await screen.findByText(dePlain.login.error.invalid_credentials, {}, { timeout: 8000 })).toBeTruthy();
  });

  it('leaves other locales on their own strings', async () => {
    render(<IntlProvider locale="fr" messages={frCommon}><Strings /></IntlProvider>);
    await settle();
    expect(text('plain')).toBe(frCommon.login.error.invalid_credentials);
  });

  it('keeps the plain wording across a language change', async () => {
    render(<IntlProvider locale="en"><Strings /></IntlProvider>);
    expect(text('plain')).toBe(enPlain.login.error.invalid_credentials);

    act(() => useLocaleStore.setState({ locale: 'de' }));
    expect(await screen.findByText(dePlain.login.error.invalid_credentials, {}, { timeout: 8000 })).toBeTruthy();

    act(() => useLocaleStore.setState({ locale: 'fr' }));
    expect(await screen.findByText(frCommon.login.error.invalid_credentials, {}, { timeout: 8000 })).toBeTruthy();
  });
});
