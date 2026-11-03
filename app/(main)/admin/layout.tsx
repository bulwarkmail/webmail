import { getLocale } from 'next-intl/server';
import { IntlProvider } from '@/components/providers/intl-provider';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { TourProvider } from '@/components/tour/tour-provider';
import { defaultLocale } from '@/i18n/routing';
import { AdminLayoutClient } from './_layout-client';
import { WindowMenuBar } from '@/components/layout/window-menu-bar';

/**
 * /admin sits outside the [locale] tree, so it loads the message catalog
 * itself: the shell reuses the webmail's navigation rail, which reads its
 * labels through next-intl (and the tour context, for its shortcuts
 * dialog). The locale comes from the request (cookie or Accept-Language,
 * see i18n/request.ts) and the user's own choice takes over in the
 * browser, like on every other page.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  let messages;
  try {
    messages = (await import(`@/locales/${locale}/common.json`)).default;
  } catch {
    messages = (await import(`@/locales/${defaultLocale}/common.json`)).default;
  }
  return (
    <IntlProvider locale={locale} messages={messages}>
      <ThemeProvider>
        <TourProvider>
          <WindowMenuBar />
          <AdminLayoutClient>{children}</AdminLayoutClient>
        </TourProvider>
      </ThemeProvider>
    </IntlProvider>
  );
}
