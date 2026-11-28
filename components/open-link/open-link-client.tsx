'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { replaceWindowLocation } from '@/lib/browser-navigation';
import { linkGateToken, requestLinkGate, type LinkGateOutcome } from '@/lib/link-gate';

/**
 * Asks the reader's tab what a message link opens (lib/link-gate.ts) and
 * goes there, replacing this page so Back doesn't land here again. While a
 * link check decides it says so; when nothing may open it says that.
 */
export function OpenLinkClient() {
  const t = useTranslations('link_gate');
  const [outcome, setOutcome] = useState<LinkGateOutcome | null>(null);

  useEffect(() => {
    return requestLinkGate(linkGateToken(window.location.hash), setOutcome);
  }, []);

  useEffect(() => {
    if (outcome?.kind === 'open') replaceWindowLocation(outcome.href);
  }, [outcome]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <p className="w-full max-w-md text-center text-sm text-muted-foreground" role="status" data-link-gate={outcome?.kind ?? 'waiting'}>
        {outcome?.kind === 'not-opened' ? t('not_opened') : outcome?.kind === 'checking' ? t('checking') : ''}
      </p>
    </div>
  );
}
