import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { getLocale } from "next-intl/server";
import { PWAInstallPrompt } from "@/components/pwa-install-prompt";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const faviconUrl = process.env.FAVICON_URL;

  return {
    title: process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || "Webmail",
    description: "Minimalist webmail client using JMAP protocol",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || "Webmail",
    },
    formatDetection: {
      telephone: false,
    },
    ...(faviconUrl ? { icons: { icon: faviconUrl } } : {}),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const nonce = (await headers()).get("x-nonce") ?? "";
  const parentOrigin = process.env.NEXT_PUBLIC_PARENT_ORIGIN || "";

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#ffffff" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-title"
          content={process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || "Webmail"}
        />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {parentOrigin && (
          <meta name="parent-origin" content={parentOrigin} />
        )}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  const stored = localStorage.getItem('theme-storage');
                  const theme = stored ? JSON.parse(stored).state.theme : 'system';
                  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                  const resolved = theme === 'system' ? systemTheme : theme;
                  document.documentElement.classList.remove('light', 'dark');
                  document.documentElement.classList.add(resolved);
                } catch (e) {
                  document.documentElement.classList.add('light');
                }
              })();
            `,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ServiceWorkerRegistration />
        {children}
        <PWAInstallPrompt />
      </body>
    </html>
  );
}
