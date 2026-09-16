import { notFound } from "next/navigation";
import { IntlProvider } from "@/components/providers/intl-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { CalendarAlertProvider } from "@/components/providers/calendar-alert-provider";
import { EmbeddedBridgeProvider } from "@/components/providers/embedded-bridge-provider";
import { RateLimitToastProvider } from "@/components/providers/rate-limit-toast-provider";
import { TourProvider } from "@/components/tour/tour-provider";
import { ProtocolLaunchHandlerProvider } from "@/components/protocol/protocol-launch-handler-provider";
import { ProInterfaceRedirect } from "@/components/pro/pro-interface-redirect";
import { ImpersonationReconciler } from "@/components/impersonation/impersonation-reconciler";
import { PluginDialogHost } from "@/components/plugins/plugin-dialog-host";
import { PluginConsentDialog } from "@/components/plugins/plugin-consent-dialog";
import { PluginOAuthCallbackListener } from "@/components/providers/plugin-oauth-callback-listener";
import { PWAInstallPrompt } from "@/components/pwa-install-prompt";
import { PushNotificationPrompt } from "@/components/push-notification-prompt";
import { setRequestLocale } from "next-intl/server";
import { BuildRefresh } from "@/components/build-refresh";
import { locales } from "@/i18n/routing";
import { generateLiteLocaleParams } from "@/lib/lite-static-params";

// The static Lite export enumerates every locale here. In the server build the
// export is `undefined`, which Next treats as absent, so the routes stay
// dynamic (lib/lite-static-params.ts).
export const generateStaticParams = generateLiteLocaleParams;

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!(locales as readonly string[]).includes(locale)) notFound();
  // Pins the request locale for next-intl's server helpers, which is what lets
  // the tree render without request headers (static export).
  setRequestLocale(locale);

  let messages;
  try {
    messages = (await import(`@/locales/${locale}/common.json`)).default;
  } catch {
    notFound();
  }

  return (
    <IntlProvider locale={locale} messages={messages}>
      <ThemeProvider>
        <CalendarAlertProvider>
          <RateLimitToastProvider>
            <EmbeddedBridgeProvider>
              <TourProvider>
                <ProtocolLaunchHandlerProvider>
                  <ProInterfaceRedirect />
                  <ImpersonationReconciler />
                  {children}
                  <PluginDialogHost />
                  <PluginConsentDialog />
                  <PluginOAuthCallbackListener />
                  <PWAInstallPrompt />
                  <PushNotificationPrompt />
                  <BuildRefresh />
                </ProtocolLaunchHandlerProvider>
              </TourProvider>
            </EmbeddedBridgeProvider>
          </RateLimitToastProvider>
        </CalendarAlertProvider>
      </ThemeProvider>
    </IntlProvider>
  );
}
