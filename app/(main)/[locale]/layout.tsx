import { notFound } from "next/navigation";
import { IntlProvider } from "@/components/providers/intl-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { CalendarAlertProvider } from "@/components/providers/calendar-alert-provider";
import { PushBindingsHost } from "@/components/providers/push-bindings-host";
import { EmbeddedBridgeProvider } from "@/components/providers/embedded-bridge-provider";
import { RateLimitToastProvider } from "@/components/providers/rate-limit-toast-provider";
import { TourProvider } from "@/components/tour/tour-provider";
import { ProtocolLaunchHandlerProvider } from "@/components/protocol/protocol-launch-handler-provider";
import { ProInterfaceRedirect } from "@/components/pro/pro-interface-redirect";
import { ImpersonationReconciler } from "@/components/impersonation/impersonation-reconciler";
import { PluginDialogHost } from "@/components/plugins/plugin-dialog-host";
import { ExternalRecipientConfirmHost } from "@/components/email/external-recipient-confirm";
import { PhishingReportHost } from "@/components/email/phishing-report-host";
import { PluginPageNavigator } from "@/components/plugins/plugin-page-navigator";
import { PaneCycleHost } from "@/components/layout/pane-cycle";
import { FocusRescueHost } from "@/components/layout/focus-rescue";
import { CommandPaletteHost } from "@/components/command-palette/command-palette";
import { AccessibilityQuickPanelHost } from "@/components/accessibility/accessibility-quick-panel";
import { TotpReauthDialog } from "@/components/totp-reauth-dialog";
import { PluginConnectDialog } from "@/components/plugins/plugin-connect-dialog";
import { QuickRuleHost } from "@/components/filters/quick-rule-host";
import { MailTransferHost } from "@/components/mail-transfer/mail-transfer-host";
import { PluginConsentDialog } from "@/components/plugins/plugin-consent-dialog";
import { PluginAppEvents } from "@/components/providers/plugin-app-events";
import { PluginOAuthCallbackListener } from "@/components/providers/plugin-oauth-callback-listener";
import { PWAInstallPrompt } from "@/components/pwa-install-prompt";
import { AppUpdatePrompt } from "@/components/app-update-prompt";
import { OfflineHost } from "@/components/offline/offline-host";
import { DevicePolicyHost } from "@/components/device/device-policy-host";
import { PushNotificationPrompt } from "@/components/push-notification-prompt";
import { AccountArchiveRestorePrompt } from "@/components/account-archive-prompt";
import { SessionTimeoutGuard } from "@/components/session/session-timeout-guard";
import { AccountTemplateSync } from "@/components/templates/account-template-sync";
import { FreeBusyAutoShare } from "@/components/calendar/free-busy-auto-share";
import { IS_LITE } from "@/lib/lite";
import { setRequestLocale } from "next-intl/server";
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

  // Lite leaves the catalog out: a prop here is baked into every exported page
  // (the HTML and three RSC payloads per route and locale), which pushed the
  // Stalwart zip past its size limit. IntlProvider loads it as a chunk instead.
  let messages;
  if (!IS_LITE) {
    try {
      messages = (await import(`@/locales/${locale}/common.json`)).default;
    } catch {
      notFound();
    }
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
                  <PushBindingsHost />
                  <SessionTimeoutGuard />
                  <AccountTemplateSync />
                  <FreeBusyAutoShare />
                  {children}
                  <PluginDialogHost />
                  <ExternalRecipientConfirmHost />
                  <PhishingReportHost />
                  <CommandPaletteHost />
                  <AccessibilityQuickPanelHost />
                  <PaneCycleHost />
                  <FocusRescueHost />
                  <TotpReauthDialog />
                  <PluginConnectDialog />
                  <QuickRuleHost />
                  <MailTransferHost />
                  <PluginConsentDialog />
                  <PluginOAuthCallbackListener />
                  <PluginAppEvents />
                  <PluginPageNavigator />
                  <PWAInstallPrompt />
                  <AppUpdatePrompt />
                  {/* Offline mode isn't in Lite (no service worker there). */}
                  {!IS_LITE && <OfflineHost />}
                  <DevicePolicyHost />
                  <PushNotificationPrompt />
                  {/* Lite is a static bundle: no server keeps an archive there. */}
                  {!IS_LITE && <AccountArchiveRestorePrompt />}
                </ProtocolLaunchHandlerProvider>
              </TourProvider>
            </EmbeddedBridgeProvider>
          </RateLimitToastProvider>
        </CalendarAlertProvider>
      </ThemeProvider>
    </IntlProvider>
  );
}
