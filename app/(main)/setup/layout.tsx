import type { ReactNode } from 'react';
import { getLocale } from 'next-intl/server';
import { IntlProvider } from '@/components/providers/intl-provider';
import { defaultLocale } from '@/i18n/routing';
import { loadCatalog } from '@/i18n/catalog';

/**
 * /setup sits outside the [locale] tree, so it loads the message catalog
 * itself, like /admin. The locale comes from the request (cookie or
 * Accept-Language) and the browser's language takes over on the client,
 * as on the login page.
 */
export default async function SetupLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  let messages;
  try {
    messages = await loadCatalog(locale);
  } catch {
    messages = await loadCatalog(defaultLocale);
  }
  return (
    <IntlProvider locale={locale} messages={messages}>
      <div className="min-h-screen bg-background text-foreground">{children}</div>
    </IntlProvider>
  );
}
