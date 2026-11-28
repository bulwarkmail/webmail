import type { Metadata } from 'next';
import { OpenLinkClient } from '@/components/open-link/open-link-client';
import { IntlProvider } from '@/components/providers/intl-provider';
import { loadCatalog } from '@/i18n/catalog';
import { IS_LITE } from '@/lib/lite';

// Where a message link lands in a browser that skips the reader frame's
// click listener (lib/email-frame-links.ts, lib/link-gate.ts). Outside
// [locale] like /connector, so proxy.ts keeps next-intl from rewriting it,
// and the token stays in the fragment: the server never sees it.
//
// No referrer: the address this page goes on to must not learn ours, as
// with the frame's own rel="noreferrer" links.
export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default async function OpenLinkRoute() {
  return (
    <IntlProvider locale="en" messages={IS_LITE ? undefined : await loadCatalog('en')}>
      <OpenLinkClient />
    </IntlProvider>
  );
}
